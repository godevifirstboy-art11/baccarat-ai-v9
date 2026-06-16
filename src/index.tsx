/**
 * BACCARAT AI V9 ULTRA C — backend Hono
 *
 * Responsabilités :
 *  - GET /api/telegram?before=ID&channel=...  → proxy + parse t.me/s/{channel}
 *  - GET /api/telegram/feed                   → agrège plusieurs pages (jusqu'à 60 mains)
 *  - GET /api/telegram/deep?pages=N           → scrape profond (pagination, jusqu'à 800+ mains)
 *  - GET /api/predict                          → exécute le moteur V9 côté serveur (debug)
 *  - GET /api/empirical                        → renvoie le rapport empirique embarqué
 *  - GET /                                     → SPA
 *
 * Aucune dépendance Node — full Web API + fetch.
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { ENGINE_V9 } from './engine'
import { EMPIRICAL_REPORT } from './empirical'

const app = new Hono()
app.use('/api/*', cors())

// ────────────────────────────────────────────────────────────────
// Telegram scraping (t.me/s/ — public preview, sans token)
// ────────────────────────────────────────────────────────────────

const DEFAULT_CHANNEL = 'statistika_baccara'
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

type RawMessage = { channel: string; message_id: number; raw: string; gameNum: number }

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
}

function parseTelegramHtml(html: string, channel: string): RawMessage[] {
  const out: RawMessage[] = []
  // Split on each tgme_widget_message block
  const blocks = html.split(/(?=class="tgme_widget_message[ "])/g)
  for (const block of blocks) {
    const mPost = block.match(/data-post="([^"/]+)\/(\d+)"/)
    if (!mPost) continue
    const channelInBlock = mPost[1]
    if (channelInBlock !== channel) continue
    const mid = parseInt(mPost[2], 10)
    const mText = block.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/)
    if (!mText) continue
    const raw = stripTags(mText[1])
    if (!raw.includes('#N') || !raw.includes('(')) continue
    const mNum = raw.match(/#N\s*(\d+)/)
    if (!mNum) continue
    out.push({
      channel,
      message_id: mid,
      raw,
      gameNum: parseInt(mNum[1], 10),
    })
  }
  return out
}

async function fetchTelegramPage(channel: string, before?: number): Promise<RawMessage[]> {
  const url = before
    ? `https://t.me/s/${channel}?before=${before}`
    : `https://t.me/s/${channel}`
  const resp = await fetch(url, {
    headers: { 'User-Agent': UA },
    // @ts-ignore — Cloudflare cache hint
    cf: { cacheTtl: 5, cacheEverything: true },
  })
  if (!resp.ok) throw new Error(`Telegram ${resp.status}`)
  const html = await resp.text()
  return parseTelegramHtml(html, channel)
}

app.get('/api/telegram', async (c) => {
  const channel = c.req.query('channel') || DEFAULT_CHANNEL
  const before = c.req.query('before')
  try {
    const msgs = await fetchTelegramPage(channel, before ? parseInt(before, 10) : undefined)
    return c.json({ ok: true, channel, count: msgs.length, hands: msgs, fetchedAt: Date.now() })
  } catch (e: any) {
    return c.json({ ok: false, error: String(e) }, 502)
  }
})

/**
 * /api/telegram/feed — agrège 3 pages (60 mains) pour le mode "live".
 * Idéal pour le polling régulier côté UI.
 */
app.get('/api/telegram/feed', async (c) => {
  const channel = c.req.query('channel') || DEFAULT_CHANNEL
  try {
    const page1 = await fetchTelegramPage(channel)
    if (page1.length === 0) return c.json({ ok: true, channel, count: 0, hands: [] })
    const oldestMid = Math.min(...page1.map(m => m.message_id))
    const page2 = await fetchTelegramPage(channel, oldestMid).catch(() => [])
    const oldestMid2 = page2.length ? Math.min(...page2.map(m => m.message_id)) : oldestMid
    const page3 = page2.length ? await fetchTelegramPage(channel, oldestMid2).catch(() => []) : []
    const all = [...page1, ...page2, ...page3]
    const byGame = new Map<number, RawMessage>()
    for (const m of all) {
      const ex = byGame.get(m.gameNum)
      if (!ex || m.message_id > ex.message_id) byGame.set(m.gameNum, m)
    }
    const sorted = [...byGame.values()].sort((a, b) => a.gameNum - b.gameNum)
    return c.json({ ok: true, channel, count: sorted.length, hands: sorted, fetchedAt: Date.now() })
  } catch (e: any) {
    return c.json({ ok: false, error: String(e) }, 502)
  }
})

/**
 * /api/telegram/deep?pages=N — scrape profond pour reconstruire l'historique.
 * Limité à 50 pages (1000 messages) pour respecter les limites Worker (CPU/temps).
 */
app.get('/api/telegram/deep', async (c) => {
  const channel = c.req.query('channel') || DEFAULT_CHANNEL
  const pages = Math.max(1, Math.min(50, parseInt(c.req.query('pages') || '15', 10)))
  try {
    const all = new Map<number, RawMessage>()
    let before: number | undefined = undefined
    let lastMin: number | undefined = undefined
    for (let i = 0; i < pages; i++) {
      const page = await fetchTelegramPage(channel, before)
      if (page.length === 0) break
      const minMid = Math.min(...page.map(m => m.message_id))
      for (const m of page) {
        const ex = all.get(m.gameNum)
        if (!ex || m.message_id > ex.message_id) all.set(m.gameNum, m)
      }
      if (lastMin !== undefined && minMid >= lastMin) break // no progress
      lastMin = minMid
      before = minMid
    }
    const sorted = [...all.values()].sort((a, b) => a.gameNum - b.gameNum)
    return c.json({ ok: true, channel, pages, count: sorted.length, hands: sorted, fetchedAt: Date.now() })
  } catch (e: any) {
    return c.json({ ok: false, error: String(e) }, 502)
  }
})

// ────────────────────────────────────────────────────────────────
// Prédiction côté serveur (peut être appelée pour debug ou si le client veut éviter de calculer)
// ────────────────────────────────────────────────────────────────

app.post('/api/predict', async (c) => {
  try {
    const body = await c.req.json()
    const hands = Array.isArray(body?.hands) ? body.hands : []
    const result = ENGINE_V9.predictNextHand(hands)
    return c.json({ ok: true, result })
  } catch (e: any) {
    return c.json({ ok: false, error: String(e) }, 400)
  }
})

app.get('/api/empirical', (c) => c.json({ ok: true, report: EMPIRICAL_REPORT }))

app.get('/api/health', (c) => c.json({ ok: true, version: 'V9-UltraC', ts: Date.now() }))

// ────────────────────────────────────────────────────────────────
// SPA shell
// ────────────────────────────────────────────────────────────────

app.get('/', (c) => c.html(SHELL_HTML))

const SHELL_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0,viewport-fit=cover"/>
<meta name="theme-color" content="#0a0a14"/>
<title>Baccarat AI V9 Ultra C ~by BiCode · Prédicteur enseigne J/B</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet"/>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Ctext y='52' font-size='52'%3E♠%3C/text%3E%3C/svg%3E"/>
<link rel="stylesheet" href="/static/style.css"/>
</head>
<body>
<div id="app">
  <div class="splash">
    <div class="splash-card">
      <div class="splash-suits">
        <span style="color:#1a1a1a">♠</span>
        <span style="color:#dc2626">♥</span>
        <span style="color:#dc2626">♦</span>
        <span style="color:#1a1a1a">♣</span>
      </div>
      <div class="splash-title">Baccarat AI V9</div>
      <div class="splash-sub">Ultra C <span style="opacity:.7">~by BiCode</span> — Connexion à Telegram…</div>
      <div class="splash-progress"><div class="splash-bar"></div></div>
    </div>
  </div>
</div>
<script src="/static/engine.js"></script>
<script src="/static/app.js"></script>
</body>
</html>`

export default app
