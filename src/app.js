/* ============================================================================
 * C1 驾照 · 科目一 —— 应用逻辑
 *
 * 三种模式：
 *   刷题练习 —— SM-2 间隔重复智能抽题（到期复习 + 新题），即时判定
 *   模拟考试 —— 判断40 + 单选60，限时45分钟，交卷统一评定
 *   错题重练 —— 只练「错题本」中的题
 *
 * 存储（localStorage）：
 *   kemuyi_sm2   —— SM-2 复习卡片  {qid: {ease, interval, reps, due, last}}
 *   kemuyi_wrong —— 错题本         {qid: {a: 最近答错时间, w: 累计答错次数}}
 *   kemuyi_stats —— 统计           {totalAnswered, totalCorrect, examHistory,
 *                                   lastStudyDay, studyDays}
 *
 * 关键设计：SM-2 复习队列 ≠ 错题本。
 *   · 刷题答对的题只进入 SM-2 复习队列（用于刷题模式智能抽题），绝不进错题本
 *   · 任何模式答错（含模考未答）→ 收录进错题本
 *   · 任何模式答对 → 立即移出错题本
 * ==========================================================================*/
(function () {
"use strict";

/* ============================== 题库与常量 ============================== */
var BANK = window.__BANK__;
var BANK_BY_ID = {};
BANK.forEach(function (q) { BANK_BY_ID[q.id] = q; });

var CATS = ["law", "signal", "safety", "operation", "case"];
var DAY_MS = 86400000;
var EASE_MIN = 1.3;   // SM-2 难度系数下限
var EASE_MAX = 3.0;   // SM-2 难度系数上限（防止间隔爆炸）
var EASE_INIT = 2.5;
var PAPER_SIZE = 100; // 刷题/错题模式每轮题量

/* ============================== 工具 ============================== */
function $(id) { return document.getElementById(id); }

function shuffle(arr) {
  var a = arr.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function escapeHtml(s) {
  return (s == null ? "" : String(s)).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

// 图片 URL：http 升级为 https，避免 HTTPS 页面下的 Mixed Content 警告
function imgUrl(u) { return u ? String(u).replace(/^http:\/\//i, "https://") : ""; }

function pad2(n) { return (n < 10 ? "0" : "") + n; }

function show(id) {
  ["page-cover", "page-exam", "page-result"].forEach(function (p) {
    $(p).classList.toggle("hidden", p !== id);
  });
  window.scrollTo(0, 0);
}

function todayStr() {
  var d = new Date();
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

/* ============================== 持久化层 ============================== */
var LS_SM2 = "kemuyi_sm2";
var LS_WRONG = "kemuyi_wrong";
var LS_STATS = "kemuyi_stats";

function loadJSON(key, fallback) {
  try {
    var v = JSON.parse(localStorage.getItem(key));
    return v == null ? fallback : v;
  } catch (e) { return fallback; }
}
function saveJSON(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* 存储满等异常静默 */ }
}

function loadSm2() { return loadJSON(LS_SM2, {}); }
function saveSm2(s) { saveJSON(LS_SM2, s); }

function loadWrong() { return loadJSON(LS_WRONG, {}); }
function saveWrong(w) { saveJSON(LS_WRONG, w); }

function defaultStats() {
  return { totalAnswered: 0, totalCorrect: 0, examHistory: [], lastStudyDay: "", studyDays: {} };
}
function loadStats() {
  var s = loadJSON(LS_STATS, null);
  if (!s) return defaultStats();
  if (!s.examHistory) s.examHistory = [];
  if (!s.studyDays) s.studyDays = {};
  return s;
}
function saveStats(s) { saveJSON(LS_STATS, s); }

/* 老版本数据迁移（仅执行一次）：
 * 旧版没有独立错题本，把"最近一次作答为答错"的 SM-2 卡迁入错题本。
 * 判定依据：reps===0（答错会清零连续答对次数）且 ease 低于初始值 2.5（只有答错会降 ease）。*/
function migrateWrongBook() {
  if (localStorage.getItem(LS_WRONG) !== null) return;
  var sm2 = loadSm2();
  var wrong = {};
  Object.keys(sm2).forEach(function (id) {
    var c = sm2[id];
    if (c && c.reps === 0 && c.ease < EASE_INIT - 0.01) {
      wrong[id] = { a: c.last || Date.now(), w: 1 };
    }
  });
  saveWrong(wrong);
}

/* ============================== SM-2 算法 ============================== */
function sm2New() {
  return { ease: EASE_INIT, interval: 0, reps: 0, due: 0, last: 0 };
}

// 答题后更新卡片：quality=1 答对 / 0 答错
function sm2Update(card, quality, now) {
  now = now || Date.now();
  if (quality >= 1) {
    card.reps += 1;
    if (card.reps === 1) card.interval = 1;
    else if (card.reps === 2) card.interval = 3;
    else card.interval = Math.round(card.interval * card.ease);
    card.ease = Math.min(EASE_MAX, card.ease + 0.1);
  } else {
    card.reps = 0;
    card.interval = 1;
    card.ease = Math.max(EASE_MIN, card.ease - 0.2);
  }
  card.last = now;
  card.due = now + card.interval * DAY_MS;
  return card;
}

// 是否到期（今日该复习）：到期时间在"明天0点"之前
function sm2IsDue(card, now) {
  if (!card || !card.due) return false;
  now = now || Date.now();
  var d = new Date(now);
  var tomorrow0 = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  return card.due <= tomorrow0;
}

// 是否已掌握：连续答对≥3次 且 间隔≥7天
function sm2IsMastered(card) {
  return card.reps >= 3 && card.interval >= 7;
}

/* ============================== 错题本 ============================== */
function _wrongAddTo(wrong, qid, now) {
  var e = wrong[qid] || { a: 0, w: 0 };
  e.a = now;
  e.w += 1;
  wrong[qid] = e;
}
function wrongAdd(qid) {
  var wrong = loadWrong();
  _wrongAddTo(wrong, qid, Date.now());
  saveWrong(wrong);
}
function wrongRemove(qid) {
  var wrong = loadWrong();
  if (qid in wrong) { delete wrong[qid]; saveWrong(wrong); }
}
function wrongCount() { return Object.keys(loadWrong()).length; }

/* 统一作答记录（刷题/错题模式）：更新 SM-2（无卡则建卡）+ 错题本 + 计数 */
function recordPracticeAnswer(qid, isRight) {
  var sm2 = loadSm2();
  var card = sm2[qid] || sm2New();
  sm2Update(card, isRight ? 1 : 0);
  sm2[qid] = card;
  saveSm2(sm2);

  if (isRight) wrongRemove(qid); else wrongAdd(qid);

  var stats = loadStats();
  stats.totalAnswered += 1;
  if (isRight) stats.totalCorrect += 1;
  saveStats(stats);
}

/* 模考交卷统一记录（批量，避免逐题读写 localStorage）：
 *   答对 → 已有 SM-2 卡的推进复习；移出错题本
 *   答错/未答 → 进错题本 + SM-2 置为待复习（与真实考试一致：未答算错）
 * 返回 {right, wrongIdx[]} */
function gradeExamAndRecord(paper, answers) {
  var sm2 = loadSm2();
  var wrong = loadWrong();
  var now = Date.now();
  var right = 0;
  var wrongIdx = [];

  paper.forEach(function (q, i) {
    var isRight = answers[i] === q.answer;
    if (isRight) {
      right += 1;
      if (sm2[q.id]) sm2Update(sm2[q.id], 1, now);
      if (q.id in wrong) delete wrong[q.id];
    } else {
      wrongIdx.push(i);
      var card = sm2[q.id] || sm2New();
      sm2Update(card, 0, now);
      sm2[q.id] = card;
      _wrongAddTo(wrong, q.id, now);
    }
  });

  saveSm2(sm2);
  saveWrong(wrong);
  return { right: right, wrongIdx: wrongIdx };
}

/* ============================== 抽题 ============================== */
/* 刷题模式：SM-2 智能抽题（到期优先 + 新题补充） */
function buildPracticePaper(size) {
  size = size || PAPER_SIZE;
  var now = Date.now();
  var sm2 = loadSm2();

  var duePool = [], learnedPool = [], newPool = [];
  Object.keys(sm2).forEach(function (id) {
    var c = sm2[id];
    if (!c || !BANK_BY_ID[id]) return;
    if (sm2IsDue(c, now)) duePool.push(id);
    else learnedPool.push(id);
  });
  BANK.forEach(function (q) { if (!sm2[q.id]) newPool.push(q.id); });

  duePool = shuffle(duePool);
  learnedPool = shuffle(learnedPool);
  newPool = shuffle(newPool);

  var picked = [];
  var used = {};
  function take(pool, n) {
    for (var k = 0; k < pool.length && n > 0; k++) {
      if (used[pool[k]]) continue;
      used[pool[k]] = 1;
      picked.push(pool[k]);
      n--;
    }
  }
  // 到期题最多占 70%，其余新题；不足时互相补足
  take(duePool, Math.round(size * 0.7));
  take(newPool, size - picked.length);
  if (picked.length < size) take(learnedPool, size - picked.length);
  if (picked.length < size) take(duePool, size - picked.length);
  if (picked.length < size) take(newPool, size - picked.length);

  return shuffle(picked.map(function (id) { return BANK_BY_ID[id]; }));
}

/* 错题重练：只出错题本中的题（SM-2 今日到期的优先） */
function buildWrongPaper(size) {
  size = size || PAPER_SIZE;
  var now = Date.now();
  var sm2 = loadSm2();
  var wrong = loadWrong();

  var due = [], rest = [];
  Object.keys(wrong).forEach(function (id) {
    if (!BANK_BY_ID[id]) return;
    if (sm2IsDue(sm2[id], now)) due.push(id);
    else rest.push(id);
  });

  var ordered = shuffle(due).concat(shuffle(rest)).slice(0, size);
  return ordered.map(function (id) { return BANK_BY_ID[id]; });
}

/* 模拟考试：章节分层抽样（纯随机，不用 SM-2） */
var _byType = { judge: [], single: [] };
BANK.forEach(function (q) { if (_byType[q.type]) _byType[q.type].push(q); });

function buildExamPaper() {
  var quota = {
    judge:  { law: 12, signal: 10, safety: 8, operation: 6, case: 4 },  // 40
    single: { law: 18, signal: 15, safety: 12, operation: 9, case: 6 }  // 60
  };
  var paper = [], used = {};

  function pick(pool, n) {
    var avail = shuffle(pool.filter(function (q) { return !used[q.id]; }));
    var got = [];
    for (var k = 0; k < avail.length && got.length < n; k++) {
      used[avail[k].id] = 1;
      got.push(avail[k]);
    }
    return got;
  }

  ["judge", "single"].forEach(function (type) {
    var grouped = {};
    CATS.forEach(function (c) { grouped[c] = []; });
    _byType[type].forEach(function (q) { if (grouped[q.category]) grouped[q.category].push(q); });

    var deficit = 0;
    CATS.forEach(function (cat) {
      var got = pick(grouped[cat], quota[type][cat]);
      paper.push.apply(paper, got);
      deficit += quota[type][cat] - got.length;
    });
    // 某章节题量不足时从同题型补足
    if (deficit > 0) paper.push.apply(paper, pick(_byType[type], deficit));
  });

  return shuffle(paper);
}

/* ============================== 会话状态 ============================== */
var MODE = { PRACTICE: "practice", EXAM: "exam", WRONG: "wrong" };

var state = {};
function resetState() {
  stopTimer();
  state = {
    mode: null,
    paper: [],
    idx: 0,
    answers: {},     // {题序: 所选选项下标}
    judged: {},      // {题序: true/false} 刷题/错题模式即时判定
    marks: {},
    startTime: 0,
    timerH: null,
    submitted: false,
    wrongAtStart: 0  // 错题模式开始时的错题本数量（用于结算"本轮攻克"）
  };
}
resetState();

/* ============================== 封面页 ============================== */
function refreshCover() {
  migrateWrongBook();

  var sm2 = loadSm2();
  var stats = loadStats();
  var wrong = loadWrong();
  var now = Date.now();

  var learned = Object.keys(sm2).length;
  var mastered = 0;
  Object.keys(sm2).forEach(function (id) { if (sm2IsMastered(sm2[id])) mastered++; });

  var wrongN = Object.keys(wrong).length;
  var dueWrong = 0;
  Object.keys(wrong).forEach(function (id) { if (sm2IsDue(sm2[id], now)) dueWrong++; });

  $("cv-bank").textContent = BANK.length;
  $("cv-mastered").textContent = mastered;
  $("cv-accuracy").textContent = stats.totalAnswered > 0
    ? Math.round(stats.totalCorrect / stats.totalAnswered * 100) + "%"
    : "—";
  $("cv-streak").textContent = calcStreak(stats) + "天";

  // 学习进度（按已学题数）
  var pct = BANK.length > 0 ? Math.round(learned / BANK.length * 100) : 0;
  $("cv-progress-fill").style.width = pct + "%";
  $("cv-progress-pct").textContent = pct + "%";
  $("cv-progress-meta").textContent = "已学 " + learned + " / " + BANK.length + " 题 · 掌握 " + mastered + " 题";

  // 错题重练入口
  var wrongBtn = $("btn-wrong");
  if (wrongN > 0) {
    wrongBtn.classList.remove("disabled");
    $("wrong-badge").textContent = wrongN;
    $("wrong-desc").textContent = "今日到期 " + dueWrong + " · 共 " + wrongN + " 题";
  } else {
    wrongBtn.classList.add("disabled");
    $("wrong-badge").textContent = "0";
    $("wrong-desc").textContent = learned > 0 ? "错题本已清空 🎉" : "暂无错题记录";
  }
}

function calcStreak(stats) {
  if (!stats.studyDays || Object.keys(stats.studyDays).length === 0) return 0;
  var d = new Date();
  // 今天还没学则从昨天往前数
  if (!stats.studyDays[todayStr()]) d.setDate(d.getDate() - 1);
  var streak = 0;
  while (true) {
    var key = d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
    if (stats.studyDays[key]) { streak++; d.setDate(d.getDate() - 1); }
    else break;
  }
  return streak;
}

function recordStudyDay() {
  var stats = loadStats();
  var t = todayStr();
  stats.studyDays[t] = 1;
  stats.lastStudyDay = t;
  saveStats(stats);
}

function goHome() {
  resetState();
  refreshCover();
  show("page-cover");
}

$("btn-practice").onclick = startPractice;
$("btn-exam").onclick = startExam;
$("btn-wrong").onclick = function () {
  if ($("btn-wrong").classList.contains("disabled")) return;
  startWrong();
};
$("btn-reset").onclick = function () {
  if (!confirm("确定重置全部学习进度吗？\n\n将清除：SM-2 间隔记录、错题本、答题统计、模考历史。\n（图片缓存不受影响）")) return;
  localStorage.removeItem(LS_SM2);
  localStorage.removeItem(LS_WRONG);
  localStorage.removeItem(LS_STATS);
  refreshCover();
  alert("已重置学习进度。");
};

/* ============================== 开始各模式 ============================== */
function startPractice() {
  resetState();
  var paper = buildPracticePaper(PAPER_SIZE);
  if (paper.length === 0) { alert("题库为空，无法开始。"); return; }
  state.mode = MODE.PRACTICE;
  state.paper = paper;
  enterExamPage();
}

function startWrong() {
  var paper = buildWrongPaper(PAPER_SIZE);
  if (paper.length === 0) { alert("🎉 错题本是空的，暂无错题需要重练！"); return; }
  resetState();
  state.mode = MODE.WRONG;
  state.paper = paper;
  state.wrongAtStart = wrongCount();
  enterExamPage();
}

function startExam() {
  resetState();
  state.mode = MODE.EXAM;
  state.paper = buildExamPaper();
  enterExamPage();
}

function enterExamPage() {
  // 模式徽标
  ["mb-practice", "mb-exam", "mb-wrong"].forEach(function (id) { $(id).classList.add("hidden"); });
  var mbId = state.mode === MODE.PRACTICE ? "mb-practice" : (state.mode === MODE.EXAM ? "mb-exam" : "mb-wrong");
  $(mbId).classList.remove("hidden");

  closeSheet();
  $("cur-total").textContent = state.paper.length;
  $("btn-submit").textContent = state.mode === MODE.EXAM ? "交卷" : "完成练习";

  state.startTime = Date.now();
  if (state.mode === MODE.EXAM) startCountdown(45 * 60);
  else startStopwatch();

  show("page-exam");
  renderQuestion();
  recordStudyDay();
}

/* ============================== 计时器 ============================== */
function stopTimer() {
  if (state.timerH) { clearInterval(state.timerH); state.timerH = null; }
}

/* 模考倒计时：45 分钟，到点自动交卷 */
function startCountdown(seconds) {
  stopTimer();
  var remain = seconds;
  function render() {
    $("timer").textContent = Math.floor(remain / 60) + ":" + pad2(remain % 60);
    $("timer").classList.toggle("warn", remain <= 300);
  }
  render();
  state.timerH = setInterval(function () {
    remain--;
    if (remain <= 0) {
      remain = 0;
      render();
      finishExam(true);
      return;
    }
    render();
  }, 1000);
}

/* 刷题/错题模式：正向计时 */
function startStopwatch() {
  stopTimer();
  function render() {
    var el = Math.floor((Date.now() - state.startTime) / 1000);
    $("timer").textContent = Math.floor(el / 60) + ":" + pad2(el % 60);
    $("timer").classList.remove("warn");
  }
  render();
  state.timerH = setInterval(render, 1000);
}

/* ============================== 渲染题目 ============================== */
function renderQuestion() {
  try {
    var i = state.idx;
    var q = state.paper[i];
    var total = state.paper.length;
    if (!q) {
      $("q-area").innerHTML = '<p style="text-align:center;color:var(--gray-5)">暂无题目</p>';
      return;
    }

    $("pg-bar").style.width = ((i + 1) / total * 100) + "%";
    $("cur-no").textContent = i + 1;
    $("cur-done").textContent = Object.keys(state.answers).length;
    $("btn-mark").classList.toggle("active", !!state.marks[i]);
    $("btn-mark").textContent = state.marks[i] ? "🚩 已标记" : "🚩 标记";
    $("btn-prev").disabled = (i === 0);
    if (state.mode === MODE.EXAM) {
      $("btn-next").textContent = (i === total - 1) ? "查看答题卡" : "下一题 ›";
      $("btn-next").disabled = false;
    } else {
      // 刷题/错题模式：未答题时禁用下一题，引导先作答
      $("btn-next").textContent = (i === total - 1) ? "完成 ›" : "下一题 ›";
      $("btn-next").disabled = (state.judged[i] === undefined);
    }

    var isPracticeLike = (state.mode !== MODE.EXAM);
    var selected = state.answers[i];
    var judged = state.judged[i];

    var optsHtml = q.options.map(function (o, idx) {
      var cls = "opt";
      if (judged !== undefined) {
        // 已判定（仅刷题/错题模式）：锁定并标出对错
        if (idx === q.answer) cls += " correct";
        else if (idx === selected && judged === false) cls += " wrong";
        if (isPracticeLike) cls += " disabled";
      } else if (selected === idx) {
        cls += " selected";
      }
      return '<button class="' + cls + '" data-i="' + idx + '"><span class="k">' +
        String.fromCharCode(65 + idx) + '</span><span>' + escapeHtml(o) + '</span></button>';
    }).join("");

    var imgHtml = q.image
      ? '<img class="q-image" src="' + imgUrl(q.image) + '" alt="题目图" loading="lazy" onerror="this.style.display=\'none\'">'
      : "";

    var feedbackHtml = "";
    if (isPracticeLike && judged !== undefined) {
      feedbackHtml = buildFeedbackHtml(q, selected, judged);
    }

    $("q-area").innerHTML =
      '<div class="q-tag ' + (q.type === "judge" ? "judge" : "") + '">' + (q.type === "judge" ? "判断题" : "单选题") + '</div>' +
      '<div class="q-no">第 <b>' + (i + 1) + '</b> 题 / ' + total + '</div>' +
      '<div class="q-text">' + escapeHtml(q.question) + '</div>' +
      imgHtml +
      '<div class="opts">' + optsHtml + '</div>' +
      feedbackHtml;

    Array.prototype.forEach.call($("q-area").querySelectorAll(".opt"), function (el) {
      el.onclick = function () {
        if (state.submitted) return;
        onOptionClick(parseInt(el.getAttribute("data-i"), 10));
      };
    });
  } catch (err) {
    $("q-area").innerHTML = '<p style="color:var(--red)">题目渲染异常：' + escapeHtml(err.message) + '</p>';
    if (window.console) console.error(err);
  }
}

function buildFeedbackHtml(q, selected, judged) {
  var h = '<div class="feedback ' + (judged ? "right" : "wrong") + '">';
  h += '<div class="fb-title">' + (judged ? "✔ 答对了" : "✘ 答错了") + '</div>';
  if (!judged) {
    h += '<div class="ans-line">你的答案：<span class="your wrong">' + escapeHtml(q.options[selected]) + '</span></div>';
  }
  h += '<div class="ans-line">正确答案：<span class="correct">' + escapeHtml(q.options[q.answer]) + '</span></div>';
  if (q.explain) {
    h += '<div class="exp"><b>解析：</b>' + escapeHtml(q.explain);
    if (q.updated) h += '<span class="updated">已按2025新规更新</span>';
    h += '</div>';
  }
  if (q.law) {
    h += '<div class="exp law"><b>依据：</b>' + escapeHtml(q.law) + '</div>';
  }
  h += '</div>';
  return h;
}

/* ============================== 作答 ============================== */
function onOptionClick(idx) {
  var i = state.idx;
  var q = state.paper[i];

  if (state.mode === MODE.EXAM) {
    // 模考：可改选，点已选项=取消
    if (state.answers[i] === idx) delete state.answers[i];
    else state.answers[i] = idx;
    renderQuestion();
    return;
  }

  // 刷题/错题模式：判定后锁定
  if (state.judged[i] !== undefined) return;
  state.answers[i] = idx;
  var isRight = (idx === q.answer);
  state.judged[i] = isRight;

  recordPracticeAnswer(q.id, isRight);

  renderQuestion();
  renderSheet();
}

/* ============================== 导航 ============================== */
$("btn-prev").onclick = function () {
  if (state.idx > 0) { state.idx--; renderQuestion(); window.scrollTo(0, 0); }
};
$("btn-next").onclick = function () {
  if (state.mode !== MODE.EXAM && state.judged[state.idx] === undefined) return; // 未答不能跳
  if (state.idx < state.paper.length - 1) {
    state.idx++;
    renderQuestion();
    window.scrollTo(0, 0);
  } else if (state.mode === MODE.EXAM) {
    openSheet();
  } else {
    finishPractice();
  }
};
$("btn-mark").onclick = function () {
  var i = state.idx;
  if (state.marks[i]) delete state.marks[i];
  else state.marks[i] = 1;
  renderQuestion();
};

/* ============================== 答题卡 ============================== */
$("btn-sheet").onclick = openSheet;
$("sheet-mask").onclick = closeSheet;
$("sheet-close").onclick = closeSheet;

function openSheet() {
  renderSheet();
  $("sheet").classList.add("show");
  $("sheet-mask").classList.add("show");
}
function closeSheet() {
  $("sheet").classList.remove("show");
  $("sheet-mask").classList.remove("show");
}
function renderSheet() {
  if (state.mode === MODE.EXAM) {
    $("sheet-legend").innerHTML =
      '<span><i style="background:var(--blue);border-color:var(--blue)"></i>已答</span>' +
      '<span><i></i>未答</span>' +
      '<span><i style="border-color:var(--orange)"></i>标记</span>';
  } else {
    $("sheet-legend").innerHTML =
      '<span><i style="background:var(--green);border-color:var(--green)"></i>答对</span>' +
      '<span><i style="background:var(--red);border-color:var(--red)"></i>答错</span>' +
      '<span><i></i>未答</span>' +
      '<span><i style="border-color:var(--orange)"></i>标记</span>';
  }

  var html = "";
  state.paper.forEach(function (q, i) {
    var cls = "";
    if (state.mode === MODE.EXAM) {
      if (state.answers[i] !== undefined) cls += " answered";
    } else {
      if (state.judged[i] === true) cls += " right";
      else if (state.judged[i] === false) cls += " wrong";
    }
    if (state.marks[i]) cls += " marked";
    if (i === state.idx) cls += " current";
    html += '<button class="' + cls.trim() + '" data-i="' + i + '">' + (i + 1) + '</button>';
  });
  $("sheet-grid").innerHTML = html;

  Array.prototype.forEach.call($("sheet-grid").children, function (b) {
    b.onclick = function () {
      state.idx = parseInt(b.getAttribute("data-i"), 10);
      closeSheet();
      renderQuestion();
      window.scrollTo(0, 0);
    };
  });
}

/* 交卷 / 完成练习 */
$("btn-submit").onclick = function () {
  if (state.mode === MODE.EXAM) {
    var unanswered = state.paper.length - Object.keys(state.answers).length;
    var tip = unanswered > 0 ? "还有 " + unanswered + " 题未作答，确定交卷吗？" : "确定交卷吗？";
    if (!confirm(tip)) return;
    finishExam(false);
  } else {
    var undone = state.paper.length - Object.keys(state.judged).length;
    var tip2 = undone > 0 ? "还有 " + undone + " 题未做，提前结束本次练习吗？" : "已完成全部题目，查看本次练习总结？";
    if (!confirm(tip2)) return;
    finishPractice();
  }
};

/* ============================== 结束：刷题/错题模式 ============================== */
function finishPractice() {
  stopTimer();
  state.submitted = true;
  closeSheet();

  var right = 0, wrong = 0;
  state.paper.forEach(function (q, i) {
    if (state.judged[i] === true) right++;
    else if (state.judged[i] === false) wrong++;
  });
  var done = right + wrong;
  var usedMin = Math.round((Date.now() - state.startTime) / 60000);
  var acc = done > 0 ? Math.round(right / done * 100) : 0;
  var pass = acc >= 90;

  renderScoreRing(acc, pass);
  $("r-score").textContent = acc;

  var isWrong = state.mode === MODE.WRONG;
  var sub = "答对 " + right + " / " + done + " 题 · 正确率 " + acc + "% · 用时 " + usedMin + "′";
  if (isWrong) {
    var remaining = wrongCount();
    var cleared = Math.max(0, state.wrongAtStart - remaining);
    sub += " · 移出错题本 " + cleared + " 题（剩余 " + remaining + " 题）";
  }
  $("r-verdict").textContent = isWrong ? "错题重练完成" : "本次练习完成";
  $("r-verdict").className = "verdict " + (pass ? "pass" : "fail");
  $("r-verdict-sub").textContent = sub;
  $("r-right").textContent = right;
  $("r-wrong").textContent = wrong;
  $("r-time").textContent = usedMin + "′";

  $("btn-again").textContent = "再来一轮";
  $("btn-again").onclick = function () {
    if (isWrong) {
      // 全部移出后直接回首页，避免空试卷
      if (wrongCount() === 0) { alert("🎉 错题已全部攻克！"); goHome(); return; }
      startWrong();
    } else {
      startPractice();
    }
  };

  renderReview(state.paper, state.judged, state.answers);
  show("page-result");
}

/* ============================== 结束：模拟考试 ============================== */
function finishExam(timeout) {
  if (state.submitted) return;
  state.submitted = true;
  stopTimer();
  closeSheet();
  showExamResult(timeout);
}

function showExamResult(timeout) {
  // 判分 + 写入错题本 / SM-2（未答按答错处理，与真实考试一致）
  var result = gradeExamAndRecord(state.paper, state.answers);
  var right = result.right;
  var wrong = state.paper.length - right;
  var score = right;
  var pass = score >= 90;
  var usedMin = Math.round((Date.now() - state.startTime) / 60000);

  // 模考历史
  var stats = loadStats();
  stats.examHistory.push({ score: score, right: right, wrong: wrong, time: usedMin, date: Date.now(), timeout: !!timeout });
  if (stats.examHistory.length > 50) stats.examHistory = stats.examHistory.slice(-50);
  saveStats(stats);

  renderScoreRing(score, pass);
  $("r-score").textContent = score;
  $("r-right").textContent = right;
  $("r-wrong").textContent = wrong;
  $("r-time").textContent = usedMin + "′";
  $("r-verdict").textContent = timeout ? "考试时间到" : (pass ? "恭喜，考试合格！" : "很遗憾，未合格");
  $("r-verdict").className = "verdict " + (pass ? "pass" : "fail");
  $("r-verdict-sub").textContent = pass
    ? "（合格线 90 分，你答对 " + right + " 题）"
    : "（合格线 90 分，还需再对 " + (90 - score) + " 题）";

  $("btn-again").textContent = "再考一次";
  $("btn-again").onclick = startExam;

  renderReview(state.paper, judgeMapFromAnswers(state.paper, state.answers), state.answers);
  show("page-result");
}

function judgeMapFromAnswers(paper, answers) {
  var m = {};
  for (var i = 0; i < paper.length; i++) {
    if (answers[i] !== undefined) m[i] = (answers[i] === paper[i].answer);
  }
  return m;
}

function renderScoreRing(pct, pass) {
  var C = 2 * Math.PI * 70;
  var arc = $("score-arc");
  arc.setAttribute("stroke-dasharray", (C * pct / 100) + " " + C);
  arc.setAttribute("stroke", pass ? "#07c160" : "#fa5151");
}

/* ============================== 结果页逐题解析（可筛选） ============================== */
var _review = { paper: [], judged: {}, answers: {}, filter: "all" };

function renderReview(paper, judged, answers) {
  _review = { paper: paper, judged: judged, answers: answers, filter: "all" };

  var hasWrong = paper.some(function (q, i) { return judged[i] === false; });
  var filterEl = $("rv-filter");
  filterEl.classList.toggle("hidden", !hasWrong);
  if (hasWrong) {
    Array.prototype.forEach.call(filterEl.querySelectorAll("button"), function (b) {
      b.classList.toggle("active", b.getAttribute("data-f") === "all");
      b.onclick = function () {
        _review.filter = b.getAttribute("data-f");
        Array.prototype.forEach.call(filterEl.querySelectorAll("button"), function (x) { x.classList.remove("active"); });
        b.classList.add("active");
        renderReviewList();
      };
    });
  }
  renderReviewList();
}

function renderReviewList() {
  var paper = _review.paper, judged = _review.judged, answers = _review.answers;

  // 排序：错题置顶，其次未答，最后答对
  var wrongIdx = [], rightIdx = [], noIdx = [];
  for (var i = 0; i < paper.length; i++) {
    if (judged[i] === false) wrongIdx.push(i);
    else if (judged[i] === true) rightIdx.push(i);
    else noIdx.push(i);
  }
  var order = _review.filter === "wrong" ? wrongIdx : wrongIdx.concat(noIdx, rightIdx);

  var html = '<h3>📋 逐题解析' + (wrongIdx.length > 0 ? '（错题已置顶）' : '') + '</h3>';
  order.forEach(function (i) {
    var q = paper[i];
    var your = answers[i];
    var isRight = judged[i] === true;
    var isWrong = judged[i] === false;

    var label = isRight ? "✔ 答对" : (isWrong ? "✘ 答错" : "— 未答");
    var labelCls = isRight ? "right" : (isWrong ? "wrong" : "");
    var cardCls = isRight ? "right" : (isWrong ? "wrong" : "");

    html += '<div class="rv-item ' + cardCls + '">';
    html += '<div class="rv-head"><span class="t ' + labelCls + '">' + label + '</span>' +
      '<span class="t">第' + (i + 1) + '题 · ' + (q.type === "judge" ? "判断" : "单选") + '</span></div>';
    html += '<div class="rv-q">' + escapeHtml(q.question);
    if (q.image) html += '<br><img src="' + imgUrl(q.image) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">';
    html += '</div>';
    if (isWrong && your !== undefined) {
      html += '<div class="rv-ans">你的答案：<span class="your wrong">' + escapeHtml(q.options[your]) + '</span></div>';
    } else if (your === undefined) {
      html += '<div class="rv-ans"><span style="color:var(--gray-5)">（未作答）</span></div>';
    }
    html += '<div class="rv-ans">正确答案：<span class="correct">' + escapeHtml(q.options[q.answer]) + '</span></div>';
    if (q.explain) {
      html += '<div class="rv-exp"><b>解析：</b>' + escapeHtml(q.explain) +
        (q.updated ? '<span class="rv-updated">已按2025新规更新</span>' : '') + '</div>';
    }
    if (q.law) html += '<div class="rv-exp" style="margin-top:4px"><b>依据：</b>' + escapeHtml(q.law) + '</div>';
    html += '</div>';
  });

  $("review").innerHTML = html;
  window.scrollTo(0, 0);
}

$("btn-result-home").onclick = goHome;

/* ============================== 图片预下载（Cache API） ============================== */
var _dlCancelled = false;
$("btn-predl").onclick = openPredl;

function openPredl() {
  var urls = [];
  BANK.forEach(function (q) { if (q.image) urls.push(imgUrl(q.image)); });
  if (urls.length === 0) { alert("题库无图片。"); return; }

  $("dl-title").textContent = "📥 预下载图片库";
  $("dl-sub").textContent = "将下载全部 " + urls.length + " 张题目图片至本地，支持离线查看。预计约 50-100MB。";
  $("dl-fill").style.width = "0%";
  $("dl-num").textContent = "点击开始下载";
  $("dl-cancel").textContent = "开始下载";
  $("dl-mask").classList.add("show");

  var started = false;
  $("dl-cancel").onclick = function () {
    if (!started) {
      started = true;
      _dlCancelled = false;
      $("dl-cancel").textContent = "取消";
      runPredl(urls);
    } else {
      _dlCancelled = true;
    }
  };
}

function runPredl(urls) {
  if (!("caches" in window)) { $("dl-num").textContent = "浏览器不支持缓存"; return; }
  caches.open("kemuyi-imgs").then(function (cache) {
    var done = 0, failed = 0;
    var i = 0;

    function finish(msgTitle, msgSub, btnText, close) {
      $("dl-title").textContent = msgTitle;
      $("dl-sub").textContent = msgSub;
      $("dl-num").textContent = done + " / " + urls.length + (failed > 0 ? "（失败 " + failed + "）" : "");
      $("dl-cancel").textContent = btnText;
      if (close) $("dl-cancel").onclick = function () { $("dl-mask").classList.remove("show"); refreshCover(); };
    }

    function step() {
      if (_dlCancelled) {
        finish("已取消", "已下载 " + done + " 张，可随时继续。", "关闭", true);
        return;
      }
      if (i >= urls.length) {
        finish("✅ 下载完成", "图片库已离线可用" + (failed > 0 ? "（" + failed + " 张下载失败，可稍后重试）" : ""), "完成", true);
        return;
      }
      var url = urls[i++];
      cache.match(url).then(function (cached) {
        if (cached) { done++; next(); return; }
        fetch(url, { mode: "no-cors" }).then(function (resp) {
          if (resp.ok || resp.type === "opaque") {
            return cache.put(url, resp).then(function () { done++; next(); }, function () { done++; next(); });
          }
          done++; next();
        }, function () { failed++; done++; next(); });
      }, function () { failed++; done++; next(); });
    }

    function next() {
      // 每 3 张更新一次 UI，避免频繁重绘（done 含失败数）
      if (done % 3 === 0 || done >= urls.length) {
        $("dl-fill").style.width = Math.round(done / urls.length * 100) + "%";
        $("dl-num").textContent = done + " / " + urls.length + (failed > 0 ? "（失败 " + failed + "）" : "");
      }
      step();
    }

    step();
  });
}

/* ============================== Service Worker ============================== */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("sw.js").catch(function (e) {
      // file:// 或不支持时静默失败
      if (window.console) console.warn("SW 注册失败:", e);
    });
  });
}

/* ============================== 启动 ============================== */
migrateWrongBook();
refreshCover();
show("page-cover");

// 暴露核心纯函数，便于浏览器控制台调试与自动化测试
window.__KMY__ = {
  loadSm2: loadSm2, saveSm2: saveSm2,
  loadWrong: loadWrong, saveWrong: saveWrong,
  loadStats: loadStats, saveStats: saveStats,
  sm2New: sm2New, sm2Update: sm2Update, sm2IsDue: sm2IsDue, sm2IsMastered: sm2IsMastered,
  wrongAdd: wrongAdd, wrongRemove: wrongRemove, wrongCount: wrongCount,
  migrateWrongBook: migrateWrongBook,
  recordPracticeAnswer: recordPracticeAnswer, gradeExamAndRecord: gradeExamAndRecord,
  buildPracticePaper: buildPracticePaper, buildWrongPaper: buildWrongPaper, buildExamPaper: buildExamPaper
};

})();
