/* ═══════════════════════════════════════════════════════════════
   BACCARAT AI V9 ULTRA C — Moteur JS frontend
   Identique à src/engine.ts (TypeScript serveur).
   Poids issus du backtest sur 915 mains réelles (sept-décembre 2025).
   ═══════════════════════════════════════════════════════════════ */
'use strict';

window.V9 = window.V9 || {};

(function(NS){

const SUITS = ['♠','♥','♦','♣'];
const RED = new Set(['♥','♦']);
const SUIT_NAME = {'♠':'Pique','♥':'Cœur','♦':'Carreau','♣':'Trèfle'};
const SUIT_NAME_FULL = {'♠':'PIQUE','♥':'CŒUR','♦':'CARREAU','♣':'TRÈFLE'};
const ENEMY = {'♠':'♣','♣':'♠','♥':'♦','♦':'♥'};

const WEIGHTS = {
  p1: { freq: 0.237, coverage: 0.041, markov: 0.448, momentum: 0.024, color: 0.171, least_recent: 0.080 },
  p2: { freq: 0.026, coverage: 0.284, markov: 0.427, momentum: 0.110, color: 0.039, least_recent: 0.114 },
};

const norm = (d) => {
  let s = 0;
  for (const k of SUITS) s += (d[k] || 0);
  if (!s) s = 1;
  const o = {};
  for (const k of SUITS) o[k] = (d[k] || 0) / s;
  return o;
};

// ────────────────────── PARSER ──────────────────────
const CARD_RE = /(10|[2-9]|[AKQJ])\s*([♠♥♦♣])/gi;
const PAREN_RE = /\(([^)]+)\)/g;

function parseRaw(raw) {
  const text = String(raw || '').replace(/[\u200b-\u200d\ufeff\u00ef\u00b8\u008f\ufe0f]/g,'').replace(/\s+/g,' ').trim();
  const numM = text.match(/#N\s*(\d+)/i);
  if (!numM) return null;
  const gameNum = parseInt(numM[1], 10);
  const groups = [];
  let pm;
  PAREN_RE.lastIndex = 0;
  while ((pm = PAREN_RE.exec(text)) !== null) groups.push(pm[1]);
  if (groups.length < 2) return null;
  function cards(group) {
    const out = [];
    CARD_RE.lastIndex = 0;
    let m;
    while ((m = CARD_RE.exec(group)) !== null) out.push({val:m[1].toUpperCase(), suit:m[2]});
    return out;
  }
  const p1 = cards(groups[0]);
  const p2 = cards(groups[1]);
  if (!p1.length || !p2.length) return null;
  const scores = [...text.matchAll(/(\d+)\s*\(/g)].map(x => parseInt(x[1],10));
  const p1_score = scores[0] ?? null;
  const p2_score = scores[1] ?? null;
  if (p1_score === null || p2_score === null) return null;
  const outcome = p1_score > p2_score ? 'J' : (p2_score > p1_score ? 'B' : 'E');
  const tM = text.match(/#T(\d+)/i);
  return {
    gameNum,
    p1, p2,
    p1_score, p2_score,
    p1_first: p1[0].suit,
    p2_first: p2[0].suit,
    p1_suits: p1.map(c=>c.suit),
    p2_suits: p2.map(c=>c.suit),
    outcome,
    has_retirage: /#R\b/i.test(text),
    tValue: tM ? parseInt(tM[1],10) : null,
    raw: text,
  };
}

// ────────────────────── SOUS-MOTEURS ──────────────────────
function engineFreq(ctx, side, K=20, decay=0.95) {
  const cnt = {'♠':0,'♥':0,'♦':0,'♣':0};
  const slice = ctx.slice(-K);
  slice.forEach((h,i) => {
    const w = Math.pow(decay, K - i - 1);
    cnt[h[side+'_first']] = (cnt[h[side+'_first']]||0) + w;
  });
  return norm(cnt);
}

function engineCoverage(ctx, side, K=25, decay=0.95) {
  const cnt = {'♠':0,'♥':0,'♦':0,'♣':0};
  const slice = ctx.slice(-K);
  slice.forEach((h,i) => {
    const w = Math.pow(decay, K - i - 1);
    const set = new Set(h[side+'_suits']);
    for (const s of set) cnt[s] = (cnt[s]||0) + w;
  });
  return norm(cnt);
}

function engineMarkov(ctx, side, lastN=200) {
  const seq = ctx.slice(-lastN).map(h => h[side+'_first']);
  if (seq.length < 5) return {'♠':0.25,'♥':0.25,'♦':0.25,'♣':0.25};
  const last = seq[seq.length-1];
  const last2 = seq.length > 1 ? seq[seq.length-2] : last;
  const m1 = {'♠':0,'♥':0,'♦':0,'♣':0};
  const m2 = {'♠':0,'♥':0,'♦':0,'♣':0};
  for (let i=1; i<seq.length; i++) if (seq[i-1] === last) m1[seq[i]]++;
  for (let i=2; i<seq.length; i++) if (seq[i-2] === last2 && seq[i-1] === last) m2[seq[i]]++;
  const n1 = SUITS.reduce((a,s) => a + m1[s], 0) || 1;
  const n2 = SUITS.reduce((a,s) => a + m2[s], 0) || 1;
  const out = {};
  for (const s of SUITS) {
    out[s] = n2 > 3 ? 0.5*(m1[s]/n1) + 0.5*(m2[s]/n2) : m1[s]/n1;
    out[s] += 0.05;
  }
  return norm(out);
}

function engineMomentum(ctx, side) {
  if (ctx.length < 5) return {'♠':0.25,'♥':0.25,'♦':0.25,'♣':0.25};
  const seq = ctx.slice(-7).map(h => h[side+'_first']);
  const c = {};
  for (const s of seq) c[s] = (c[s]||0) + 1;
  const base = {'♠':0.20,'♥':0.20,'♦':0.20,'♣':0.20};
  for (const s of SUITS) {
    const n = c[s]||0;
    if (n >= 3) base[s] += 0.30;
    else if (n >= 2) base[s] += 0.10;
  }
  const last = seq[seq.length-1];
  base[last] *= 0.85;
  return norm(base);
}

function engineColorGuard(ctx, side, K=15) {
  if (ctx.length < K) return {'♠':0.25,'♥':0.25,'♦':0.25,'♣':0.25};
  const seq = ctx.slice(-K).map(h => h[side+'_first']);
  const nRed = seq.filter(s => RED.has(s)).length;
  const redPref = nRed / K;
  const out = {};
  for (const s of SUITS) out[s] = RED.has(s) ? 0.5*redPref : 0.5*(1-redPref);
  return norm(out);
}

function engineLeastRecent(ctx, side, K=10) {
  if (ctx.length < K) return {'♠':0.25,'♥':0.25,'♦':0.25,'♣':0.25};
  const seq = ctx.slice(-K).map(h => h[side+'_first']);
  const c = {'♠':0,'♥':0,'♦':0,'♣':0};
  for (const s of seq) c[s] = (c[s]||0) + 1;
  const inv = {};
  for (const s of SUITS) inv[s] = 1.0 / (1 + c[s]);
  return norm(inv);
}

// ────────────────────── FUSION ──────────────────────
function predictSide(ctx, side, mode='normal', avoidSuit=null) {
  const engines = {
    freq:         engineFreq(ctx, side),
    coverage:     engineCoverage(ctx, side),
    markov:       engineMarkov(ctx, side),
    momentum:     engineMomentum(ctx, side),
    color:        engineColorGuard(ctx, side),
    least_recent: engineLeastRecent(ctx, side),
  };
  const w = WEIGHTS[side];
  let fused = {'♠':0,'♥':0,'♦':0,'♣':0};
  for (const [name, dist] of Object.entries(engines)) {
    const ww = w[name] || 0;
    for (const s of SUITS) fused[s] += ww * dist[s];
  }
  fused = norm(fused);

  if (mode === 'rattrapage') {
    // En rattrapage, on pousse vers la couverture (probabilité d'apparition dans P)
    // et on évite si possible l'enseigne qui vient d'échouer.
    const cov = engineCoverage(ctx, side, 30);
    for (const s of SUITS) fused[s] = 0.4*fused[s] + 0.6*cov[s];
    if (avoidSuit && fused[avoidSuit] !== undefined) {
      fused[avoidSuit] *= 0.55;
    }
    fused = norm(fused);
  }

  const sorted = [...SUITS].sort((a,b) => fused[b] - fused[a]);
  return {
    best: sorted[0],
    second: sorted[1],
    third: sorted[2],
    confidence: fused[sorted[0]],
    distribution: fused,
    engines,
    mode,
  };
}

// Recommendation logic
function classifyConfidence(c) {
  if (c >= 0.32) return 'high';
  if (c >= 0.27) return 'mid';
  return 'low';
}

// ────────────────────── PUBLIC API ──────────────────────
NS.parseRaw = parseRaw;
NS.SUITS = SUITS;
NS.RED = RED;
NS.SUIT_NAME = SUIT_NAME;
NS.SUIT_NAME_FULL = SUIT_NAME_FULL;
NS.WEIGHTS = WEIGHTS;
NS.predictSide = predictSide;
NS.classifyConfidence = classifyConfidence;

NS.isRed = (s) => RED.has(s);
NS.colorOf = (s) => RED.has(s) ? 'red' : 'black';

/**
 * Predict next hand. ctx = chronologically sorted array of parsed hands.
 * state.lossSide: 'p1' or 'p2' if last prediction lost on either side (drives rattrapage)
 * state.lastBest: { p1, p2 } – previous best predictions (for avoidance)
 */
/**
 * Sort hands by REAL chronological order using Telegram message_id.
 * message_id is strictly monotonic by post time, so it works even when
 * the channel resets gameNum from #1440 back to #1 at midnight.
 * Fallback to gameNum only for very old data with no message_id.
 */
function sortChrono(hands) {
  return [...hands].sort((a, b) => {
    if (a.message_id != null && b.message_id != null) return a.message_id - b.message_id;
    return a.gameNum - b.gameNum;
  });
}
NS.sortChrono = sortChrono;

NS.predictNext = function(ctx, state = {}) {
  const sorted = sortChrono(ctx);
  const playerMode = (state.lossStreakP1 && state.lossStreakP1 >= 1) ? 'rattrapage' : 'normal';
  const bankerMode = (state.lossStreakP2 && state.lossStreakP2 >= 1) ? 'rattrapage' : 'normal';
  const player = predictSide(sorted, 'p1', playerMode, playerMode==='rattrapage' ? (state.lastBest?.p1 || null) : null);
  const banker = predictSide(sorted, 'p2', bankerMode, bankerMode==='rattrapage' ? (state.lastBest?.p2 || null) : null);
  const recommendation = computeRecommendation(player, banker);
  const last = sorted.length ? sorted[sorted.length-1] : null;
  // Predict the next hand number based purely on the last hand seen,
  // regardless of whether numbering reset at midnight. If last was #1440
  // and next will be #1, the channel will tell us — we just label
  // "after #1440". UI shows "#?" if just-after-reset is unknown.
  return {
    gameNumNext: last ? last.gameNum + 1 : null,
    lastGameNum: last ? last.gameNum : null,
    basedOn: sorted.length,
    player, banker,
    recommendation,
  };
};

function computeRecommendation(p, b) {
  const cP = p.confidence, cB = b.confidence;
  const strong = cP >= 0.32 && cB >= 0.30;
  const moderate = cP >= 0.28 || cB >= 0.28;
  const rattrapage = p.mode === 'rattrapage' || b.mode === 'rattrapage';
  if (rattrapage) {
    return {
      level: 'recovery',
      title: 'Mode rattrapage actif',
      text: `Couverture étendue activée. Cible J: ${p.best} ou ${p.second} · Cible B: ${b.best} ou ${b.second}.`
    };
  }
  if (strong) {
    return {
      level: 'strong',
      title: 'Mise forte recommandée',
      text: `Convergence des sous-moteurs. Joueur ${p.best} (${SUIT_NAME[p.best]}) + Banquier ${b.best} (${SUIT_NAME[b.best]}).`
    };
  }
  if (moderate) {
    return {
      level: 'normal',
      title: 'Confiance modérée',
      text: `Joueur ${p.best} (${(cP*100).toFixed(1)}%) · Banquier ${b.best} (${(cB*100).toFixed(1)}%). Garder une mise standard.`
    };
  }
  return {
    level: 'normal',
    title: 'Signal faible',
    text: 'Les moteurs ne s\'accordent pas franchement. Attendre ou jouer petit.'
  };
}

/**
 * Backtest replay: re-runs predictions on every hand of ctx, computes accuracy + recovery stats.
 * Useful for the "Performances" panel (last 50 hands).
 */
NS.backtest = function(hands, windowFromEnd = null) {
  const sorted = sortChrono(hands);
  const startIdx = windowFromEnd ? Math.max(30, sorted.length - windowFromEnd) : 30;
  const stats = {
    n: 0,
    p1: { exact: 0, in_set: 0, color: 0, cover2: 0 },
    p2: { exact: 0, in_set: 0, color: 0, cover2: 0 },
    rattrapage_n_p1: 0,
    rattrapage_n_p2: 0,
    rattrapage_cover2_p1: 0,
    rattrapage_cover2_p2: 0,
    cur_streak_win: 0,
    max_streak_win: 0,
    cur_streak_loss_p1: 0, max_loss_p1: 0,
    cur_streak_loss_p2: 0, max_loss_p2: 0,
    history: [],
  };
  let lossStreakP1 = 0, lossStreakP2 = 0;
  let lastBestP1 = null, lastBestP2 = null;
  for (let i = startIdx; i < sorted.length; i++) {
    const ctx = sorted.slice(0, i);
    const actual = sorted[i];
    const playerMode = lossStreakP1 >= 1 ? 'rattrapage' : 'normal';
    const bankerMode = lossStreakP2 >= 1 ? 'rattrapage' : 'normal';
    const p = predictSide(ctx, 'p1', playerMode, playerMode==='rattrapage' ? lastBestP1 : null);
    const b = predictSide(ctx, 'p2', bankerMode, bankerMode==='rattrapage' ? lastBestP2 : null);
    const sp = new Set(actual.p1_suits);
    const sb = new Set(actual.p2_suits);
    stats.n++;
    if (p.best === actual.p1_first) stats.p1.exact++;
    if (sp.has(p.best)) stats.p1.in_set++;
    if (RED.has(p.best) === RED.has(actual.p1_first)) stats.p1.color++;
    const coverP = sp.has(p.best) || sp.has(p.second);
    if (coverP) stats.p1.cover2++;
    if (b.best === actual.p2_first) stats.p2.exact++;
    if (sb.has(b.best)) stats.p2.in_set++;
    if (RED.has(b.best) === RED.has(actual.p2_first)) stats.p2.color++;
    const coverB = sb.has(b.best) || sb.has(b.second);
    if (coverB) stats.p2.cover2++;

    if (playerMode === 'rattrapage') { stats.rattrapage_n_p1++; if (coverP) stats.rattrapage_cover2_p1++; }
    if (bankerMode === 'rattrapage') { stats.rattrapage_n_p2++; if (coverB) stats.rattrapage_cover2_p2++; }

    // Determine "success" for streak counting based on mode:
    // normal mode = best must be in P set; rattrapage = best OR second must cover.
    const successP1 = playerMode === 'rattrapage' ? coverP : sp.has(p.best);
    const successP2 = bankerMode === 'rattrapage' ? coverB : sb.has(b.best);

    if (successP1) { lossStreakP1 = 0; } else { lossStreakP1++; }
    if (successP2) { lossStreakP2 = 0; } else { lossStreakP2++; }
    stats.max_loss_p1 = Math.max(stats.max_loss_p1, lossStreakP1);
    stats.max_loss_p2 = Math.max(stats.max_loss_p2, lossStreakP2);

    // Joint streak (both sides success)
    const jointWin = successP1 && successP2;
    if (jointWin) { stats.cur_streak_win++; if (stats.cur_streak_win > stats.max_streak_win) stats.max_streak_win = stats.cur_streak_win; }
    else stats.cur_streak_win = 0;

    lastBestP1 = p.best; lastBestP2 = b.best;
    stats.history.push({
      gameNum: actual.gameNum,
      message_id: actual.message_id,
      raw: actual.raw,
      pred_p1: p.best, conf_p1: p.confidence, mode_p1: playerMode,
      pred_p2: b.best, conf_p2: b.confidence, mode_p2: bankerMode,
      actual_p1_first: actual.p1_first, actual_p2_first: actual.p2_first,
      actual_p1_suits: actual.p1_suits, actual_p2_suits: actual.p2_suits,
      win_p1_exact: p.best === actual.p1_first,
      win_p2_exact: b.best === actual.p2_first,
      win_p1_inset: sp.has(p.best),
      win_p2_inset: sb.has(b.best),
      cover_p1: coverP,
      cover_p2: coverB,
    });
  }
  // Final accuracies
  const r = (x) => stats.n ? x / stats.n : 0;
  stats.acc = {
    p1: { exact: r(stats.p1.exact), in_set: r(stats.p1.in_set), color: r(stats.p1.color), cover2: r(stats.p1.cover2) },
    p2: { exact: r(stats.p2.exact), in_set: r(stats.p2.in_set), color: r(stats.p2.color), cover2: r(stats.p2.cover2) },
    rattrapage_p1: stats.rattrapage_n_p1 ? stats.rattrapage_cover2_p1 / stats.rattrapage_n_p1 : 0,
    rattrapage_p2: stats.rattrapage_n_p2 ? stats.rattrapage_cover2_p2 / stats.rattrapage_n_p2 : 0,
  };
  // Current losing streak (state at end)
  stats.current_loss_p1 = lossStreakP1;
  stats.current_loss_p2 = lossStreakP2;
  return stats;
};

})(window.V9);
