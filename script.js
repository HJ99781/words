/**
 * 동동이 단어공부 v2 — 단어/패턴/문장 + Gemini AI 채점
 */

const STORAGE_KEY = "dongdong-word-study-v2";
const API_KEY_STORAGE = "dongdong-gemini-api-key";
/** 우선 사용 모델 → 404 시 순서대로 대체 시도 */
const GEMINI_MODELS = ["gemini-2.5-flash", "gemini-1.5-flash"];
const MAX_SESSIONS = 100;
const BULK_MAX = 50;

const ITEM_TYPES = {
  word: "단어",
  pattern: "패턴",
  sentence: "문장",
};

const MODE_LABELS = {
  flashcard: "플래시 카드",
  "word-to-meaning": "문제 → 뜻 쓰기",
  "meaning-to-word": "뜻 → 문제 쓰기",
};

/** @type {{ chapters: Chapter[], sessions: StudySession[] }} */
let state = { chapters: [], sessions: [] };

let currentChapterId = null;
let statsFilterChapterId = null;
let editingItemId = null;
let chapterModalMode = "add";
let studySession = null;

// ——— Storage ———

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem("dongdong-word-study-v1");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.chapters) {
        state = migrateState(parsed);
        saveState();
        return;
      }
    }
  } catch (_) {
    /* ignore */
  }
  state = { chapters: [], sessions: [] };
}

function migrateState(parsed) {
  return {
    chapters: parsed.chapters.map((ch) => ({
      id: ch.id,
      name: ch.name,
      wrongNote: Array.isArray(ch.wrongNote) ? ch.wrongNote : [],
      items: (ch.items || ch.words || []).map((it) => ({
        id: it.id,
        type: it.type && ITEM_TYPES[it.type] ? it.type : "word",
        content: (it.content || it.word || "").trim(),
        meaning: (it.meaning || "").trim(),
        correct: it.correct || 0,
        wrong: it.wrong || 0,
      })),
    })),
    sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
  };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function uid() {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ——— API Key ———

function getApiKey() {
  return localStorage.getItem(API_KEY_STORAGE)?.trim() || "";
}

function saveApiKey(key) {
  const trimmed = key.trim();
  if (trimmed) localStorage.setItem(API_KEY_STORAGE, trimmed);
  else localStorage.removeItem(API_KEY_STORAGE);
  updateApiKeyStatus();
}

function updateApiKeyStatus() {
  const el = document.getElementById("api-key-status");
  if (!el) return;
  const has = !!getApiKey();
  el.textContent = has ? "AI 채점 사용 중" : "API 키 미설정";
  el.classList.toggle("api-key-status--on", has);
}

// ——— Gemini ———

function buildGradingPrompt({ mode, content, expectedText, userAnswer }) {
  const accepted = splitAnswers(expectedText);
  const isMeaningMode = mode === "word-to-meaning";

  return `당신은 언어 학습 채점 도우미입니다.
[제시된 정답]과 [사용자 답]을 비교해 채점하세요.

규칙:
- 핵심 의미나 뉘앙스가 맞으면 "정답" (완전히 같은 표현이 아니어도 됨)
- 동의어, 유사 표현, 자연스러운 paraphrase 허용
- 정답이 여러 개일 때 하나의 의미만 맞아도 "정답"
- 의미가 다르거나 핵심이 빠지면 "오답"
- 반드시 아래 JSON만 출력 (다른 텍스트 없음):
{"result":"정답","reason":"한 줄 이유"}
또는
{"result":"오답","reason":"한 줄 이유"}

문제 유형: ${isMeaningMode ? "문제를 보고 뜻 쓰기" : "뜻을 보고 원문 쓰기"}
${isMeaningMode ? "문제(단어/패턴/문장)" : "제시된 뜻"}: ${isMeaningMode ? content : formatAnswersDisplay(expectedText)}
제시된 정답: ${accepted.join(" / ")}
사용자 답: ${userAnswer}`;
}

function parseGeminiGradingResponse(text) {
  const jsonStr = text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
  const parsed = JSON.parse(jsonStr);
  const result = parsed.result === "정답" ? "정답" : "오답";
  return {
    result,
    reason:
      String(parsed.reason || "").trim() ||
      (result === "정답" ? "의미가 맞아요." : "의미가 맞지 않아요."),
  };
}

async function callGeminiModel(model, prompt, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const generationConfig = { temperature: 0.1 };
  if (model.startsWith("gemini-2.")) {
    generationConfig.responseMimeType = "application/json";
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    const err = new Error(`Gemini API 오류 (${res.status}): ${errBody.slice(0, 120)}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!text) {
    const err = new Error("AI 응답이 비어 있습니다.");
    err.status = 502;
    throw err;
  }

  return parseGeminiGradingResponse(text);
}

async function gradeWithGemini({ mode, content, expectedText, userAnswer }) {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  const prompt = buildGradingPrompt({ mode, content, expectedText, userAnswer });
  let lastError = null;

  for (const model of GEMINI_MODELS) {
    try {
      return await callGeminiModel(model, prompt, apiKey);
    } catch (err) {
      lastError = err;
      if (err.status === 404) {
        console.warn(`모델 ${model} 사용 불가(404), 다음 모델 시도`);
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error("사용 가능한 Gemini 모델이 없습니다.");
}

/** 로컬 기본 채점: 완전 일치 또는 정답이 입력에 포함(또는 역포함) */
function checkAnswerLocalFallback(user, expectedText) {
  const accepted = splitAnswers(expectedText);
  if (!accepted.length) return false;
  const u = normalizeAnswer(user);
  if (!u) return false;
  return accepted.some((a) => {
    const na = normalizeAnswer(a);
    if (!na) return false;
    return na === u || u.includes(na) || na.includes(u);
  });
}

function gradeWithLocalFallback(userAnswer, expected) {
  const correct = checkAnswerLocalFallback(userAnswer, expected);
  return {
    correct,
    reason: correct ? "정답과 일치해요." : "오답이에요.",
    usedAi: false,
    fallback: true,
  };
}

async function gradeAnswer({ mode, item, userAnswer }) {
  const expected = mode === "word-to-meaning" ? item.meaning : item.content;

  if (checkAnswerLocal(userAnswer, expected)) {
    return { correct: true, reason: "정답과 일치해요.", usedAi: false, fallback: false };
  }

  if (!getApiKey()) {
    const relaxed = checkAnswerLocalFallback(userAnswer, expected);
    return {
      correct: relaxed,
      reason: relaxed ? "정답과 일치해요." : "오답이에요.",
      usedAi: false,
      fallback: false,
    };
  }

  try {
    const ai = await gradeWithGemini({
      mode,
      content: item.content,
      expectedText: expected,
      userAnswer,
    });
    if (ai) {
      return { correct: ai.result === "정답", reason: ai.reason, usedAi: true, fallback: false };
    }
  } catch (err) {
    console.warn("Gemini 채점 실패, 로컬 기본 채점으로 전환:", err);
    return gradeWithLocalFallback(userAnswer, expected);
  }

  return gradeWithLocalFallback(userAnswer, expected);
}

// ——— Data helpers ———

function getChapter(id) {
  return state.chapters.find((c) => c.id === id);
}

function getCurrentChapter() {
  return currentChapterId ? getChapter(currentChapterId) : null;
}

function getItems(ch) {
  return ch?.items || [];
}

function normalizeAnswer(s) {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

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

function checkAnswerLocal(user, expectedText) {
  const accepted = splitAnswers(expectedText);
  if (!accepted.length) return false;
  const u = normalizeAnswer(user);
  return accepted.some((a) => normalizeAnswer(a) === u);
}

function recordResult(itemRef, isCorrect) {
  if (isCorrect) itemRef.correct += 1;
  else itemRef.wrong += 1;
  saveState();
}

function recordWrongNote(chapterId, itemId) {
  const ch = getChapter(chapterId);
  if (!ch) return;
  if (!ch.wrongNote) ch.wrongNote = [];
  ch.wrongNote = ch.wrongNote.filter((id) => id !== itemId);
  ch.wrongNote.unshift(itemId);
  saveState();
}

function getChapterWrongItems(chapterId) {
  const ch = getChapter(chapterId);
  if (!ch?.wrongNote?.length) return [];
  return ch.wrongNote
    .map((id) => ch.items.find((it) => it.id === id))
    .filter(Boolean);
}

function clearWrongNote(chapterId) {
  const ch = getChapter(chapterId);
  if (!ch) return;
  if (!confirm("이 챕터의 오답 노트를 비울까요?")) return;
  ch.wrongNote = [];
  saveState();
  renderChapter();
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function typeLabel(type) {
  return ITEM_TYPES[type] || ITEM_TYPES.word;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ——— Views ———

function showView(name) {
  document.querySelectorAll(".view").forEach((el) => {
    el.classList.toggle("view--active", el.id === `view-${name}`);
  });
}

// ——— Stats ———

function getItemAttempts(it) {
  return (it.correct || 0) + (it.wrong || 0);
}

function computeStats(chapterFilter = null) {
  let totalItems = 0;
  let studiedItems = 0;
  let correct = 0;
  let wrong = 0;
  const entries = [];

  for (const ch of state.chapters) {
    if (chapterFilter && ch.id !== chapterFilter) continue;
    for (const it of ch.items) {
      totalItems += 1;
      const c = it.correct || 0;
      const w = it.wrong || 0;
      const attempts = c + w;
      correct += c;
      wrong += w;
      if (attempts > 0) {
        studiedItems += 1;
        entries.push({
          chapterId: ch.id,
          chapterName: ch.name,
          item: it,
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
      let chC = 0;
      let chW = 0;
      let chStudied = 0;
      for (const it of ch.items) {
        chC += it.correct || 0;
        chW += it.wrong || 0;
        if (getItemAttempts(it) > 0) chStudied += 1;
      }
      const chT = chC + chW;
      return {
        id: ch.id,
        name: ch.name,
        itemCount: ch.items.length,
        studiedCount: chStudied,
        correct: chC,
        wrong: chW,
        attempts: chT,
        rate: chT ? Math.round((chC / chT) * 100) : null,
        wrongNoteCount: (ch.wrongNote || []).length,
      };
    })
    .filter((ch) => ch.itemCount > 0);

  const byRate = [...entries].sort((a, b) => b.rate - a.rate || b.attempts - a.attempts);
  const byHard = [...entries].sort((a, b) => {
    const dA = a.item.wrong - a.item.correct;
    const dB = b.item.wrong - b.item.correct;
    return dB - dA || b.item.wrong - a.item.wrong;
  });

  const sessions = (state.sessions || [])
    .filter((s) => !chapterFilter || s.chapterId === chapterFilter)
    .sort((a, b) => b.at - a.at)
    .slice(0, 30);

  const sessionCount = (state.sessions || []).filter(
    (s) => !chapterFilter || s.chapterId === chapterFilter
  ).length;

  return {
    totalItems,
    studiedItems,
    correct,
    wrong,
    attempts,
    rate,
    chapters,
    bestItems: byRate.slice(0, 5),
    hardItems: byHard.filter((x) => x.item.wrong > 0).slice(0, 5),
    sessions,
    sessionCount,
  };
}

function recordStudySession(session) {
  if (!state.sessions) state.sessions = [];
  const total = session.correct + session.wrong;
  if (!total) return;
  state.sessions.unshift({
    id: uid(),
    at: Date.now(),
    label: session.label,
    mode: session.mode,
    chapterId: session.chapterId ?? null,
    isReview: !!session.isReview,
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

// ——— Render: Home ———

function renderHome() {
  const list = document.getElementById("chapter-list");
  const empty = document.getElementById("chapter-empty");
  list.innerHTML = "";

  if (!state.chapters.length) {
    empty.classList.remove("empty-msg--hidden");
    renderHomeStatsSummary();
    return;
  }
  empty.classList.add("empty-msg--hidden");

  state.chapters.forEach((ch) => {
    const st = computeStats(ch.id);
    const metaExtra = st.attempts > 0 ? ` · 정답률 ${st.rate}%` : "";
    const wrongN = (ch.wrongNote || []).length;
    const wrongExtra = wrongN > 0 ? ` · 오답 ${wrongN}` : "";
    const li = document.createElement("li");
    li.className = "chapter-item";
    li.innerHTML = `
      <div>
        <span class="chapter-item__name">${escapeHtml(ch.name)}</span>
        <span class="chapter-item__meta">항목 ${ch.items.length}개${metaExtra}${wrongExtra}</span>
      </div>
      <span aria-hidden="true">→</span>
    `;
    li.addEventListener("click", () => openChapter(ch.id));
    list.appendChild(li);
  });

  renderHomeStatsSummary();
}

function renderHomeStatsSummary() {
  const el = document.getElementById("home-stats-summary");
  if (!el) return;
  const s = computeStats();
  if (!s.attempts) {
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

  document.getElementById("stats-summary").innerHTML = `
    <div class="stat-card stat-card--highlight"><span class="stat-card__value">${s.rate}%</span><span class="stat-card__label">전체 정답률</span></div>
    <div class="stat-card"><span class="stat-card__value">${s.attempts}</span><span class="stat-card__label">총 풀이 수</span></div>
    <div class="stat-card"><span class="stat-card__value">${s.correct}</span><span class="stat-card__label">맞힌 수</span></div>
    <div class="stat-card"><span class="stat-card__value">${s.wrong}</span><span class="stat-card__label">틀린 수</span></div>
    <div class="stat-card"><span class="stat-card__value">${s.studiedItems}/${s.totalItems}</span><span class="stat-card__label">공부한 항목</span></div>
    <div class="stat-card"><span class="stat-card__value">${s.sessionCount}</span><span class="stat-card__label">학습 완료 횟수</span></div>
  `;

  const ratioBar = document.getElementById("stats-ratio-bar");
  const ratioText = document.getElementById("stats-ratio-text");
  if (!s.attempts) {
    ratioBar.innerHTML = `<div class="ratio-bar__correct" style="width:0%"></div>`;
    ratioText.textContent = "아직 풀이 기록이 없어요.";
  } else {
    const cp = Math.round((s.correct / s.attempts) * 100);
    ratioBar.innerHTML = `<div class="ratio-bar__correct" style="width:${cp}%"></div><div class="ratio-bar__wrong" style="width:${100 - cp}%"></div>`;
    ratioText.textContent = `정답 ${s.correct}회 (${cp}%) · 오답 ${s.wrong}회 (${100 - cp}%)`;
  }

  const chList = document.getElementById("stats-chapters");
  chList.innerHTML = !s.chapters.length
    ? `<p class="empty-msg">등록된 챕터가 없어요.</p>`
    : s.chapters
        .map((c) => {
          const rs = c.rate !== null ? `${c.rate}%` : "—";
          return `<div class="stats-chapter-row">
            <div class="stats-chapter-row__head"><span class="stats-chapter-row__name">${escapeHtml(c.name)}</span><span class="stats-chapter-row__rate">${rs}</span></div>
            <p class="stats-chapter-row__meta">항목 ${c.itemCount}개 · 오답노트 ${c.wrongNoteCount}개 · ${c.attempts}회 풀이</p>
            <div class="mini-bar"><div class="mini-bar__fill" style="width:${c.rate ?? 0}%"></div></div>
          </div>`;
        })
        .join("");

  document.getElementById("stats-best-words").innerHTML = s.bestItems.length
    ? s.bestItems
        .map(
          (x) => `<li class="stats-word-item"><span class="stats-word-item__word">${escapeHtml(shortText(x.item.content))}</span><span class="stats-word-item__badge">${x.rate}%</span></li>`
        )
        .join("")
    : `<li class="stats-word-item"><span class="stats-caption">기록 없음</span></li>`;

  document.getElementById("stats-hard-words").innerHTML = s.hardItems.length
    ? s.hardItems
        .map(
          (x) => `<li class="stats-word-item"><span class="stats-word-item__word">${escapeHtml(shortText(x.item.content))}</span><span class="stats-word-item__badge stats-word-item__badge--hard">✗${x.item.wrong}</span></li>`
        )
        .join("")
    : `<li class="stats-word-item"><span class="stats-caption">기록 없음</span></li>`;

  const sessList = document.getElementById("stats-sessions");
  const sessEmpty = document.getElementById("stats-sessions-empty");
  if (!s.sessions.length) {
    sessList.innerHTML = "";
    sessEmpty.classList.remove("empty-msg--hidden");
  } else {
    sessEmpty.classList.add("empty-msg--hidden");
    sessList.innerHTML = s.sessions
      .map((sess) => {
        const d = new Date(sess.at).toLocaleDateString("ko-KR", {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
        return `<li class="stats-session-item">
          <span class="stats-session-item__label">${escapeHtml(sess.label)}</span>
          <span class="stats-session-item__date">${d}</span>
          <span class="stats-session-item__score">${sess.rate}%</span>
          <span class="stats-session-item__detail">정답 ${sess.correct} · 오답 ${sess.wrong}</span>
        </li>`;
      })
      .join("");
  }
}

function shortText(s, max = 40) {
  const t = String(s);
  return t.length > max ? t.slice(0, max) + "…" : t;
}

function openStats(chapterId = null) {
  statsFilterChapterId = chapterId;
  renderStats();
  showView("stats");
}

// ——— Chapter ———

function openChapter(id) {
  currentChapterId = id;
  renderChapter();
  showView("chapter");
}

function renderChapter() {
  const ch = getCurrentChapter();
  if (!ch) return;

  document.getElementById("chapter-title").textContent = ch.name;
  const count = ch.items.length;
  document.getElementById("word-count").textContent =
    `항목 ${count}개` + (count > BULK_MAX ? ` (대량 입력 최대 ${BULK_MAX}개)` : "");

  const list = document.getElementById("word-list");
  const empty = document.getElementById("word-empty");
  list.innerHTML = "";

  if (!ch.items.length) {
    empty.classList.remove("empty-msg--hidden");
  } else {
    empty.classList.add("empty-msg--hidden");
    ch.items.forEach((it) => {
      const li = document.createElement("li");
      li.className = "word-item";
      li.innerHTML = `
        <div class="word-item__text">
          <span class="type-badge type-badge--${it.type}">${typeLabel(it.type)}</span>
          <span class="word-item__word">${escapeHtml(shortText(it.content, 80))}</span>
          <span class="word-item__meaning">${escapeHtml(formatAnswersDisplay(it.meaning))}</span>
        </div>
        <span class="word-item__stats">✓${it.correct} ✗${it.wrong}</span>
        <div class="word-item__actions">
          <button type="button" class="icon-btn" data-action="edit" data-id="${it.id}" title="수정">✎</button>
          <button type="button" class="icon-btn icon-btn--delete" data-action="delete" data-id="${it.id}" title="삭제">🗑</button>
        </div>`;
      list.appendChild(li);
    });
  }

  const canStudy = ch.items.length > 0;
  document.querySelectorAll(".study-card[data-source='chapter']").forEach((btn) => {
    btn.disabled = !canStudy;
  });

  renderWrongNoteSection(ch);
}

function renderWrongNoteSection(ch) {
  const wrongItems = getChapterWrongItems(ch.id);
  const list = document.getElementById("wrong-note-list");
  const empty = document.getElementById("wrong-note-empty");
  const clearBtn = document.getElementById("btn-clear-wrong-note");

  list.innerHTML = "";
  if (!wrongItems.length) {
    empty.classList.remove("empty-msg--hidden");
    clearBtn.disabled = true;
  } else {
    empty.classList.add("empty-msg--hidden");
    clearBtn.disabled = false;
    wrongItems.slice(0, 20).forEach((it) => {
      const li = document.createElement("li");
      li.className = "wrong-note-item";
      li.innerHTML = `
        <span class="type-badge type-badge--${it.type}">${typeLabel(it.type)}</span>
        <span class="wrong-note-item__text">${escapeHtml(shortText(it.content, 50))}</span>
        <span class="wrong-note-item__count">✗${it.wrong}</span>`;
      list.appendChild(li);
    });
    if (wrongItems.length > 20) {
      const more = document.createElement("li");
      more.className = "wrong-note-more";
      more.textContent = `외 ${wrongItems.length - 20}개`;
      list.appendChild(more);
    }
  }

  document.querySelectorAll(".study-card[data-source='wrong']").forEach((btn) => {
    btn.disabled = !wrongItems.length;
  });
}

// ——— CRUD ———

function addChapter(name) {
  state.chapters.push({ id: uid(), name: name.trim(), items: [], wrongNote: [] });
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
  if (!confirm("이 챕터와 모든 항목이 삭제됩니다. 계속할까요?")) return;
  state.chapters = state.chapters.filter((c) => c.id !== id);
  saveState();
  currentChapterId = null;
  showView("home");
  renderHome();
}

function createItem(type, content, meaning) {
  return {
    id: uid(),
    type: ITEM_TYPES[type] ? type : "word",
    content: content.trim(),
    meaning: meaning.trim(),
    correct: 0,
    wrong: 0,
  };
}

function addItem(chapterId, type, content, meaning) {
  const ch = getChapter(chapterId);
  if (!ch) return;
  ch.items.push(createItem(type, content, meaning));
  saveState();
  renderChapter();
  renderHome();
}

function updateItem(chapterId, itemId, type, content, meaning) {
  const it = getChapter(chapterId)?.items.find((x) => x.id === itemId);
  if (!it) return;
  it.type = ITEM_TYPES[type] ? type : it.type;
  it.content = content.trim();
  it.meaning = meaning.trim();
  saveState();
  renderChapter();
  renderHome();
}

function deleteItem(chapterId, itemId) {
  const ch = getChapter(chapterId);
  if (!ch || !confirm("이 항목을 삭제할까요?")) return;
  ch.items = ch.items.filter((it) => it.id !== itemId);
  ch.wrongNote = (ch.wrongNote || []).filter((id) => id !== itemId);
  saveState();
  renderChapter();
  renderHome();
}

function parseBulkLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let content = "";
  let meaning = "";

  if (trimmed.includes("\t")) {
    const parts = trimmed.split("\t").map((s) => s.trim());
    content = parts[0] ?? "";
    meaning = parts.slice(1).join("\t").trim();
  } else if (trimmed.includes(",")) {
    const idx = trimmed.indexOf(",");
    content = trimmed.slice(0, idx).trim();
    meaning = trimmed.slice(idx + 1).trim();
  } else if (trimmed.includes("|")) {
    const idx = trimmed.indexOf("|");
    content = trimmed.slice(0, idx).trim();
    meaning = trimmed.slice(idx + 1).trim();
  } else if (trimmed.includes(" - ")) {
    const idx = trimmed.indexOf(" - ");
    content = trimmed.slice(0, idx).trim();
    meaning = trimmed.slice(idx + 3).trim();
  } else return null;

  if (!content || !meaning) return null;
  return { content, meaning };
}

function parseBulkText(text) {
  const lines = text.split(/\r?\n/);
  const pairs = [];
  let skipCount = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const p = parseBulkLine(line);
    if (p) pairs.push(p);
    else skipCount += 1;
  }
  return { pairs, skipCount };
}

function addItemsBulk(chapterId, type, pairs) {
  const ch = getChapter(chapterId);
  if (!ch || !pairs.length) return { added: 0 };
  const limited = pairs.slice(0, BULK_MAX);
  for (const { content, meaning } of limited) {
    ch.items.push(createItem(type, content, meaning));
  }
  saveState();
  renderChapter();
  renderHome();
  return { added: limited.length, truncated: pairs.length > BULK_MAX };
}

function updateBulkPreview() {
  const text = document.getElementById("bulk-textarea").value;
  const { pairs, skipCount } = parseBulkText(text);
  const el = document.getElementById("bulk-preview");
  if (!text.trim()) {
    el.textContent = `0줄 인식됨 (최대 ${BULK_MAX}개)`;
    el.classList.remove("bulk-preview--warn");
    return;
  }
  let msg = `${Math.min(pairs.length, BULK_MAX)}개 등록 가능`;
  if (pairs.length > BULK_MAX) msg += ` · ${pairs.length - BULK_MAX}개는 초과`;
  if (skipCount) msg += ` · ${skipCount}줄 형식 오류`;
  el.textContent = msg;
  el.classList.toggle("bulk-preview--warn", skipCount > 0 || pairs.length > BULK_MAX);
}

// ——— Study ———

function buildDeck(chapterId, itemIds = null) {
  const ch = getChapter(chapterId);
  if (!ch) return [];
  const items = itemIds
    ? itemIds.map((id) => ch.items.find((it) => it.id === id)).filter(Boolean)
    : ch.items;
  return items.map((it) => ({ chapterId: ch.id, item: it }));
}

function startStudy(mode, deck, label, opts = {}) {
  if (!deck.length) {
    alert("공부할 항목이 없습니다.");
    return;
  }

  const chapterIds = [...new Set(deck.map((d) => d.chapterId).filter(Boolean))];
  studySession = {
    mode,
    label: label || MODE_LABELS[mode],
    chapterId: chapterIds.length === 1 ? chapterIds[0] : null,
    isReview: !!opts.isReview,
    deck: shuffle(deck),
    index: 0,
    correct: 0,
    wrong: 0,
    waitingNext: false,
    grading: false,
  };

  document.getElementById("study-mode-label").textContent = studySession.label;
  document.getElementById("study-result").classList.add("study-area--hidden");
  const isFlash = mode === "flashcard";
  document.getElementById("study-flashcard").classList.toggle("study-area--hidden", !isFlash);
  document.getElementById("study-type").classList.toggle("study-area--hidden", isFlash);

  updateStudyProgress();
  showView("study");
  if (isFlash) showFlashcard();
  else showTypeQuestion();
}

function startChapterStudy(mode) {
  const ch = getCurrentChapter();
  if (!ch?.items.length) return;
  startStudy(mode, buildDeck(ch.id), `${ch.name} · ${MODE_LABELS[mode]}`);
}

function startWrongNoteStudy(mode) {
  const ch = getCurrentChapter();
  if (!ch) return;
  const wrong = getChapterWrongItems(ch.id);
  if (!wrong.length) return;
  const deck = wrong.map((it) => ({ chapterId: ch.id, item: it }));
  startStudy(mode, deck, `${ch.name} · 오답 복습 · ${MODE_LABELS[mode]}`, { isReview: true });
}

function getSessionItem() {
  return studySession?.deck[studySession.index];
}

function updateStudyProgress() {
  if (!studySession) return;
  const total = studySession.deck.length;
  const done = studySession.correct + studySession.wrong;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const rate = done ? Math.round((studySession.correct / done) * 100) : 0;

  document.getElementById("study-progress-fill").style.width = `${pct}%`;
  document.getElementById("study-progress-text").textContent = `${done} / ${total}`;
  document.getElementById("achievement-rate").textContent = `${rate}%`;
  document.getElementById("achievement-correct").textContent = String(studySession.correct);
  document.getElementById("achievement-wrong").textContent = String(studySession.wrong);
}

function advanceStudy(wasCorrect) {
  if (!studySession) return;

  const entry = getSessionItem();
  if (entry) {
    recordResult(entry.item, wasCorrect);
    if (!wasCorrect) recordWrongNote(entry.chapterId, entry.item.id);
  }

  if (wasCorrect) studySession.correct += 1;
  else studySession.wrong += 1;

  studySession.index += 1;
  studySession.waitingNext = false;
  studySession.grading = false;
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
    isReview: s.isReview,
    correct: s.correct,
    wrong: s.wrong,
  });

  renderHome();
  if (currentChapterId) renderChapter();
}

function showFlashcard() {
  const entry = getSessionItem();
  if (!entry) return;

  const card = document.getElementById("flashcard");
  card.classList.remove("flashcard--flipped");
  document.getElementById("flashcard-front-label").textContent = typeLabel(entry.item.type);
  document.getElementById("flashcard-back-label").textContent = "뜻";
  document.getElementById("flashcard-front").textContent = entry.item.content;
  document.getElementById("flashcard-back").textContent = formatAnswersDisplay(entry.item.meaning);
}

function toggleFlashcard() {
  document.getElementById("flashcard").classList.toggle("flashcard--flipped");
}

function showFallbackNotice(visible) {
  const el = document.getElementById("grading-fallback-notice");
  if (el) el.hidden = !visible;
}

function resetSubmitButton() {
  const submitBtn = document.getElementById("type-submit-btn");
  if (!submitBtn) return;
  submitBtn.disabled = false;
  submitBtn.textContent = "확인";
}

function showTypeQuestion() {
  const entry = getSessionItem();
  if (!entry || !studySession) return;

  const input = document.getElementById("type-answer");
  const feedback = document.getElementById("type-feedback");
  const submitBtn = document.getElementById("type-submit-btn");
  const nextBtn = document.getElementById("btn-type-next");

  input.value = "";
  input.disabled = false;
  resetSubmitButton();
  showFallbackNotice(false);
  feedback.textContent = "";
  feedback.className = "type-feedback";
  nextBtn.classList.add("btn--hidden");
  studySession.waitingNext = false;
  studySession.grading = false;

  const prompt = document.getElementById("type-prompt");
  if (studySession.mode === "word-to-meaning") {
    prompt.textContent = entry.item.content;
    input.placeholder = "뜻을 입력하세요 (AI가 뉘앙스까지 채점)";
  } else {
    prompt.textContent = formatAnswersDisplay(entry.item.meaning);
    input.placeholder = "단어·패턴·문장을 입력하세요";
  }
  input.focus();
}

async function handleTypeSubmit(e) {
  e.preventDefault();
  if (!studySession || studySession.waitingNext || studySession.grading) return;

  const entry = getSessionItem();
  if (!entry) return;

  const input = document.getElementById("type-answer");
  const feedback = document.getElementById("type-feedback");
  const submitBtn = document.getElementById("type-submit-btn");
  const answer = input.value.trim();
  if (!answer) return;

  studySession.grading = true;
  input.disabled = true;
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = getApiKey() ? "AI 채점 중..." : "채점 중...";
  }
  feedback.textContent = getApiKey() ? "AI 채점 중..." : "채점 중...";
  feedback.className = "type-feedback type-feedback--grading";

  let grade;
  try {
    grade = await gradeAnswer({
      mode: studySession.mode,
      item: entry.item,
      userAnswer: answer,
    });
  } catch (err) {
    console.warn("채점 중 예외, 로컬 기본 채점으로 전환:", err);
    const expected =
      studySession.mode === "word-to-meaning" ? entry.item.meaning : entry.item.content;
    grade = gradeWithLocalFallback(answer, expected);
  }

  studySession.grading = false;
  studySession.waitingNext = true;

  if (grade.fallback) showFallbackNotice(true);

  if (grade.correct) {
    feedback.textContent = `정답! ${grade.reason}${grade.usedAi ? " (AI)" : ""}`;
    feedback.className = "type-feedback type-feedback--ok";
    setTimeout(() => advanceStudy(true), grade.usedAi ? 900 : 600);
  } else {
    const expected =
      studySession.mode === "word-to-meaning"
        ? formatAnswersDisplay(entry.item.meaning)
        : formatAnswersDisplay(entry.item.content);
    feedback.textContent = `오답. ${grade.reason} · 정답: ${expected}`;
    feedback.className = "type-feedback type-feedback--ng";
    document.getElementById("btn-type-next").classList.remove("btn--hidden");
  }
}

// ——— Modals ———

function openChapterModal(mode) {
  chapterModalMode = mode;
  const ch = getCurrentChapter();
  document.getElementById("modal-chapter-title").textContent =
    mode === "rename" ? "챕터 이름 수정" : "챕터 추가";
  document.getElementById("modal-chapter-input").value = mode === "rename" && ch ? ch.name : "";
  document.getElementById("modal-chapter").showModal();
  document.getElementById("modal-chapter-input").focus();
}

function openItemModal(itemId) {
  const it = getCurrentChapter()?.items.find((x) => x.id === itemId);
  if (!it) return;
  editingItemId = itemId;
  document.getElementById("modal-item-type").value = it.type;
  document.getElementById("modal-word-input").value = it.content;
  document.getElementById("modal-meaning-input").value = it.meaning;
  document.getElementById("modal-word").showModal();
}

function openBulkModal() {
  document.getElementById("bulk-textarea").value = "";
  document.getElementById("bulk-item-type").value =
    document.getElementById("input-item-type")?.value || "word";
  updateBulkPreview();
  document.getElementById("modal-bulk").showModal();
  document.getElementById("bulk-textarea").focus();
}

function openSettingsModal() {
  const input = document.getElementById("api-key-input");
  input.value = getApiKey();
  document.getElementById("modal-settings").showModal();
  input.focus();
}

// ——— Events ———

function initEvents() {
  document.getElementById("btn-settings").addEventListener("click", openSettingsModal);

  document.getElementById("settings-form").addEventListener("submit", (e) => {
    e.preventDefault();
    saveApiKey(document.getElementById("api-key-input").value);
    document.getElementById("modal-settings").close();
    alert(getApiKey() ? "API 키가 저장되었습니다." : "API 키가 삭제되었습니다.");
  });

  document.getElementById("modal-settings-cancel").addEventListener("click", () => {
    document.getElementById("modal-settings").close();
  });

  document.getElementById("btn-add-chapter").addEventListener("click", () => {
    currentChapterId = null;
    openChapterModal("add");
  });

  document.getElementById("chapter-modal-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = document.getElementById("modal-chapter-input").value;
    if (!name.trim()) return;
    if (chapterModalMode === "add") addChapter(name);
    else if (currentChapterId) renameChapter(currentChapterId, name);
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

  document.getElementById("btn-rename-chapter").addEventListener("click", () => openChapterModal("rename"));
  document.getElementById("btn-delete-chapter").addEventListener("click", () => {
    if (currentChapterId) deleteChapter(currentChapterId);
  });

  document.getElementById("word-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const type = document.getElementById("input-item-type").value;
    const content = document.getElementById("input-word").value;
    const meaning = document.getElementById("input-meaning").value;
    if (!currentChapterId || !content.trim() || !meaning.trim()) return;
    addItem(currentChapterId, type, content, meaning);
    e.target.reset();
    document.getElementById("input-item-type").value = type;
    document.getElementById("input-word").focus();
  });

  document.getElementById("btn-bulk-paste").addEventListener("click", openBulkModal);
  document.getElementById("bulk-textarea").addEventListener("input", updateBulkPreview);

  document.getElementById("bulk-modal-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!currentChapterId) return;
    const { pairs, skipCount } = parseBulkText(document.getElementById("bulk-textarea").value);
    if (!pairs.length) {
      alert("인식된 항목이 없어요. 「문제, 뜻」 형태로 입력했는지 확인해 주세요.");
      return;
    }
    const type = document.getElementById("bulk-item-type").value;
    const { added, truncated } = addItemsBulk(currentChapterId, type, pairs);
    document.getElementById("modal-bulk").close();
    let msg = `${added}개 항목을 추가했어요!`;
    if (truncated) msg += `\n(최대 ${BULK_MAX}개까지만 등록됩니다)`;
    if (skipCount) msg += `\n${skipCount}줄은 형식 오류로 건너뛰었습니다.`;
    alert(msg);
  });

  document.getElementById("modal-bulk-cancel").addEventListener("click", () => {
    document.getElementById("modal-bulk").close();
  });

  document.getElementById("word-list").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn || !currentChapterId) return;
    if (btn.dataset.action === "edit") openItemModal(btn.dataset.id);
    if (btn.dataset.action === "delete") deleteItem(currentChapterId, btn.dataset.id);
  });

  document.getElementById("word-modal-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!currentChapterId || !editingItemId) return;
    updateItem(
      currentChapterId,
      editingItemId,
      document.getElementById("modal-item-type").value,
      document.getElementById("modal-word-input").value,
      document.getElementById("modal-meaning-input").value
    );
    document.getElementById("modal-word").close();
    editingItemId = null;
  });

  document.getElementById("modal-word-cancel").addEventListener("click", () => {
    document.getElementById("modal-word").close();
  });

  document.querySelectorAll(".study-card[data-source='chapter']").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!btn.disabled) startChapterStudy(btn.dataset.mode);
    });
  });

  document.querySelectorAll(".study-card[data-source='wrong']").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!btn.disabled) startWrongNoteStudy(btn.dataset.mode);
    });
  });

  document.getElementById("btn-clear-wrong-note").addEventListener("click", () => {
    if (currentChapterId) clearWrongNote(currentChapterId);
  });

  document.getElementById("btn-exit-study").addEventListener("click", () => {
    if (studySession?.index < studySession.deck.length) {
      if (!confirm("공부를 중단할까요?")) return;
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
    const { mode, label, deck, isReview } = studySession;
    startStudy(
      mode,
      deck.map((d) => ({ chapterId: d.chapterId, item: d.item })),
      label,
      { isReview }
    );
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

function init() {
  loadState();
  initEvents();
  updateApiKeyStatus();
  renderHome();
  showView("home");
}

init();
