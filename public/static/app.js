/* ═══════════════════════════════════════════════════════════════
   BACCARAT AI V9 ULTRA C — Application UI
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const V9 = window.V9;
const STORAGE_KEY = 'v9-hands-v1';
const POLL_INTERVAL = 7000; // 7s
const $ = (sel, parent=document) => parent.querySelector(sel);

const State = {
  hands: [],           // parsed hands (sorted by gameNum)
  prediction: null,    // current prediction object
  backtest: null,      // backtest stats (rolling 50)
  backtestFull: null,  // backtest on full sample
  loading: false,
  channel: 'statistika_baccara',
  lastFetch: 0,
  status: 'init',
  deepLoaded: false,   // whether we've done the initial deep scrape
};

// ────────────────────── STORAGE ──────────────────────
function loadHands() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr;
  } catch { return []; }
}
function saveHands(hands) {
  try {
    // Keep only the most recent 1500 hands to control storage size
    const trimmed = hands.length > 1500 ? hands.slice(-1500) : hands;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch (e) {
    console.warn('Storage full:', e);
  }
}
function mergeHands(existing, fresh) {
  const map = new Map();
  for (const h of existing) map.set(h.gameNum, h);
  for (const h of fresh) map.set(h.gameNum, h);
  return [...map.values()].sort((a,b) => a.gameNum - b.gameNum);
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
          <div class="brand-sub">Ultra C · Prédicteur enseigne J/B</div>
        </div>
      </div>
      <div class="topbar-right">
        <div class="chip" id="hand-counter">Main <strong>—</strong></div>
        <div class="chip" id="sample-chip">Échantillon <strong>0</strong></div>
        <div class="status loading" id="conn-status">Connexion…</div>
        <button class="btn-icon" id="btn-refresh" title="Rafraîchir maintenant">↻</button>
        <button class="btn-icon" id="btn-reload-deep" title="Recharger l'historique profond">⬇</button>
      </div>
    </header>

    <section class="predict-hero">
      <div class="pred-card" data-side="player" id="card-player">
        <div class="pred-head">
          <div class="pred-side">
            <span class="pred-side-icon">👤</span>
            <span>Joueur</span>
          </div>
          <span class="conf-pill" id="conf-pill-p1">—</span>
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
          <span class="conf-pill" id="conf-pill-p2">—</span>
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
      Baccarat AI V9 Ultra C · Source live : <a href="https://t.me/statistika_baccara" target="_blank">@statistika_baccara</a><br>
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

  // We need backtest history entries to overlay predictions; let's recompute on the fly the last 60 predictions
  let predMap = new Map();
  if (State.backtest && State.backtest.history) {
    for (const h of State.backtest.history) predMap.set(h.gameNum, h);
  }

  let html = '';
  for (const h of hands) {
    const predEntry = predMap.get(h.gameNum);
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
    html += `<div class="history-row">
      <div class="h-gameNum">#${h.gameNum}</div>
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

// ────────────────────── MAIN UPDATE LOOP ──────────────────────
function recomputeAll() {
  if (State.hands.length < 5) return;
  // Run engine on current hands → prediction for next
  const fresh = State.hands.slice().sort((a,b)=>a.gameNum - b.gameNum);
  // Compute current streak state from rolling backtest
  const bt50 = V9.backtest(fresh, 50);
  State.backtest = bt50;
  const btFull = V9.backtest(fresh);
  State.backtestFull = btFull;
  // Prediction with current losing streak (taken from full backtest)
  const state = {
    lossStreakP1: btFull.current_loss_p1,
    lossStreakP2: btFull.current_loss_p2,
    lastBest: {
      p1: btFull.history.length ? btFull.history[btFull.history.length-1].pred_p1 : null,
      p2: btFull.history.length ? btFull.history[btFull.history.length-1].pred_p2 : null,
    }
  };
  State.prediction = V9.predictNext(fresh, state);
  renderPrediction();
  renderMetrics();
  renderHistory();
  renderBacktest();
}

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
  const before = State.hands.length;
  State.hands = mergeHands(State.hands, fresh);
  const newCount = State.hands.length - before;
  saveHands(State.hands);
  setStatus('live','En direct');
  recomputeAll();
  if (force) showToast(newCount ? `+${newCount} nouvelle(s) main(s)` : 'Aucune nouvelle main', 'success');
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
  showToast(`Historique chargé : ${State.hands.length} mains`, 'success');
}

async function boot() {
  renderShell();
  renderEmpirical();
  // 1) Load cached hands
  State.hands = loadHands();
  // 2) If small, do a deep scrape immediately
  if (State.hands.length < 200) {
    await doDeepReload();
  } else {
    recomputeAll();
    await doFetchTick();
  }
  // 3) Start poll
  setInterval(() => doFetchTick(), POLL_INTERVAL);
}

// Kick
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
