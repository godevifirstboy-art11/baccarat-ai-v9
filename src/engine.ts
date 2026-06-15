/**
 * Moteur V9 Ultra C — version TypeScript serveur.
 * 100% identique au moteur frontend (public/static/engine.js).
 * Poids issus du backtest sur 915 mains réelles (voir analysis/best_weights_*.json).
 */

export type Card = { val: string; suit: string }
export type Hand = {
  gameNum: number
  p1: Card[]
  p2: Card[]
  p1_score: number
  p2_score: number
  p1_first: string
  p2_first: string
  p1_suits: string[]
  p2_suits: string[]
  outcome: 'J' | 'B' | 'E'
  raw: string
  message_id?: number
  has_retirage?: boolean
  tValue?: number | null
}

export type Distribution = Record<string, number>
export type Prediction = {
  best: string
  second: string
  confidence: number
  distribution: Distribution
  engines: Record<string, Distribution>
  mode: 'normal' | 'rattrapage'
}

const SUITS = ['♠', '♥', '♦', '♣']
const RED = new Set(['♥', '♦'])

const WEIGHTS = {
  p1: { freq: 0.237, coverage: 0.041, markov: 0.448, momentum: 0.024, color: 0.171, least_recent: 0.080 },
  p2: { freq: 0.026, coverage: 0.284, markov: 0.427, momentum: 0.110, color: 0.039, least_recent: 0.114 },
}

const norm = (d: Distribution): Distribution => {
  const s = SUITS.reduce((a, k) => a + (d[k] || 0), 0) || 1
  const o: Distribution = {}
  for (const k of SUITS) o[k] = (d[k] || 0) / s
  return o
}

function engineFreq(ctx: Hand[], side: 'p1' | 'p2', K = 20, decay = 0.95): Distribution {
  const cnt: Distribution = { '♠': 0, '♥': 0, '♦': 0, '♣': 0 }
  const slice = ctx.slice(-K)
  slice.forEach((h, i) => {
    const w = Math.pow(decay, K - i - 1)
    const s = h[`${side}_first` as 'p1_first' | 'p2_first']
    cnt[s] = (cnt[s] || 0) + w
  })
  return norm(cnt)
}

function engineCoverage(ctx: Hand[], side: 'p1' | 'p2', K = 25, decay = 0.95): Distribution {
  const cnt: Distribution = { '♠': 0, '♥': 0, '♦': 0, '♣': 0 }
  const slice = ctx.slice(-K)
  slice.forEach((h, i) => {
    const w = Math.pow(decay, K - i - 1)
    const suits = new Set(h[`${side}_suits` as 'p1_suits' | 'p2_suits'])
    for (const s of suits) cnt[s] = (cnt[s] || 0) + w
  })
  return norm(cnt)
}

function engineMarkov(ctx: Hand[], side: 'p1' | 'p2', lastN = 200): Distribution {
  const seq = ctx.slice(-lastN).map(h => h[`${side}_first` as 'p1_first' | 'p2_first'])
  if (seq.length < 5) return { '♠': 0.25, '♥': 0.25, '♦': 0.25, '♣': 0.25 }
  const last = seq[seq.length - 1]
  const last2 = seq.length > 1 ? seq[seq.length - 2] : last
  const m1: Distribution = { '♠': 0, '♥': 0, '♦': 0, '♣': 0 }
  const m2: Distribution = { '♠': 0, '♥': 0, '♦': 0, '♣': 0 }
  for (let i = 1; i < seq.length; i++) if (seq[i - 1] === last) m1[seq[i]]++
  for (let i = 2; i < seq.length; i++) if (seq[i - 2] === last2 && seq[i - 1] === last) m2[seq[i]]++
  const n1 = SUITS.reduce((a, s) => a + m1[s], 0) || 1
  const n2 = SUITS.reduce((a, s) => a + m2[s], 0) || 1
  const out: Distribution = {}
  for (const s of SUITS) {
    out[s] = n2 > 3 ? 0.5 * (m1[s] / n1) + 0.5 * (m2[s] / n2) : m1[s] / n1
    out[s] += 0.05 // Laplace
  }
  return norm(out)
}

function engineMomentum(ctx: Hand[], side: 'p1' | 'p2'): Distribution {
  if (ctx.length < 5) return { '♠': 0.25, '♥': 0.25, '♦': 0.25, '♣': 0.25 }
  const seq = ctx.slice(-7).map(h => h[`${side}_first` as 'p1_first' | 'p2_first'])
  const c: Record<string, number> = {}
  for (const s of seq) c[s] = (c[s] || 0) + 1
  const base: Distribution = { '♠': 0.20, '♥': 0.20, '♦': 0.20, '♣': 0.20 }
  for (const s of SUITS) {
    const n = c[s] || 0
    if (n >= 3) base[s] += 0.30
    else if (n >= 2) base[s] += 0.10
  }
  const last = seq[seq.length - 1]
  base[last] *= 0.85
  return norm(base)
}

function engineColorGuard(ctx: Hand[], side: 'p1' | 'p2', K = 15): Distribution {
  if (ctx.length < K) return { '♠': 0.25, '♥': 0.25, '♦': 0.25, '♣': 0.25 }
  const seq = ctx.slice(-K).map(h => h[`${side}_first` as 'p1_first' | 'p2_first'])
  const nRed = seq.filter(s => RED.has(s)).length
  const redPref = nRed / K
  const out: Distribution = {}
  for (const s of SUITS) out[s] = RED.has(s) ? 0.5 * redPref : 0.5 * (1 - redPref)
  return norm(out)
}

function engineLeastRecent(ctx: Hand[], side: 'p1' | 'p2', K = 10): Distribution {
  if (ctx.length < K) return { '♠': 0.25, '♥': 0.25, '♦': 0.25, '♣': 0.25 }
  const seq = ctx.slice(-K).map(h => h[`${side}_first` as 'p1_first' | 'p2_first'])
  const c: Record<string, number> = { '♠': 0, '♥': 0, '♦': 0, '♣': 0 }
  for (const s of seq) c[s] = (c[s] || 0) + 1
  const inv: Distribution = {}
  for (const s of SUITS) inv[s] = 1.0 / (1 + c[s])
  return norm(inv)
}

export function predictSide(ctx: Hand[], side: 'p1' | 'p2', mode: 'normal' | 'rattrapage' = 'normal'): Prediction {
  const engines = {
    freq: engineFreq(ctx, side),
    coverage: engineCoverage(ctx, side),
    markov: engineMarkov(ctx, side),
    momentum: engineMomentum(ctx, side),
    color: engineColorGuard(ctx, side),
    least_recent: engineLeastRecent(ctx, side),
  }
  const w = WEIGHTS[side]
  let fused: Distribution = { '♠': 0, '♥': 0, '♦': 0, '♣': 0 }
  for (const [name, dist] of Object.entries(engines)) {
    const ww = (w as any)[name] || 0
    for (const s of SUITS) fused[s] += ww * dist[s]
  }
  fused = norm(fused)
  if (mode === 'rattrapage') {
    const cov = engineCoverage(ctx, side, 30)
    for (const s of SUITS) fused[s] = 0.4 * fused[s] + 0.6 * cov[s]
    fused = norm(fused)
  }
  const sorted = [...SUITS].sort((a, b) => fused[b] - fused[a])
  return {
    best: sorted[0],
    second: sorted[1],
    confidence: fused[sorted[0]],
    distribution: fused,
    engines,
    mode,
  }
}

export const ENGINE_V9 = {
  predictNextHand(hands: Hand[]): { player: Prediction; banker: Prediction; gameNumNext: number | null; basedOn: number } {
    const sorted = [...hands].sort((a, b) => a.gameNum - b.gameNum)
    return {
      player: predictSide(sorted, 'p1', 'normal'),
      banker: predictSide(sorted, 'p2', 'normal'),
      gameNumNext: sorted.length ? sorted[sorted.length - 1].gameNum + 1 : null,
      basedOn: sorted.length,
    }
  },
  WEIGHTS,
}
