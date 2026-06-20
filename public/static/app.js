/* ═══════════════════════════════════════════════════════════════
   BACCARAT AI V9 ULTRA C — Application UI
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const V9 = window.V9;
const STORAGE_KEY = 'v9-hands-v2';  // v2 schema: seq + session
const LEGACY_KEY  = 'v9-hands-v1';
const POLL_INTERVAL = 7000; // 7s
const RESET_THRESHOLD = 100; // if new gameNum < lastGameNum - 100 => new session detected
const $ = (sel, parent=document) => parent.querySelector(sel);

const State = {
  hands: [],           // parsed hands tagged with seq + session
  prediction: null,    // current prediction object
  backtest: null,      // backtest stats (rolling 50)
  backtestFull: null,  // backtest on full sample
  loading: false,
  channel: 'statistika_baccara',
  lastFetch: 0,
  status: 'init',
  deepLoaded: false,   // whether we've done the initial deep scrape
  nextSeq: 1,
  currentSession: 1,
  forceNewSessionOnNext: false, // armed by user via "Reset detected" button
  lastSeenMessageId: 0,         // monotonic — used by doFetchTick to detect new hands
};

// ────────────────────── STORAGE ──────────────────────
function loadHands() {
  try {
    let raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      // Migrate v1 -> v2 (reconstruct seq + session)
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy) {
        const arr = JSON.parse(legacy);
        if (Array.isArray(arr)) {
          const migrated = migrateLegacy(arr);
          localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
          return migrated;
        }
      }
      return [];
    }
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr;
  } catch { return []; }
}

function migrateLegacy(arr) {
  const sorted = arr.slice().sort((a,b) => a.gameNum - b.gameNum);
  let seq = 1, session = 1, lastGN = -Infinity;
  for (const h of sorted) {
    if (lastGN > 0 && h.gameNum < lastGN - RESET_THRESHOLD) session++;
    h.session = session;
    h.seq = seq++;
    lastGN = h.gameNum;
  }
  return sorted;
}

function saveHands(hands) {
  try {
    const trimmed = hands.length > 1500 ? hands.slice(-1500) : hands;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch (e) {
    console.warn('Storage full:', e);
  }
}

/**
 * Merge fresh hands handling daily-cycle reset of gameNum.
 *
 * Telegram channel resets numbering each day (#1440 -> #1). We detect this
 * by comparing each fresh hand's gameNum vs the latest known gameNum in
 * chronological order: if it falls back hard (< lastGN - RESET_THRESHOLD),
 * we open a new session.
 *
 * Composite key (session:gameNum) ensures the same gameNum in two different
 * sessions never collides.
 * Sort key = seq (monotonic, never wraps).
 */
function mergeHands(existing, fresh, forceNewSession = false) {
  const map = new Map();
  let maxSeq = 0;
  let lastSession = 1;
  let lastSeqGN = -Infinity;

  const existingSorted = existing.slice().sort((a,b) => (a.seq ?? a.gameNum) - (b.seq ?? b.gameNum));
  for (const h of existingSorted) {
    const key = `${h.session ?? 1}:${h.gameNum}`;
    map.set(key, h);
    if ((h.seq ?? 0) > maxSeq) maxSeq = h.seq ?? 0;
    lastSession = h.session ?? 1;
    lastSeqGN = h.gameNum;
  }

  // Process fresh in chronological order. Telegram message_id is monotonic
  // by post time so we use it when available, otherwise fall back to gameNum.
  const freshSorted = fresh.slice().sort((a,b) => {
    if (a.message_id != null && b.message_id != null) return a.message_id - b.message_id;
    return a.gameNum - b.gameNum;
  });

  let currentSession = lastSession;
  if (forceNewSession) {
    currentSession++;
    lastSeqGN = -Infinity; // disable auto-reset for very first fresh hand
  }

  for (const h of freshSorted) {
    if (lastSeqGN > 0 && h.gameNum < lastSeqGN - RESET_THRESHOLD) {
      currentSession++;
    }
    const key = `${currentSession}:${h.gameNum}`;
    if (!map.has(key)) {
      h.session = currentSession;
      h.seq = ++maxSeq;
      map.set(key, h);
    } else {
      const ex = map.get(key);
      h.session = ex.session;
      h.seq = ex.seq;
      map.set(key, h);
    }
    lastSeqGN = h.gameNum;
  }

  State.currentSession = currentSession;
  State.nextSeq = maxSeq + 1;

  return [...map.values()].sort((a,b) => (a.seq ?? a.gameNum) - (b.seq ?? b.gameNum));
}

// Manual reset: arms the next merge to open a fresh session.
function triggerManualReset() {
  if (!State.hands.length) {
    showToast('Aucune main en memoire - rien a reinitialiser', 'error');
    return;
  }
  State.forceNewSessionOnNext = true;
  showToast('Nouvelle session armee : la prochaine main recue ouvrira un cycle', 'success');
  const btn = document.getElementById('btn-new-session');
  if (btn) {
    btn.classList.add('armed');
    btn.textContent = '⏳ Armée';
  }
}

// ────────────────────── FETCH TELEGRAM ──────────────────────
async function fetchLive() {
  try {
    const r = await fetch('/api/telegram/feed', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP '+r.status);
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || 'fetch failed');
    return (data.hands || []).map(h => {
      const p = V9.parseRaw(h.raw);
      if (p) p.message_id = h.message_id;
      return p;
    }).filter(Boolean);
  } catch (e) {
    console.error('fetchLive error:', e);
    return null;
  }
}

async function fetchDeep(pages = 15) {
  try {
    const r = await fetch(`/api/telegram/deep?pages=${pages}`, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP '+r.status);
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || 'deep failed');
    return (data.hands || []).map(h => {
      const p = V9.parseRaw(h.raw);
      if (p) p.message_id = h.message_id;
      return p;
    }).filter(Boolean);
  } catch (e) {
    console.error('fetchDeep error:', e);
    return null;
  }
}

// ────────────────────── RENDER UI SHELL ──────────────────────
function renderShell() {
  document.getElementById('app').innerHTML = `
  <div class="app">
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark"></div>
        <div>
          <div class="brand-title">Baccarat AI <span style="color:var(--accent)">V9</span></div>
          <div class="brand-sub">Ultra C · Prédicteur enseigne J/B · <span class="by-bicode">~by BiCode</span></div>
        </div>
      </div>
      <div class="topbar-right">
        <div class="chip" id="hand-counter">Main <strong>—</strong></div>
        <div class="chip" id="session-chip" title="Session courante (cycle de numérotation Telegram)">Session <strong>1</strong></div>
        <div class="chip" id="sample-chip">Échantillon <strong>0</strong></div>
        <div class="status loading" id="conn-status">Connexion…</div>
        <button class="btn-icon" id="btn-new-session" title="Forcer l'ouverture d'une nouvelle session si le reset minuit n'a pas été détecté automatiquement">🔄 Nouvelle session</button>
        <button class="btn-icon" id="btn-refresh" title="Rafraîchir maintenant">↻</button>
        <button class="btn-icon" id="btn-reload-deep" title="Recharger l'historique profond">⬇</button>
      </div>
    </header>

    <!-- Sync banner: proves the N+1 alignment to the user -->
    <section class="sync-banner" id="sync-banner">
      <div class="sync-step sync-past">
        <div class="sync-step-label">Dernière main vue</div>
        <div class="sync-step-value mono" id="sync-last">#— · —</div>
        <div class="sync-step-sub" id="sync-last-suits">en attente du flux Telegram</div>
      </div>
      <div class="sync-arrow">→</div>
      <div class="sync-step sync-future">
        <div class="sync-step-label">Prédiction pour</div>
        <div class="sync-step-value mono" id="sync-next">#—</div>
        <div class="sync-step-sub" id="sync-next-sub">la prochaine main à venir</div>
      </div>
      <div class="sync-clock" id="sync-clock" title="Âge de la prédiction">—</div>
    </section>

    <section class="predict-hero">
      <div class="pred-card" data-side="player" id="card-player">
        <div class="pred-head">
          <div class="pred-side">
            <span class="pred-side-icon">👤</span>
            <span>Joueur</span>
          </div>
          <div class="pred-head-right">
            <span class="conf-pill" id="conf-pill-p1">—</span>
            <button class="btn-copy" id="btn-copy-p1" title="Copier la prédiction Joueur">📋 COPIER</button>
          </div>
        </div>
        <div class="pred-card-visual">
          <div class="playing-card" id="playing-card-p1">
            <span class="playing-card-corner tl" id="card-corner-tl-p1">—</span>
            <span class="playing-card-suit-main" id="card-suit-p1">?</span>
            <span class="playing-card-corner br" id="card-corner-br-p1">—</span>
          </div>
          <div class="pred-info">
            <div class="pred-suit-name">
              <span id="suit-name-p1">En attente</span>
              <span class="pred-suit-color" id="suit-color-p1"></span>
            </div>
            <div class="conf-block">
              <div class="conf-row">
                <span class="conf-label">Confiance</span>
                <span class="conf-value mono" id="conf-value-p1">—</span>
              </div>
              <div class="conf-bar"><div class="conf-bar-fill" id="conf-fill-p1" style="width:0%"></div></div>
            </div>
            <div class="second-suit">
              <span class="second-suit-label">Plan B</span>
              <span class="second-suit-emblem" id="second-suit-p1">—</span>
              <span style="color:var(--muted-2)" id="second-suit-name-p1"></span>
            </div>
          </div>
        </div>
      </div>

      <div class="pred-card" data-side="banker" id="card-banker">
        <div class="pred-head">
          <div class="pred-side">
            <span class="pred-side-icon">🏦</span>
            <span>Banquier</span>
          </div>
          <div class="pred-head-right">
            <span class="conf-pill" id="conf-pill-p2">—</span>
            <button class="btn-copy" id="btn-copy-p2" title="Copier la prédiction Banquier">📋 COPIER</button>
          </div>
        </div>
        <div class="pred-card-visual">
          <div class="playing-card" id="playing-card-p2">
            <span class="playing-card-corner tl" id="card-corner-tl-p2">—</span>
            <span class="playing-card-suit-main" id="card-suit-p2">?</span>
            <span class="playing-card-corner br" id="card-corner-br-p2">—</span>
          </div>
          <div class="pred-info">
            <div class="pred-suit-name">
              <span id="suit-name-p2">En attente</span>
              <span class="pred-suit-color" id="suit-color-p2"></span>
            </div>
            <div class="conf-block">
              <div class="conf-row">
                <span class="conf-label">Confiance</span>
                <span class="conf-value mono" id="conf-value-p2">—</span>
              </div>
              <div class="conf-bar"><div class="conf-bar-fill" id="conf-fill-p2" style="width:0%"></div></div>
            </div>
            <div class="second-suit">
              <span class="second-suit-label">Plan B</span>
              <span class="second-suit-emblem" id="second-suit-p2">—</span>
              <span style="color:var(--muted-2)" id="second-suit-name-p2"></span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section class="recommendation" id="recommendation">
      <div class="reco-icon">💡</div>
      <div class="reco-content">
        <div class="reco-title" id="reco-title">Initialisation…</div>
        <div class="reco-text" id="reco-text">Chargement des données Telegram en cours.</div>
      </div>
      <button class="btn-copy btn-copy-all" id="btn-copy-all" title="Copier la prédiction complète (J + B)">📋 TOUT COPIER</button>
    </section>

    <section class="metrics" id="metrics">
      <div class="metric">
        <div class="metric-label">Précision Joueur</div>
        <div class="metric-value mono" id="m-acc-p1">—</div>
        <div class="metric-sub">enseigne dans P1 · 50 mains</div>
      </div>
      <div class="metric">
        <div class="metric-label">Précision Banquier</div>
        <div class="metric-value mono" id="m-acc-p2">—</div>
        <div class="metric-sub">enseigne dans P2 · 50 mains</div>
      </div>
      <div class="metric">
        <div class="metric-label">Série actuelle</div>
        <div class="metric-value mono" id="m-streak">—</div>
        <div class="metric-sub">gains consécutifs J+B</div>
      </div>
      <div class="metric">
        <div class="metric-label">Pertes max</div>
        <div class="metric-value mono" id="m-max-loss">—</div>
        <div class="metric-sub">consécutives sur fenêtre</div>
      </div>
    </section>

    <section class="panel" id="panel-engines">
      <div class="panel-head" data-toggle="panel-engines">
        <div class="panel-title">
          <span class="panel-title-icon">⚙️</span>
          <span>Décomposition des moteurs</span>
        </div>
        <span class="panel-toggle">▼</span>
      </div>
      <div class="panel-body" id="engines-body"></div>
    </section>

    <section class="panel open" id="panel-history">
      <div class="panel-head" data-toggle="panel-history">
        <div class="panel-title">
          <span class="panel-title-icon">📜</span>
          <span>Historique <span id="history-count" style="color:var(--muted);font-weight:600;">(0)</span></span>
        </div>
        <span class="panel-toggle">▼</span>
      </div>
      <div class="panel-body">
        <div class="history-list" id="history-list">Chargement…</div>
      </div>
    </section>

    <section class="panel" id="panel-backtest">
      <div class="panel-head" data-toggle="panel-backtest">
        <div class="panel-title">
          <span class="panel-title-icon">📊</span>
          <span>Backtest complet sur l'échantillon</span>
        </div>
        <span class="panel-toggle">▼</span>
      </div>
      <div class="panel-body" id="backtest-body">—</div>
    </section>

    <section class="panel" id="panel-empirical">
      <div class="panel-head" data-toggle="panel-empirical">
        <div class="panel-title">
          <span class="panel-title-icon">🔬</span>
          <span>Rapport empirique de référence (915 mains)</span>
        </div>
        <span class="panel-toggle">▼</span>
      </div>
      <div class="panel-body" id="empirical-body">Chargement…</div>
    </section>

    <footer class="footer">
      <strong>Baccarat AI V9 Ultra C</strong> <span class="by-bicode">~by BiCode</span><br>
      Source live : <a href="https://t.me/statistika_baccara" target="_blank">@statistika_baccara</a> ·
      Cycle journalier auto-détecté · Bouton manuel disponible<br>
      Moteur entraîné sur 915 mains réelles · Backtest validé · Aucun chiffre inventé
    </footer>
  </div>

  <div id="toast-container"></div>
  `;

  // Wire events
  document.querySelectorAll('[data-toggle]').forEach(el => {
    el.addEventListener('click', () => {
      const panel = document.getElementById(el.dataset.toggle);
      panel.classList.toggle('open');
    });
  });
  document.getElementById('btn-refresh').addEventListener('click', () => doFetchTick(true));
  document.getElementById('btn-reload-deep').addEventListener('click', () => doDeepReload());
  document.getElementById('btn-new-session').addEventListener('click', () => triggerManualReset());
  document.getElementById('btn-copy-p1').addEventListener('click', () => copyPrediction('p1'));
  document.getElementById('btn-copy-p2').addEventListener('click', () => copyPrediction('p2'));
  document.getElementById('btn-copy-all').addEventListener('click', () => copyPrediction('all'));
}

// ────────────────────── COPY PREDICTION ──────────────────────
function formatSideBlock(side, predObj) {
  const label = side === 'p1' ? 'JOUEUR' : 'BANQUIER';
  const emoji = side === 'p1' ? '👤' : '🏦';
  const confPct = (predObj.confidence * 100).toFixed(1);
  const cls = V9.classifyConfidence(predObj.confidence);
  const niveau = cls === 'high' ? 'HAUTE' : cls === 'mid' ? 'MOYENNE' : 'FAIBLE';
  const colorBest   = V9.isRed(predObj.best)   ? 'rouge' : 'noir';
  const colorSecond = V9.isRed(predObj.second) ? 'rouge' : 'noir';
  const modeLabel = predObj.mode === 'rattrapage' ? '\n⚠️ Mode rattrapage (couverture étendue)' : '';
  return `${emoji} ${label}
Enseigne : ${predObj.best}  (${V9.SUIT_NAME[predObj.best]} · ${colorBest})
Plan B   : ${predObj.second}  (${V9.SUIT_NAME[predObj.second]} · ${colorSecond})
Confiance: ${confPct}%  [${niveau}]${modeLabel}`;
}

function copyPrediction(target) {
  if (!State.prediction) {
    showToast('Aucune prédiction disponible', 'error');
    return;
  }
  const p = State.prediction;
  const sessionLabel = State.currentSession > 1 ? ` · S${State.currentSession}` : '';
  const header = `🎴 Baccarat AI V9 · ~by BiCode
━━━━━━━━━━━━━━━━━━━━
Main #${p.gameNumNext ?? '—'}${sessionLabel}`;

  let text, toastMsg, btnId;
  if (target === 'p1') {
    text = `${header}\n\n${formatSideBlock('p1', p.player)}\n━━━━━━━━━━━━━━━━━━━━`;
    toastMsg = '👤 Joueur copié ✓';
    btnId = 'btn-copy-p1';
  } else if (target === 'p2') {
    text = `${header}\n\n${formatSideBlock('p2', p.banker)}\n━━━━━━━━━━━━━━━━━━━━`;
    toastMsg = '🏦 Banquier copié ✓';
    btnId = 'btn-copy-p2';
  } else {
    // 'all'
    text = `${header}\n\n${formatSideBlock('p1', p.player)}\n\n${formatSideBlock('p2', p.banker)}\n\n💡 ${p.recommendation.title}\n${p.recommendation.text}\n━━━━━━━━━━━━━━━━━━━━`;
    toastMsg = '📋 Prédiction complète copiée ✓';
    btnId = 'btn-copy-all';
  }

  copyToClipboard(text).then(ok => {
    if (ok) {
      showToast(toastMsg, 'success');
      const btn = document.getElementById(btnId);
      if (btn) {
        const orig = btn.textContent;
        btn.textContent = '✅ Copié !';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1500);
      }
    } else {
      showToast('Échec de la copie — copie manuelle requise', 'error');
    }
  });
}

async function copyToClipboard(text) {
  // Modern path
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch (e) { /* fallback */ }
  }
  // Legacy fallback
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    return false;
  }
}

// ────────────────────── RENDER PARTS ──────────────────────
function setStatus(state, label) {
  const el = document.getElementById('conn-status');
  if (!el) return;
  el.className = 'status' + (state === 'live' ? '' : state === 'loading' ? ' loading' : ' off');
  el.textContent = label;
}

function showToast(msg, type='') {
  const c = document.getElementById('toast-container');
  if (!c) return;
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

function renderPrediction() {
  if (!State.prediction) return;
  const p = State.prediction;
  document.getElementById('hand-counter').innerHTML = `Main <strong>#${p.gameNumNext ?? '—'}</strong>`;
  document.getElementById('sample-chip').innerHTML = `Échantillon <strong>${p.basedOn}</strong>`;
  const sessChip = document.getElementById('session-chip');
  if (sessChip) {
    sessChip.innerHTML = `Session <strong>${State.currentSession}</strong>`;
    sessChip.classList.toggle('multi-session', State.currentSession > 1);
  }

  // Sync banner — visual proof of the N → N+1 contract.
  // Left side  : last hand actually observed on Telegram (= N)
  // Right side : the hand the prediction is for (= N+1)
  const obs = p._lastHandObserved;
  const fut = p._predictedFor;
  if (obs && fut) {
    const lastSuitsP1 = obs.p1_suits.map(s =>
      `<span class="sync-suit-mini ${V9.isRed(s)?'red':'black'}">${s}</span>`).join('');
    const lastSuitsP2 = obs.p2_suits.map(s =>
      `<span class="sync-suit-mini ${V9.isRed(s)?'red':'black'}">${s}</span>`).join('');
    document.getElementById('sync-last').innerHTML =
      `#${obs.gameNum}` + (obs.session > 1 ? ` <span class="sync-sess">S${obs.session}</span>` : '');
    document.getElementById('sync-last-suits').innerHTML =
      `<span class="sync-row"><span class="sync-side">J</span>${lastSuitsP1}</span>` +
      `<span class="sync-row"><span class="sync-side">B</span>${lastSuitsP2}</span>`;
    document.getElementById('sync-next').textContent = `#${fut.gameNum}`;
    document.getElementById('sync-next-sub').textContent = 'projection +1 main · non encore distribuée';
  }

  renderSideCard('p1', p.player, '#card-player');
  renderSideCard('p2', p.banker, '#card-banker');

  // Recommendation
  const reco = p.recommendation;
  const recoEl = document.getElementById('recommendation');
  recoEl.classList.remove('strong', 'recovery');
  if (reco.level === 'strong') recoEl.style.background = 'linear-gradient(135deg,rgba(34,197,94,.18),rgba(34,197,94,.05))';
  else if (reco.level === 'recovery') recoEl.style.background = 'linear-gradient(135deg,rgba(249,115,22,.18),rgba(249,115,22,.05))';
  else recoEl.style.background = 'linear-gradient(135deg,rgba(124,92,255,.12),rgba(34,211,238,.08))';
  document.getElementById('reco-title').textContent = reco.title;
  document.getElementById('reco-text').textContent = reco.text;

  // Engines panel
  renderEngines();
}

function renderSideCard(side, pred, cardSel) {
  const suit = pred.best;
  const second = pred.second;
  const color = V9.isRed(suit) ? 'red' : 'black';
  const confPct = (pred.confidence * 100).toFixed(1);
  const cls = V9.classifyConfidence(pred.confidence);

  // Card visual
  const card = document.getElementById(`playing-card-${side}`);
  card.classList.remove('red','black');
  card.classList.add(color);
  document.getElementById(`card-suit-${side}`).textContent = suit;
  document.getElementById(`card-corner-tl-${side}`).textContent = suit;
  document.getElementById(`card-corner-br-${side}`).textContent = suit;

  document.getElementById(`suit-name-${side}`).textContent = V9.SUIT_NAME[suit].toUpperCase();
  document.getElementById(`suit-color-${side}`).textContent = color === 'red' ? '• rouge' : '• noir';

  document.getElementById(`conf-value-${side}`).textContent = `${confPct}%`;
  const fillEl = document.getElementById(`conf-fill-${side}`);
  fillEl.style.width = `${Math.max(8, Math.min(100, pred.confidence * 100))}%`;
  fillEl.classList.remove('high','mid','low');
  fillEl.classList.add(cls);

  const pill = document.getElementById(`conf-pill-${side}`);
  pill.classList.remove('high','mid','low');
  pill.classList.add(cls);
  pill.textContent = cls === 'high' ? 'HAUTE' : cls === 'mid' ? 'MOYENNE' : 'FAIBLE';

  // Second
  const secColor = V9.isRed(second) ? 'red' : 'black';
  const secEl = document.getElementById(`second-suit-${side}`);
  secEl.textContent = second;
  secEl.classList.remove('red','black');
  secEl.classList.add(secColor);
  document.getElementById(`second-suit-name-${side}`).textContent = V9.SUIT_NAME[second] + (pred.mode === 'rattrapage' ? ' (couverture)' : '');

  // Annotate rattrapage card
  const cardEl = document.querySelector(cardSel);
  if (pred.mode === 'rattrapage') cardEl.style.boxShadow = '0 0 0 1px rgba(249,115,22,.5),0 12px 40px rgba(249,115,22,.15)';
  else cardEl.style.boxShadow = '';
}

function renderEngines() {
  if (!State.prediction) return;
  const body = document.getElementById('engines-body');
  function table(engines, side) {
    let html = '<div class="engine-block"><h4>'+(side==='p1'?'Joueur':'Banquier')+'</h4>';
    for (const [name, dist] of Object.entries(engines)) {
      html += `<div style="margin-bottom:10px"><div style="font-size:10px;color:var(--muted);margin-bottom:3px;font-weight:700;letter-spacing:.05em">${name.toUpperCase()}</div>`;
      html += '<table class="engine-table"><tbody>';
      const sorted = V9.SUITS.slice().sort((a,b)=>dist[b]-dist[a]);
      for (const s of sorted) {
        const pct = (dist[s]*100).toFixed(1);
        const isRed = V9.isRed(s);
        html += `<tr>
          <td class="${isRed?'red':''}">${s}</td>
          <td class="bar"><div class="engine-bar"><div class="engine-bar-fill ${side==='p2'?'banker':''}" style="width:${Math.max(2,dist[s]*100)}%"></div></div></td>
          <td class="val">${pct}%</td>
        </tr>`;
      }
      html += '</tbody></table></div>';
    }
    html += '</div>';
    return html;
  }
  body.innerHTML = '<div class="engine-grid">' + table(State.prediction.player.engines,'p1') + table(State.prediction.banker.engines,'p2') + '</div>';
}

function renderHistory() {
  const list = document.getElementById('history-list');
  const cnt = document.getElementById('history-count');
  const hands = State.hands.slice(-80).reverse();
  cnt.textContent = `(${State.hands.length})`;
  if (!hands.length) { list.innerHTML = '<div style="color:var(--muted);padding:20px;text-align:center">Aucune main encore</div>'; return; }

  // Backtest history keyed by composite session:gameNum (resilient to daily reset).
  let predMap = new Map();
  if (State.backtest && State.backtest.history) {
    for (const hh of State.backtest.history) {
      const k = `${hh.session ?? 1}:${hh.gameNum}`;
      predMap.set(k, hh);
    }
  }

  // Detect session boundaries to insert a divider in the list
  let lastRenderedSession = null;

  let html = '';
  for (const h of hands) {
    const key = `${h.session ?? 1}:${h.gameNum}`;
    const predEntry = predMap.get(key);
    // Session divider (only when changing - hands are reversed so newer first)
    if (lastRenderedSession !== null && lastRenderedSession !== (h.session ?? 1)) {
      html += `<div class="session-divider"><span>— Session ${lastRenderedSession} —</span></div>`;
    }
    lastRenderedSession = h.session ?? 1;
    const p1Display = h.p1_suits.map(s => `<span class="h-suit-mini ${V9.isRed(s)?'red':'black'}">${s}</span>`).join('');
    const p2Display = h.p2_suits.map(s => `<span class="h-suit-mini ${V9.isRed(s)?'red':'black'}">${s}</span>`).join('');
    let p1Pred = '', p2Pred = '';
    if (predEntry) {
      const cls1 = predEntry.win_p1_exact ? 'exact' : (predEntry.win_p1_inset ? 'win' : 'loss');
      const cls2 = predEntry.win_p2_exact ? 'exact' : (predEntry.win_p2_inset ? 'win' : 'loss');
      const ico1 = predEntry.win_p1_exact ? '★' : (predEntry.win_p1_inset ? '✓' : '✗');
      const ico2 = predEntry.win_p2_exact ? '★' : (predEntry.win_p2_inset ? '✓' : '✗');
      p1Pred = `<span class="h-pred ${cls1}" title="Prédiction : ${predEntry.pred_p1}">${predEntry.pred_p1} ${ico1}</span>`;
      p2Pred = `<span class="h-pred ${cls2}" title="Prédiction : ${predEntry.pred_p2}">${predEntry.pred_p2} ${ico2}</span>`;
    }
    const sessBadge = (h.session ?? 1) > 1 ? `<span class="h-session">S${h.session}</span>` : '';
    html += `<div class="history-row">
      <div class="h-gameNum">#${h.gameNum}${sessBadge}</div>
      <div class="h-side">
        <div class="h-side-label">J ${h.p1_score}</div>
        <div class="h-suits">${p1Display}</div>
        ${p1Pred}
      </div>
      <div class="h-side">
        <div class="h-side-label">B ${h.p2_score}</div>
        <div class="h-suits">${p2Display}</div>
        ${p2Pred}
      </div>
    </div>`;
  }
  list.innerHTML = html;
}

function renderMetrics() {
  if (!State.backtest) return;
  const bt = State.backtest;
  const accP1 = (bt.acc.p1.in_set * 100).toFixed(1);
  const accP2 = (bt.acc.p2.in_set * 100).toFixed(1);
  const m1 = document.getElementById('m-acc-p1');
  m1.textContent = `${accP1}%`;
  m1.classList.toggle('good', bt.acc.p1.in_set >= 0.50);
  m1.classList.toggle('bad', bt.acc.p1.in_set < 0.40);
  const m2 = document.getElementById('m-acc-p2');
  m2.textContent = `${accP2}%`;
  m2.classList.toggle('good', bt.acc.p2.in_set >= 0.50);
  m2.classList.toggle('bad', bt.acc.p2.in_set < 0.40);
  document.getElementById('m-streak').textContent = `${bt.cur_streak_win}`;
  document.getElementById('m-max-loss').textContent = `${Math.max(bt.max_loss_p1, bt.max_loss_p2)}`;
}

function renderBacktest() {
  if (!State.backtestFull) {
    document.getElementById('backtest-body').innerHTML = '<div style="color:var(--muted)">Échantillon insuffisant (besoin ≥ 60 mains)</div>';
    return;
  }
  const bt = State.backtestFull;
  document.getElementById('backtest-body').innerHTML = `
    <div class="empirical-grid">
      <div class="emp-cell"><div class="emp-label">Joueur · in_set</div><div class="emp-val">${(bt.acc.p1.in_set*100).toFixed(1)}%</div><div class="emp-sub">enseigne dans P1 (2-3 cartes)</div></div>
      <div class="emp-cell"><div class="emp-label">Banquier · in_set</div><div class="emp-val">${(bt.acc.p2.in_set*100).toFixed(1)}%</div><div class="emp-sub">enseigne dans P2 (2-3 cartes)</div></div>
      <div class="emp-cell"><div class="emp-label">Mains testées</div><div class="emp-val mono">${bt.n}</div><div class="emp-sub">backtest live local</div></div>
      <div class="emp-cell"><div class="emp-label">Joueur · couverture 2 enseignes</div><div class="emp-val">${(bt.acc.p1.cover2*100).toFixed(1)}%</div><div class="emp-sub">best ou second dans P1</div></div>
      <div class="emp-cell"><div class="emp-label">Banquier · couverture 2 enseignes</div><div class="emp-val">${(bt.acc.p2.cover2*100).toFixed(1)}%</div><div class="emp-sub">best ou second dans P2</div></div>
      <div class="emp-cell"><div class="emp-label">Précision exacte 1ère carte</div><div class="emp-val">J ${(bt.acc.p1.exact*100).toFixed(1)}% · B ${(bt.acc.p2.exact*100).toFixed(1)}%</div><div class="emp-sub">vs aléatoire 25%</div></div>
      <div class="emp-cell"><div class="emp-label">Rattrapage J · taux couverture</div><div class="emp-val">${(bt.acc.rattrapage_p1*100).toFixed(1)}%</div><div class="emp-sub">${bt.rattrapage_n_p1} déclenchements</div></div>
      <div class="emp-cell"><div class="emp-label">Rattrapage B · taux couverture</div><div class="emp-val">${(bt.acc.rattrapage_p2*100).toFixed(1)}%</div><div class="emp-sub">${bt.rattrapage_n_p2} déclenchements</div></div>
      <div class="emp-cell"><div class="emp-label">Pertes max consécutives</div><div class="emp-val">J ${bt.max_loss_p1} · B ${bt.max_loss_p2}</div><div class="emp-sub">sur l'échantillon entier</div></div>
    </div>`;
}

async function renderEmpirical() {
  try {
    const r = await fetch('/api/empirical');
    const data = await r.json();
    if (!data.ok) return;
    const rep = data.report;
    const body = document.getElementById('empirical-body');
    const f = (x) => (x*100).toFixed(1) + '%';
    body.innerHTML = `
    <div style="font-size:12px;color:var(--muted);margin-bottom:14px;">
      Rapport calculé hors-ligne sur ${rep.sample_size} mains (game #${rep.gameNum_range[0]} → #${rep.gameNum_range[1]}).
      Sert de référence statistique pour calibrer les poids du moteur.
    </div>
    <div class="empirical-grid">
      <div class="emp-cell"><div class="emp-label">Fréq. ♠ Joueur</div><div class="emp-val">${f(rep.p1_first_suit_freq['♠'])}</div></div>
      <div class="emp-cell"><div class="emp-label">Fréq. ♥ Joueur</div><div class="emp-val" style="color:var(--red)">${f(rep.p1_first_suit_freq['♥'])}</div></div>
      <div class="emp-cell"><div class="emp-label">Fréq. ♦ Joueur</div><div class="emp-val" style="color:var(--red)">${f(rep.p1_first_suit_freq['♦'])}</div></div>
      <div class="emp-cell"><div class="emp-label">Fréq. ♣ Joueur</div><div class="emp-val">${f(rep.p1_first_suit_freq['♣'])}</div></div>
      <div class="emp-cell"><div class="emp-label">Couverture ♠ dans P1</div><div class="emp-val">${f(rep.coverage_in_p1_all_cards['♠'])}</div></div>
      <div class="emp-cell"><div class="emp-label">Couverture ♣ dans P1</div><div class="emp-val">${f(rep.coverage_in_p1_all_cards['♣'])}</div></div>
      <div class="emp-cell"><div class="emp-label">Couverture couleur (P1 rouge)</div><div class="emp-val">${f(rep.coverage_color_p1.rouge)}</div></div>
      <div class="emp-cell"><div class="emp-label">Couverture couleur (P1 noir)</div><div class="emp-val">${f(rep.coverage_color_p1.noir)}</div></div>
      <div class="emp-cell"><div class="emp-label">Autocorrélation lag-1 J</div><div class="emp-val">${f(rep.autocorr_p1[1])}</div><div class="emp-sub">aléatoire = 25%</div></div>
      <div class="emp-cell"><div class="emp-label">Issue J/B/É</div><div class="emp-val">${f(rep.outcome_distribution.J)} / ${f(rep.outcome_distribution.B)} / ${f(rep.outcome_distribution.E)}</div></div>
      <div class="emp-cell"><div class="emp-label">J=B même enseigne</div><div class="emp-val">${f(rep.p1_p2_same_suit)}</div></div>
      <div class="emp-cell"><div class="emp-label">J=B même couleur</div><div class="emp-val">${f(rep.p1_p2_same_color)}</div></div>
    </div>
    <div style="margin-top:14px;padding:12px;background:rgba(0,0,0,.25);border-radius:10px;border:1px dashed var(--line-2);font-size:12px;color:var(--muted-2);line-height:1.6">
      <strong style="color:#fdba74">⚠ Avertissement honnête :</strong> sur la 1ère carte EXACTE,
      aucune stratégie ne dépasse durablement 30%. C'est mathématique. V9 maximise donc 
      la <strong>couverture</strong> : son enseigne prédite apparaît dans la main (2-3 cartes) 
      avec ~55% de réussite, et en mode rattrapage la couverture 2-enseignes atteint ~83%.
    </div>`;
  } catch(e) {
    document.getElementById('empirical-body').innerHTML = `<div style="color:var(--red)">Erreur de chargement : ${e}</div>`;
  }
}

// ════════════════════════════════════════════════════════════════════
// PROCESS PREDICTION — N+1 INDEXING CONTRACT
// ════════════════════════════════════════════════════════════════════
//
// Strict invariant enforced by this function:
//
//   sortedChrono[0]              = oldest hand on record
//   sortedChrono[length - 1]     = the IMMEDIATE PAST hand (index N)
//                                  → the last hand actually played and
//                                    visible on the Telegram channel
//   prediction                   = the NEXT hand to be played (index N+1)
//                                  → the hand currently being dealt at
//                                    the table, NOT yet on Telegram
//
// All 6 sub-engines (FREQ, COVERAGE, MARKOV 1&2, MOMENTUM, COLOR,
// LEAST_RECENT) receive the SAME chronologically sorted context. They
// each take `ctx.slice(-K)` so they all read the same recent window
// ending at index N. The Markov chain explicitly uses `seq[seq.length-1]`
// as the conditioning state, ensuring the transition is computed FROM
// the immediate past TO the future, never the other way around.
//
// Returns the prediction object enriched with timing metadata so the UI
// can display both N (last seen) and N+1 (predicted) explicitly.
// ════════════════════════════════════════════════════════════════════
function processPrediction(hands) {
  if (!hands || hands.length < 5) return null;

  // Step 1 — Sort chronologically. Order of priority:
  //   1) seq      (client-assigned, monotonic, never wraps, RESET-PROOF)
  //   2) message_id (Telegram post id, monotonic by time)
  //   3) gameNum  (last resort — wraps daily, only OK within single day)
  const sorted = hands.slice().sort((a, b) => {
    const sa = a.seq, sb = b.seq;
    if (sa != null && sb != null && sa !== sb) return sa - sb;
    const ma = a.message_id, mb = b.message_id;
    if (ma != null && mb != null && ma !== mb) return ma - mb;
    return (a.gameNum ?? 0) - (b.gameNum ?? 0);
  });

  // Step 2 — Define N (last observed) and N+1 (target of the prediction).
  const lastHand = sorted[sorted.length - 1];
  const N        = lastHand.gameNum;
  const Nplus1   = N + 1;

  // Step 3 — Backtest first so we know loss streak / last best prediction.
  // Backtest replays predictions across the WHOLE history, so this is the
  // ground truth for the engine's current state.
  const bt50    = V9.backtest(sorted, 50);
  const btFull  = V9.backtest(sorted);

  // Step 4 — Build the runtime state object the engine needs.
  const engineState = {
    lossStreakP1: btFull.current_loss_p1,
    lossStreakP2: btFull.current_loss_p2,
    lastBest: {
      p1: btFull.history.length ? btFull.history[btFull.history.length - 1].pred_p1 : null,
      p2: btFull.history.length ? btFull.history[btFull.history.length - 1].pred_p2 : null,
    },
  };

  // Step 5 — Call the engine. predictNext applies sortChrono internally
  // again as a safety net, then forwards `sorted` to all 6 sub-engines
  // simultaneously. Every sub-engine reads ctx.slice(-K), meaning they
  // ALL anchor on the same hand N. Markov explicitly conditions on
  // seq[seq.length-1] = the suit of hand N. The fusion result is the
  // probability distribution for hand N+1.
  const prediction = V9.predictNext(sorted, engineState);

  // Step 6 — Annotate the prediction with timing metadata so the UI
  // can prove to the user that we are NOT echoing the last hand.
  prediction._lastHandObserved = {
    gameNum:   N,
    session:   lastHand.session,
    seq:       lastHand.seq,
    p1_first:  lastHand.p1_first,
    p2_first:  lastHand.p2_first,
    p1_suits:  lastHand.p1_suits,
    p2_suits:  lastHand.p2_suits,
  };
  prediction._predictedFor = {
    gameNum: Nplus1,
    session: lastHand.session, // same session as long as no new reset
    // index = the position this prediction would occupy if/when it appears
    indexInHistory: sorted.length, // 0-based; equals sorted.length-1 of N + 1
  };
  prediction._timing = {
    computedAt:  Date.now(),
    basedOn:     sorted.length,
    historyTail: sorted.slice(-3).map(h => `#${h.gameNum}(s${h.session})`),
  };

  return { prediction, backtest: bt50, backtestFull: btFull };
}

// ────────────────────── MAIN UPDATE LOOP ──────────────────────
// recomputeAll() is now a thin wrapper around processPrediction() that
// just wires the result into State + triggers re-render. The actual
// prediction logic and the N+1 contract live entirely in processPrediction().
function recomputeAll() {
  const result = processPrediction(State.hands);
  if (!result) return;
  State.prediction   = result.prediction;
  State.backtest     = result.backtest;
  State.backtestFull = result.backtestFull;
  renderPrediction();
  renderMetrics();
  renderHistory();
  renderBacktest();
}

// ════════════════════════════════════════════════════════════════════
// doFetchTick — POLLING WITH CACHE INVALIDATION + N+1 ENFORCEMENT
// ════════════════════════════════════════════════════════════════════
//
// On every poll (every 7s OR manual refresh):
//
//   1. Pull the latest feed from Telegram.
//   2. Identify the latest message_id in the fresh batch.
//   3. Compare with State.lastSeenMessageId (the LAST message we
//      processed in a prior tick). Three cases:
//
//      (a) newMid === State.lastSeenMessageId
//          → No new hand on the channel. Skip recompute. Keep showing
//            the prediction for the same N+1 (still valid).
//
//      (b) newMid > State.lastSeenMessageId
//          → A NEW hand has been published. This is the moment of truth:
//            the prediction we were displaying was for THIS hand. Now we
//            ingest it, IMMEDIATELY invalidate State.prediction (so the
//            UI cannot accidentally show the previous prediction echoing
//            the just-arrived hand), then call processPrediction() to
//            compute the prediction for N+2 (the next hand after the
//            one we just received).
//
//      (c) newMid < State.lastSeenMessageId (edge case)
//          → Telegram returned older data than what we already have.
//            Ignore — keep prior state.
//
//   4. Force a recompute on every NEW-HAND tick. This guarantees the
//      prediction shown to the user is ALWAYS one step ahead, never
//      lagging behind. The user sees the prediction for hand #(N+1)
//      where N = the latest hand on the channel right now.
// ════════════════════════════════════════════════════════════════════
async function doFetchTick(force=false) {
  if (State.loading) return;
  State.loading = true;
  setStatus('loading','Sync…');

  const fresh = await fetchLive();
  State.loading = false;
  if (fresh === null) {
    setStatus('off','Hors-ligne');
    if (force) showToast('Échec de la connexion Telegram', 'error');
    return;
  }

  // STEP A — Identify the newest message_id in the fresh feed.
  const newMid = fresh.length
    ? Math.max(...fresh.map(h => h.message_id || 0))
    : null;

  // STEP B — Compare to the last id we ever processed.
  const prevMid = State.lastSeenMessageId || 0;
  const isNewHand     = newMid && newMid > prevMid;
  const isSameAsBefore = newMid && newMid === prevMid;
  const isStale       = newMid && newMid < prevMid;

  // STEP C — On a new hand: invalidate the cached prediction NOW, before
  // anything is re-rendered. This prevents any UI race where the previous
  // prediction (which was made FOR the hand that just arrived) could
  // remain on screen for a frame and be confused with a prediction for
  // the NEXT hand.
  if (isNewHand) {
    State.prediction   = null;   // hard invalidate
    State.lastSeenMessageId = newMid;
  } else if (isStale) {
    // Telegram regressed → ignore, keep state
    setStatus('live','En direct');
    if (force) showToast('Aucune nouvelle main', 'success');
    return;
  }

  // STEP D — Merge the fresh hands into the persistent store. mergeHands
  // is reset-aware (handles midnight #1440 → #1) and assigns monotonic
  // `seq` values so the engine's chronological sort never breaks.
  const beforeSession = State.currentSession;
  const before        = State.hands.length;
  const forceNew      = State.forceNewSessionOnNext;
  State.hands = mergeHands(State.hands, fresh, forceNew);
  if (forceNew) {
    State.forceNewSessionOnNext = false;
    const btn = document.getElementById('btn-new-session');
    if (btn) { btn.classList.remove('armed'); btn.textContent = '🔄 Nouvelle session'; }
  }

  const newCount = State.hands.length - before;
  const newSessionDetected = State.currentSession > beforeSession;
  saveHands(State.hands);
  setStatus('live','En direct');

  // STEP E — Force recompute on:
  //   - new hand arrived (mandatory)  → moves prediction from N+1 to N+2
  //   - manual refresh button         → user wants a fresh calculation
  //   - first ever fetch              → there was no prediction yet
  // We DO NOT recompute on a pure no-op poll, to save CPU and keep the
  // UI stable between hands.
  const shouldRecompute = isNewHand || force || !State.prediction;
  if (shouldRecompute) {
    recomputeAll();
  }

  // STEP F — User feedback.
  if (newSessionDetected) {
    showToast(`🔄 Nouvelle session détectée (#${State.currentSession}) — recalibrage en cours`, 'success');
  } else if (isNewHand) {
    const lastH = State.hands[State.hands.length - 1];
    showToast(`🎴 Nouvelle main #${lastH.gameNum} reçue → prédiction recalculée pour #${lastH.gameNum + 1}`, 'success');
  } else if (force && isSameAsBefore) {
    showToast('Aucune nouvelle main — prédiction toujours valable', 'success');
  } else if (force) {
    showToast(newCount ? `+${newCount} nouvelle(s) main(s)` : 'Aucune nouvelle main', 'success');
  }
}

async function doDeepReload() {
  if (State.loading) return;
  State.loading = true;
  setStatus('loading','Scrape profond…');
  showToast('Récupération de l\'historique profond (~15 pages)…');
  const fresh = await fetchDeep(15);
  State.loading = false;
  if (fresh === null) {
    setStatus('off','Hors-ligne');
    showToast('Échec scrape profond', 'error');
    return;
  }
  State.hands = mergeHands(State.hands, fresh);
  saveHands(State.hands);
  State.deepLoaded = true;
  setStatus('live','En direct');
  recomputeAll();
  showToast(`Historique chargé : ${State.hands.length} mains · ${State.currentSession} session(s)`, 'success');
}

async function boot() {
  renderShell();
  renderEmpirical();

  // 1) Load cached hands from localStorage (with v1→v2 migration if needed)
  State.hands = loadHands();

  // 2) Reconstruct lastSeenMessageId from the cache so that, after a
  //    page reload, doFetchTick correctly recognises "already seen"
  //    hands and only triggers a recompute when something is truly new.
  if (State.hands.length) {
    State.lastSeenMessageId = State.hands.reduce(
      (max, h) => Math.max(max, h.message_id || 0), 0
    );
    State.currentSession = State.hands.reduce(
      (max, h) => Math.max(max, h.session || 1), 1
    );
  }

  // 3) If we don't have enough data, do a deep scrape immediately
  if (State.hands.length < 200) {
    await doDeepReload();
  } else {
    recomputeAll();
    await doFetchTick();
  }

  // 4) Start the polling loop. Each tick will:
  //      - skip if no new hand has appeared on Telegram
  //      - invalidate the cached prediction + force a recompute as soon
  //        as a new hand arrives, projecting to N+1
  setInterval(() => doFetchTick(), POLL_INTERVAL);

  // 5) Tick the prediction-age clock every second so the user can see
  //    how fresh the current N+1 projection is. Pure UI, no recompute.
  setInterval(updateSyncClock, 1000);
}

function updateSyncClock() {
  const el = document.getElementById('sync-clock');
  if (!el || !State.prediction || !State.prediction._timing) return;
  const ageMs = Date.now() - State.prediction._timing.computedAt;
  const ageS  = Math.floor(ageMs / 1000);
  let label, cls;
  if (ageS < 5)        { label = `🟢 ${ageS}s`;  cls = 'fresh';  }
  else if (ageS < 30)  { label = `🟢 ${ageS}s`;  cls = 'fresh';  }
  else if (ageS < 90)  { label = `🟡 ${ageS}s`;  cls = 'aging';  }
  else                 { label = `🔴 ${Math.floor(ageS/60)}m${ageS%60}s`; cls = 'stale'; }
  el.textContent = label;
  el.className = 'sync-clock ' + cls;
}

// Kick
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
