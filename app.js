/**
 * 동동이 단어공부 — 로컬 스토리지 기반 단어 학습 앱
 */

const STORAGE_KEY = "dongdong-word-study-v1";

const MODE_LABELS = {
  flashcard: "플래시 카드",
  "word-to-meaning": "단어 → 뜻 쓰기",
  "meaning-to-word": "뜻 → 단어 쓰기",
};

/** @type {{ chapters: Chapter[], sessions: StudySession[] }} */
let state = { chapters: [], sessions: [] };

/** @typedef {{ id: string, name: string, words: Word[] }} Chapter */
/** @typedef {{ id: string, word: string, meaning: string, correct: number, wrong: number }} Word */
/** @typedef {{ id: string, at: number, label: string, mode: string, chapterId: string|null, correct: number, wrong: number, total: number, rate: number }} StudySession */

const MAX_SESSIONS = 100;

let currentChapterId = null;
let statsFilterChapterId = null;
let editingWordId = null;
let chapterModalMode = "add"; // add | rename

let studySession = null;

// ——— Storage ———

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.chapters)) {
        state = {
          chapters: parsed.chapters,
          sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
        };
        return;
      }
    }
  } catch (_) {
    /* ignore */
  }
  state = { chapters: [], sessions: [] };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function uid() {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ——— Data helpers ———

function getChapter(id) {
  return state.chapters.find((c) => c.id === id);
}

function getCurrentChapter() {
  return currentChapterId ? getChapter(currentChapterId) : null;
}

/** 자주 틀린 단어: wrong >= 2 이고 wrong > correct */
function getWrongWords() {
  const list = [];
  for (const ch of state.chapters) {
    for (const w of ch.words) {
      if (w.wrong >= 2 && w.wrong > w.correct) {
        list.push({ chapterId: ch.id, chapterName: ch.name, word: w });
      }
    }
  }
  return list.sort((a, b) => b.word.wrong - a.word.wrong);
}

function normalizeAnswer(s) {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/** 뜻·단어에 여러 정답이 있을 때 분리 (/, |, ;, 、, 쉼표) */
function splitAnswers(text) {
  const parts = String(text)
    .split(/\s*[|/;、]\s*|\s*,\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  const trimmed = String(text).trim();
  return parts.length > 0 ? parts : trimmed ? [trimmed] : [];
}

function formatAnswersDisplay(text) {
  const parts = splitAnswers(text);
  return parts.length > 0 ? parts.join(" / ") : "";
}

function checkAnswer(user, expectedText) {
  const accepted = splitAnswers(expectedText);
  if (accepted.length === 0) return false;
  const u = normalizeAnswer(user);
  return accepted.some((a) => normalizeAnswer(a) === u);
}

function recordResult(wordRef, isCorrect) {
  if (isCorrect) wordRef.correct += 1;
  else wordRef.wrong += 1;
  saveState();
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ——— Views ———

function showView(name) {
  document.querySelectorAll(".view").forEach((el) => {
    el.classList.toggle("view--active", el.id === `view-${name}`);
  });
}

// ——— Render: Home ———

function renderHome() {
  const list = document.getElementById("chapter-list");
  const empty = document.getElementById("chapter-empty");
  list.innerHTML = "";

  if (state.chapters.length === 0) {
    empty.classList.remove("empty-msg--hidden");
    return;
  }
  empty.classList.add("empty-msg--hidden");

  state.chapters.forEach((ch) => {
    const li = document.createElement("li");
    li.className = "chapter-item";
    li.dataset.id = ch.id;
    const chStats = computeStats(ch.id);
    const metaExtra =
      chStats.attempts > 0 ? ` · 정답률 ${chStats.rate}%` : "";
    li.innerHTML = `
      <div>
        <span class="chapter-item__name">${escapeHtml(ch.name)}</span>
        <span class="chapter-item__meta">단어 ${ch.words.length}개${metaExtra}</span>
      </div>
      <span aria-hidden="true">→</span>
    `;
    li.addEventListener("click", () => openChapter(ch.id));
    list.appendChild(li);
  });

  renderWrongPreview();
  renderHomeStatsSummary();
}

function getWordAttempts(w) {
  return (w.correct || 0) + (w.wrong || 0);
}

/** @param {string|null} chapterFilter */
function computeStats(chapterFilter = null) {
  let totalWords = 0;
  let studiedWords = 0;
  let correct = 0;
  let wrong = 0;

  const wordEntries = [];

  for (const ch of state.chapters) {
    if (chapterFilter && ch.id !== chapterFilter) continue;
    for (const w of ch.words) {
      totalWords += 1;
      const c = w.correct || 0;
      const wg = w.wrong || 0;
      const attempts = c + wg;
      correct += c;
      wrong += wg;
      if (attempts > 0) {
        studiedWords += 1;
        wordEntries.push({
          chapterId: ch.id,
          chapterName: ch.name,
          word: w,
          attempts,
          rate: Math.round((c / attempts) * 100),
        });
      }
    }
  }

  const attempts = correct + wrong;
  const rate = attempts ? Math.round((correct / attempts) * 100) : 0;

  const chapters = state.chapters
    .filter((ch) => !chapterFilter || ch.id === chapterFilter)
    .map((ch) => {
      let chCorrect = 0;
      let chWrong = 0;
      let chStudied = 0;
      for (const w of ch.words) {
        chCorrect += w.correct || 0;
        chWrong += w.wrong || 0;
        if (getWordAttempts(w) > 0) chStudied += 1;
      }
      const chTotal = chCorrect + chWrong;
      return {
        id: ch.id,
        name: ch.name,
        wordCount: ch.words.length,
        studiedCount: chStudied,
        correct: chCorrect,
        wrong: chWrong,
        attempts: chTotal,
        rate: chTotal ? Math.round((chCorrect / chTotal) * 100) : null,
      };
    })
    .filter((ch) => ch.wordCount > 0);

  const byRate = [...wordEntries].sort((a, b) => b.rate - a.rate || b.attempts - a.attempts);
  const byHard = [...wordEntries].sort((a, b) => {
    const diffA = a.word.wrong - a.word.correct;
    const diffB = b.word.wrong - b.word.correct;
    return diffB - diffA || b.word.wrong - a.word.wrong;
  });

  const sessions = (state.sessions || [])
    .filter((s) => !chapterFilter || s.chapterId === chapterFilter)
    .slice()
    .sort((a, b) => b.at - a.at)
    .slice(0, 30);

  const sessionCount = (state.sessions || []).filter(
    (s) => !chapterFilter || s.chapterId === chapterFilter
  ).length;

  return {
    totalWords,
    studiedWords,
    correct,
    wrong,
    attempts,
    rate,
    chapters,
    bestWords: byRate.slice(0, 5),
    hardWords: byHard.filter((x) => x.word.wrong > 0).slice(0, 5),
    sessions,
    sessionCount,
  };
}

function recordStudySession(session) {
  if (!state.sessions) state.sessions = [];
  const total = session.correct + session.wrong;
  if (total === 0) return;

  state.sessions.unshift({
    id: uid(),
    at: Date.now(),
    label: session.label,
    mode: session.mode,
    chapterId: session.chapterId ?? null,
    correct: session.correct,
    wrong: session.wrong,
    total,
    rate: Math.round((session.correct / total) * 100),
  });

  if (state.sessions.length > MAX_SESSIONS) {
    state.sessions = state.sessions.slice(0, MAX_SESSIONS);
  }
  saveState();
}

function renderHomeStatsSummary() {
  const el = document.getElementById("home-stats-summary");
  if (!el) return;
  const s = computeStats();
  if (s.attempts === 0) {
    el.textContent = "공부를 시작하면 결과가 여기에 요약돼요.";
    return;
  }
  el.textContent = `총 ${s.attempts}회 풀이 · 정답률 ${s.rate}% · 학습 ${s.sessionCount}회 완료`;
}

function renderStats() {
  const filterId = statsFilterChapterId;
  const ch = filterId ? getChapter(filterId) : null;
  const s = computeStats(filterId);

  const hint = document.getElementById("stats-filter-hint");
  if (hint) {
    if (ch) {
      hint.textContent = `「${ch.name}」 챕터 통계만 보고 있어요.`;
      hint.hidden = false;
    } else {
      hint.hidden = true;
    }
  }

  const summary = document.getElementById("stats-summary");
  summary.innerHTML = `
    <div class="stat-card stat-card--highlight">
      <span class="stat-card__value">${s.rate}%</span>
      <span class="stat-card__label">전체 정답률</span>
    </div>
    <div class="stat-card">
      <span class="stat-card__value">${s.attempts}</span>
      <span class="stat-card__label">총 풀이 수</span>
    </div>
    <div class="stat-card">
      <span class="stat-card__value">${s.correct}</span>
      <span class="stat-card__label">맞힌 수</span>
    </div>
    <div class="stat-card">
      <span class="stat-card__value">${s.wrong}</span>
      <span class="stat-card__label">틀린 수</span>
    </div>
    <div class="stat-card">
      <span class="stat-card__value">${s.studiedWords}/${s.totalWords}</span>
      <span class="stat-card__label">공부한 단어</span>
    </div>
    <div class="stat-card">
      <span class="stat-card__value">${s.sessionCount}</span>
      <span class="stat-card__label">학습 완료 횟수</span>
    </div>
  `;

  const ratioBar = document.getElementById("stats-ratio-bar");
  const ratioText = document.getElementById("stats-ratio-text");
  if (s.attempts === 0) {
    ratioBar.innerHTML = `<div class="ratio-bar__correct" style="width:0%"></div>`;
    ratioText.textContent = "아직 풀이 기록이 없어요.";
  } else {
    const correctPct = Math.round((s.correct / s.attempts) * 100);
    const wrongPct = 100 - correctPct;
    ratioBar.innerHTML = `
      <div class="ratio-bar__correct" style="width:${correctPct}%"></div>
      <div class="ratio-bar__wrong" style="width:${wrongPct}%"></div>
    `;
    ratioText.textContent = `정답 ${s.correct}회 (${correctPct}%) · 오답 ${s.wrong}회 (${wrongPct}%)`;
  }

  const chList = document.getElementById("stats-chapters");
  if (s.chapters.length === 0) {
    chList.innerHTML = `<p class="empty-msg">등록된 챕터가 없어요.</p>`;
  } else {
    chList.innerHTML = s.chapters
      .map((ch) => {
        const rateStr = ch.rate !== null ? `${ch.rate}%` : "—";
        const barW = ch.rate !== null ? ch.rate : 0;
        return `
          <div class="stats-chapter-row">
            <div class="stats-chapter-row__head">
              <span class="stats-chapter-row__name">${escapeHtml(ch.name)}</span>
              <span class="stats-chapter-row__rate">${rateStr}</span>
            </div>
            <p class="stats-chapter-row__meta">단어 ${ch.wordCount}개 · 공부함 ${ch.studiedCount}개 · ${ch.attempts}회 풀이</p>
            <div class="mini-bar"><div class="mini-bar__fill" style="width:${barW}%"></div></div>
          </div>
        `;
      })
      .join("");
  }

  const bestList = document.getElementById("stats-best-words");
  const hardList = document.getElementById("stats-hard-words");

  if (s.bestWords.length === 0) {
    bestList.innerHTML = `<li class="stats-word-item"><span class="stats-caption">기록 없음</span></li>`;
  } else {
    bestList.innerHTML = s.bestWords
      .map(
        (x) => `
      <li class="stats-word-item">
        <span class="stats-word-item__word">${escapeHtml(x.word.word)}</span>
        <span class="stats-word-item__badge">${x.rate}% · ${x.attempts}회</span>
      </li>`
      )
      .join("");
  }

  if (s.hardWords.length === 0) {
    hardList.innerHTML = `<li class="stats-word-item"><span class="stats-caption">기록 없음</span></li>`;
  } else {
    hardList.innerHTML = s.hardWords
      .map(
        (x) => `
      <li class="stats-word-item">
        <span class="stats-word-item__word">${escapeHtml(x.word.word)}</span>
        <span class="stats-word-item__badge stats-word-item__badge--hard">✗${x.word.wrong} ✓${x.word.correct}</span>
      </li>`
      )
      .join("");
  }

  const sessList = document.getElementById("stats-sessions");
  const sessEmpty = document.getElementById("stats-sessions-empty");
  if (s.sessions.length === 0) {
    sessList.innerHTML = "";
    sessEmpty.classList.remove("empty-msg--hidden");
  } else {
    sessEmpty.classList.add("empty-msg--hidden");
    sessList.innerHTML = s.sessions
      .map((sess) => {
        const date = new Date(sess.at);
        const dateStr = date.toLocaleDateString("ko-KR", {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
        return `
          <li class="stats-session-item">
            <span class="stats-session-item__label">${escapeHtml(sess.label)}</span>
            <span class="stats-session-item__date">${dateStr}</span>
            <span class="stats-session-item__score">${sess.rate}%</span>
            <span class="stats-session-item__detail">정답 ${sess.correct} · 오답 ${sess.wrong} · ${sess.total}문제</span>
          </li>
        `;
      })
      .join("");
  }
}

function openStats(chapterId = null) {
  statsFilterChapterId = chapterId;
  renderStats();
  showView("stats");
}

function renderWrongPreview() {
  const wrong = getWrongWords();
  const preview = document.getElementById("wrong-words-preview");
  const btn = document.getElementById("btn-review-wrong");

  if (wrong.length === 0) {
    preview.textContent = "아직 자주 틀린 단어가 없어요. 공부를 시작해 보세요!";
    btn.disabled = true;
    return;
  }

  const tags = wrong
    .slice(0, 12)
    .map((x) => `<span class="wrong-tag">${escapeHtml(x.word.word)} (${x.word.wrong}회)</span>`)
    .join("");
  const more = wrong.length > 12 ? ` 외 ${wrong.length - 12}개` : "";
  preview.innerHTML = `${tags}${more ? `<span>${more}</span>` : ""}`;
  btn.disabled = false;
}

// ——— Render: Chapter ———

function openChapter(id) {
  currentChapterId = id;
  renderChapter();
  showView("chapter");
}

function renderChapter() {
  const ch = getCurrentChapter();
  if (!ch) return;

  document.getElementById("chapter-title").textContent = ch.name;
  const count = ch.words.length;
  document.getElementById("word-count").textContent =
    `단어 ${count}개` + (count < 30 ? " (30~50개 권장)" : count > 50 ? " (50개 초과)" : "");

  const list = document.getElementById("word-list");
  const empty = document.getElementById("word-empty");
  list.innerHTML = "";

  if (ch.words.length === 0) {
    empty.classList.remove("empty-msg--hidden");
  } else {
    empty.classList.add("empty-msg--hidden");
    ch.words.forEach((w) => {
      const li = document.createElement("li");
      li.className = "word-item";
      li.innerHTML = `
        <div class="word-item__text">
          <span class="word-item__word">${escapeHtml(w.word)}</span>
          <span class="word-item__meaning">${escapeHtml(formatAnswersDisplay(w.meaning))}</span>
        </div>
        <span class="word-item__stats">✓${w.correct} ✗${w.wrong}</span>
        <div class="word-item__actions">
          <button type="button" class="icon-btn" data-action="edit" data-id="${w.id}" title="수정">✎</button>
          <button type="button" class="icon-btn icon-btn--delete" data-action="delete" data-id="${w.id}" title="삭제">🗑</button>
        </div>
      `;
      list.appendChild(li);
    });
  }

  const canStudy = ch.words.length > 0;
  document.querySelectorAll(".study-card").forEach((btn) => {
    btn.disabled = !canStudy;
  });
}

// ——— Chapter CRUD ———

function addChapter(name) {
  state.chapters.push({
    id: uid(),
    name: name.trim(),
    words: [],
  });
  saveState();
  renderHome();
}

function renameChapter(id, name) {
  const ch = getChapter(id);
  if (ch) {
    ch.name = name.trim();
    saveState();
    renderChapter();
    renderHome();
  }
}

function deleteChapter(id) {
  if (!confirm("이 챕터와 모든 단어가 삭제됩니다. 계속할까요?")) return;
  state.chapters = state.chapters.filter((c) => c.id !== id);
  saveState();
  currentChapterId = null;
  showView("home");
  renderHome();
}

// ——— Word CRUD ———

function createWordEntry(word, meaning) {
  return {
    id: uid(),
    word: word.trim(),
    meaning: meaning.trim(),
    correct: 0,
    wrong: 0,
  };
}

function addWord(chapterId, word, meaning) {
  const ch = getChapter(chapterId);
  if (!ch) return;
  ch.words.push(createWordEntry(word, meaning));
  saveState();
  renderChapter();
  renderHome();
}

/** 한 줄에서 단어·뜻 분리 (쉼표, 탭, |, " - " 지원) */
function parseBulkLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let word = "";
  let meaning = "";

  if (trimmed.includes("\t")) {
    const parts = trimmed.split("\t").map((s) => s.trim());
    word = parts[0] ?? "";
    meaning = parts.slice(1).join("\t").trim();
  } else if (trimmed.includes(",")) {
    const idx = trimmed.indexOf(",");
    word = trimmed.slice(0, idx).trim();
    meaning = trimmed.slice(idx + 1).trim();
  } else if (trimmed.includes("|")) {
    const idx = trimmed.indexOf("|");
    word = trimmed.slice(0, idx).trim();
    meaning = trimmed.slice(idx + 1).trim();
  } else if (trimmed.includes(" - ")) {
    const idx = trimmed.indexOf(" - ");
    word = trimmed.slice(0, idx).trim();
    meaning = trimmed.slice(idx + 3).trim();
  } else {
    return null;
  }

  if (!word || !meaning) return null;
  return { word, meaning };
}

/** 붙여넣기 텍스트 → { pairs, skipCount } */
function parseBulkText(text) {
  const lines = text.split(/\r?\n/);
  const pairs = [];
  let skipCount = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    const parsed = parseBulkLine(line);
    if (parsed) pairs.push(parsed);
    else skipCount += 1;
  }

  return { pairs, skipCount };
}

function addWordsBulk(chapterId, pairs) {
  const ch = getChapter(chapterId);
  if (!ch || pairs.length === 0) return { added: 0, skipped: 0 };

  for (const { word, meaning } of pairs) {
    ch.words.push(createWordEntry(word, meaning));
  }
  saveState();
  renderChapter();
  renderHome();
  return { added: pairs.length, skipped: 0 };
}

function updateBulkPreview() {
  const text = document.getElementById("bulk-textarea").value;
  const { pairs, skipCount } = parseBulkText(text);
  const el = document.getElementById("bulk-preview");

  if (!text.trim()) {
    el.textContent = "0줄 인식됨";
    el.classList.remove("bulk-preview--warn");
    return;
  }

  let msg = `${pairs.length}개 단어 인식됨`;
  if (skipCount > 0) {
    msg += ` · ${skipCount}줄은 형식이 맞지 않음`;
    el.classList.add("bulk-preview--warn");
  } else {
    el.classList.remove("bulk-preview--warn");
  }
  el.textContent = msg;
}

function openBulkModal() {
  const dialog = document.getElementById("modal-bulk");
  document.getElementById("bulk-textarea").value = "";
  updateBulkPreview();
  dialog.showModal();
  document.getElementById("bulk-textarea").focus();
}

function updateWord(chapterId, wordId, word, meaning) {
  const ch = getChapter(chapterId);
  const w = ch?.words.find((x) => x.id === wordId);
  if (w) {
    w.word = word.trim();
    w.meaning = meaning.trim();
    saveState();
    renderChapter();
    renderHome();
  }
}

function deleteWord(chapterId, wordId) {
  const ch = getChapter(chapterId);
  if (!ch) return;
  if (!confirm("이 단어를 삭제할까요?")) return;
  ch.words = ch.words.filter((w) => w.id !== wordId);
  saveState();
  renderChapter();
  renderHome();
}

// ——— Study session ———

/**
 * @param {string} mode
 * @param {Array<{ chapterId: string, word: Word }>} deck
 * @param {string} [label]
 */
function startStudy(mode, deck, label) {
  if (deck.length === 0) {
    alert("공부할 단어가 없습니다.");
    return;
  }

  const chapterIds = [...new Set(deck.map((d) => d.chapterId).filter(Boolean))];
  studySession = {
    mode,
    label: label || MODE_LABELS[mode] || mode,
    chapterId: chapterIds.length === 1 ? chapterIds[0] : null,
    deck: shuffle(deck),
    index: 0,
    correct: 0,
    wrong: 0,
    waitingNext: false,
  };

  document.getElementById("study-mode-label").textContent = studySession.label;
  document.getElementById("study-result").classList.add("study-area--hidden");
  document.getElementById("study-flashcard").classList.remove("study-area--hidden");
  document.getElementById("study-type").classList.add("study-area--hidden");

  const isFlash = mode === "flashcard";
  document.getElementById("study-flashcard").classList.toggle("study-area--hidden", !isFlash);
  document.getElementById("study-type").classList.toggle("study-area--hidden", isFlash);

  updateStudyProgress();
  showView("study");

  if (isFlash) showFlashcard();
  else showTypeQuestion();
}

function getSessionItem() {
  return studySession?.deck[studySession.index];
}

function updateStudyProgress() {
  if (!studySession) return;
  const total = studySession.deck.length;
  const done = studySession.correct + studySession.wrong;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const rate =
    studySession.correct + studySession.wrong > 0
      ? Math.round((studySession.correct / (studySession.correct + studySession.wrong)) * 100)
      : 0;

  document.getElementById("study-progress-fill").style.width = `${pct}%`;
  document.getElementById("study-progress-text").textContent = `${done} / ${total}`;
  document.getElementById("achievement-rate").textContent = `${rate}%`;
  document.getElementById("achievement-correct").textContent = String(studySession.correct);
  document.getElementById("achievement-wrong").textContent = String(studySession.wrong);
}

function advanceStudy(wasCorrect) {
  if (!studySession) return;

  const item = getSessionItem();
  if (item) recordResult(item.word, wasCorrect);

  if (wasCorrect) studySession.correct += 1;
  else studySession.wrong += 1;

  studySession.index += 1;
  studySession.waitingNext = false;

  updateStudyProgress();

  if (studySession.index >= studySession.deck.length) {
    finishStudy();
    return;
  }

  if (studySession.mode === "flashcard") showFlashcard();
  else showTypeQuestion();
}

function finishStudy() {
  const s = studySession;
  const total = s.correct + s.wrong;
  const rate = total ? Math.round((s.correct / total) * 100) : 0;

  document.getElementById("study-flashcard").classList.add("study-area--hidden");
  document.getElementById("study-type").classList.add("study-area--hidden");
  document.getElementById("study-result").classList.remove("study-area--hidden");

  document.getElementById("result-summary").textContent = `${s.label} — ${total}문제 완료`;
  document.getElementById("result-rate").textContent = `${rate}%`;
  document.getElementById("result-correct").textContent = String(s.correct);
  document.getElementById("result-wrong").textContent = String(s.wrong);

  recordStudySession({
    label: s.label,
    mode: s.mode,
    chapterId: s.chapterId,
    correct: s.correct,
    wrong: s.wrong,
  });

  renderHome();
  if (currentChapterId) renderChapter();
}

// Flashcard
function showFlashcard() {
  const item = getSessionItem();
  if (!item) return;

  const card = document.getElementById("flashcard");
  card.classList.remove("flashcard--flipped");
  document.getElementById("flashcard-front").textContent = item.word.word;
  document.getElementById("flashcard-back").textContent = formatAnswersDisplay(item.word.meaning);
}

function toggleFlashcard() {
  document.getElementById("flashcard").classList.toggle("flashcard--flipped");
}

// Type modes
function showTypeQuestion() {
  const item = getSessionItem();
  if (!item || !studySession) return;

  const form = document.getElementById("type-form");
  const input = document.getElementById("type-answer");
  const feedback = document.getElementById("type-feedback");
  const nextBtn = document.getElementById("btn-type-next");

  form.classList.remove("study-area--hidden");
  input.value = "";
  input.disabled = false;
  feedback.textContent = "";
  feedback.className = "type-feedback";
  nextBtn.classList.add("btn--hidden");
  studySession.waitingNext = false;

  const prompt = document.getElementById("type-prompt");
  if (studySession.mode === "word-to-meaning") {
    prompt.textContent = item.word.word;
    input.placeholder = "뜻을 입력하세요 (여러 정답 중 하나)";
  } else {
    prompt.textContent = formatAnswersDisplay(item.word.meaning);
    input.placeholder = "단어를 입력하세요 (여러 정답 중 하나)";
  }

  input.focus();
}

function handleTypeSubmit(e) {
  e.preventDefault();
  if (!studySession || studySession.waitingNext) return;

  const item = getSessionItem();
  if (!item) return;

  const input = document.getElementById("type-answer");
  const feedback = document.getElementById("type-feedback");
  const expected =
    studySession.mode === "word-to-meaning" ? item.word.meaning : item.word.word;
  const ok = checkAnswer(input.value, expected);

  input.disabled = true;
  studySession.waitingNext = true;

  if (ok) {
    feedback.textContent = "정답이에요! 🎉";
    feedback.className = "type-feedback type-feedback--ok";
    setTimeout(() => advanceStudy(true), 600);
  } else {
    feedback.textContent = `오답이에요. 정답: ${formatAnswersDisplay(expected)}`;
    feedback.className = "type-feedback type-feedback--ng";
    document.getElementById("btn-type-next").classList.remove("btn--hidden");
  }
}

function startChapterStudy(mode) {
  const ch = getCurrentChapter();
  if (!ch || ch.words.length === 0) return;
  const deck = ch.words.map((w) => ({ chapterId: ch.id, word: w }));
  startStudy(mode, deck, `${ch.name} · ${MODE_LABELS[mode]}`);
}

function startWrongReview() {
  const wrong = getWrongWords();
  if (wrong.length === 0) return;

  const mode = "flashcard";
  startStudy(mode, wrong, "자주 틀린 단어 복습 · 플래시 카드");
}

// ——— Utils ———

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ——— Modals ———

function openChapterModal(mode) {
  chapterModalMode = mode;
  const dialog = document.getElementById("modal-chapter");
  const title = document.getElementById("modal-chapter-title");
  const input = document.getElementById("modal-chapter-input");
  const ch = getCurrentChapter();

  if (mode === "rename" && ch) {
    title.textContent = "챕터 이름 수정";
    input.value = ch.name;
  } else {
    title.textContent = "챕터 추가";
    input.value = "";
  }
  dialog.showModal();
  input.focus();
}

function openWordModal(wordId) {
  const ch = getCurrentChapter();
  const w = ch?.words.find((x) => x.id === wordId);
  if (!w) return;
  editingWordId = wordId;
  document.getElementById("modal-word-input").value = w.word;
  document.getElementById("modal-meaning-input").value = w.meaning;
  document.getElementById("modal-word").showModal();
}

// ——— Event bindings ———

function initEvents() {
  document.getElementById("btn-add-chapter").addEventListener("click", () => {
    currentChapterId = null;
    openChapterModal("add");
  });

  document.getElementById("chapter-modal-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = document.getElementById("modal-chapter-input").value;
    if (!name.trim()) return;

    if (chapterModalMode === "add") {
      addChapter(name);
    } else if (currentChapterId) {
      renameChapter(currentChapterId, name);
    }
    document.getElementById("modal-chapter").close();
  });

  document.getElementById("modal-chapter-cancel").addEventListener("click", () => {
    document.getElementById("modal-chapter").close();
  });

  document.getElementById("btn-back-home").addEventListener("click", () => {
    currentChapterId = null;
    showView("home");
    renderHome();
  });

  document.getElementById("btn-rename-chapter").addEventListener("click", () => {
    openChapterModal("rename");
  });

  document.getElementById("btn-delete-chapter").addEventListener("click", () => {
    if (currentChapterId) deleteChapter(currentChapterId);
  });

  document.getElementById("word-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const word = document.getElementById("input-word").value;
    const meaning = document.getElementById("input-meaning").value;
    if (!currentChapterId || !word.trim() || !meaning.trim()) return;
    addWord(currentChapterId, word, meaning);
    e.target.reset();
    document.getElementById("input-word").focus();
  });

  document.getElementById("btn-bulk-paste").addEventListener("click", openBulkModal);

  document.getElementById("bulk-textarea").addEventListener("input", updateBulkPreview);

  document.getElementById("bulk-modal-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!currentChapterId) return;

    const text = document.getElementById("bulk-textarea").value;
    const { pairs, skipCount } = parseBulkText(text);

    if (pairs.length === 0) {
      alert(
        skipCount > 0
          ? "인식된 단어가 없어요.\n한 줄에 「단어, 뜻」 형태로 입력했는지 확인해 주세요."
          : "붙여넣을 내용을 입력해 주세요."
      );
      return;
    }

    const { added } = addWordsBulk(currentChapterId, pairs);
    document.getElementById("modal-bulk").close();

    let msg = `${added}개 단어를 추가했어요!`;
    if (skipCount > 0) {
      msg += `\n(${skipCount}줄은 형식이 맞지 않아 건너뛰었습니다)`;
    }
    alert(msg);
  });

  document.getElementById("modal-bulk-cancel").addEventListener("click", () => {
    document.getElementById("modal-bulk").close();
  });

  document.getElementById("word-list").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn || !currentChapterId) return;
    const id = btn.dataset.id;
    if (btn.dataset.action === "edit") openWordModal(id);
    if (btn.dataset.action === "delete") deleteWord(currentChapterId, id);
  });

  document.getElementById("word-modal-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!currentChapterId || !editingWordId) return;
    updateWord(
      currentChapterId,
      editingWordId,
      document.getElementById("modal-word-input").value,
      document.getElementById("modal-meaning-input").value
    );
    document.getElementById("modal-word").close();
    editingWordId = null;
  });

  document.getElementById("modal-word-cancel").addEventListener("click", () => {
    document.getElementById("modal-word").close();
  });

  document.querySelectorAll(".study-card").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!btn.disabled) startChapterStudy(btn.dataset.mode);
    });
  });

  document.getElementById("btn-review-wrong").addEventListener("click", startWrongReview);

  document.getElementById("btn-exit-study").addEventListener("click", () => {
    if (studySession && studySession.index < studySession.deck.length) {
      if (!confirm("공부를 중단할까요? 진행 상황은 저장된 통계에 반영됩니다.")) return;
    }
    studySession = null;
    if (currentChapterId) {
      showView("chapter");
      renderChapter();
    } else {
      showView("home");
      renderHome();
    }
  });

  document.getElementById("flashcard").addEventListener("click", toggleFlashcard);
  document.getElementById("flashcard").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleFlashcard();
    }
  });

  document.getElementById("btn-flash-correct").addEventListener("click", () => advanceStudy(true));
  document.getElementById("btn-flash-wrong").addEventListener("click", () => advanceStudy(false));

  document.getElementById("type-form").addEventListener("submit", handleTypeSubmit);

  document.getElementById("btn-type-next").addEventListener("click", () => {
    if (studySession?.waitingNext) advanceStudy(false);
  });

  document.getElementById("btn-study-again").addEventListener("click", () => {
    if (!studySession) return;
    const { mode, label, deck } = studySession;
    const items = deck.map((d) => ({ chapterId: d.chapterId, word: d.word }));
    startStudy(mode, items, label);
  });

  document.getElementById("btn-result-home").addEventListener("click", () => {
    studySession = null;
    showView("home");
    renderHome();
  });

  document.getElementById("btn-open-stats").addEventListener("click", () => openStats(null));
  document.getElementById("btn-stats-back").addEventListener("click", () => {
    statsFilterChapterId = null;
    showView("home");
    renderHome();
  });
  document.getElementById("btn-chapter-stats").addEventListener("click", () => {
    if (currentChapterId) openStats(currentChapterId);
  });
  document.getElementById("btn-result-stats").addEventListener("click", () => {
    const chapterId = studySession?.chapterId ?? currentChapterId;
    studySession = null;
    openStats(chapterId);
  });
}

// ——— Boot ———

function init() {
  loadState();
  initEvents();
  renderHome();
  showView("home");
}

init();
