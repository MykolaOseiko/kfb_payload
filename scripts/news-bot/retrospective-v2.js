#!/usr/bin/env node
/**
 * KFBooks Retrospective Import v2
 *
 * Fetches real archived articles via Wayback Machine CDX API,
 * extracts text with Readability, synthesises original monthly
 * roundup posts with Claude.
 *
 * Coverage: January 2024 – June 2025 (18 months)
 * Run: node retrospective-v2.js
 */

import Anthropic from '@anthropic-ai/sdk'
import { JSDOM } from 'jsdom'
import { Readability } from '@mozilla/readability'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

// ── Load .env ────────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url))
try {
  const env = readFileSync(resolve(__dirname, '.env'), 'utf8')
  env.split('\n').forEach(line => {
    const [k, ...v] = line.split('=')
    if (k && !k.startsWith('#')) process.env[k.trim()] = v.join('=').trim()
  })
} catch {}

const {
  PAYLOAD_URL = 'https://payload.kfbooks.eu',
  PAYLOAD_EMAIL,
  PAYLOAD_PASSWORD,
  ANTHROPIC_API_KEY,
  INDUSTRY_NEWS_CATEGORY_ID,
} = process.env

// ── Config ───────────────────────────────────────────────────────────────────
const START = new Date('2024-01-01')
const END   = new Date('2025-06-30')

const DELAY_MS = 6000 // between months (Wayback Machine rate limit)

// Try both www and non-www variants
const SOURCES = [
  'www.janefriedman.com',
  'davidgaughran.com',
  'www.allianceindependentauthors.org',
  'www.thecreativepenn.com',
  'blog.reedsy.com',
  'www.writtenwordmedia.com',
]

// ── Utilities ────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function monthLabel(date) {
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

function isArticleUrl(url) {
  const skip = ['/feed', '/category/', '/tag/', '/page/', '/wp-content',
                '/wp-admin', '/author/', '?s=', '.xml', '.rss', '/#', '/cdn-cgi']
  return !skip.some(s => url.includes(s)) && url.split('/').length >= 5
}

// ── Wayback Machine CDX ──────────────────────────────────────────────────────
async function fetchCDX(domain, yearMonth) {
  const from = `${yearMonth}01000000`
  const to   = `${yearMonth}31235959`
  const qs   = new URLSearchParams({
    url:      `${domain}/*`,
    output:   'json',
    from, to,
    limit:    '40',
    filter:   'statuscode:200',
    fl:       'timestamp,original',
    collapse: 'urlkey',
  })
  try {
    const res = await fetch(`http://web.archive.org/cdx/search/cdx?${qs}`,
      { signal: AbortSignal.timeout(20000) })
    const rows = await res.json()
    if (!Array.isArray(rows) || rows.length < 2) return []
    return rows.slice(1)
      .filter(([, u]) => isArticleUrl(u))
      .slice(0, 4)
      .map(([ts, u]) => `https://web.archive.org/web/${ts}/${u}`)
  } catch {
    return []
  }
}

// ── Article extraction ───────────────────────────────────────────────────────
async function extractText(archiveUrl) {
  try {
    const res = await fetch(archiveUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KFBooksBot/2.0)' },
      signal: AbortSignal.timeout(25000),
    })
    const html = await res.text()
    const dom  = new JSDOM(html, { url: archiveUrl })
    const article = new Readability(dom.window.document).parse()
    if (!article || !article.textContent) return null
    return {
      title: article.title?.trim().slice(0, 120) || '',
      text:  article.textContent.trim().replace(/\s+/g, ' ').slice(0, 1500),
    }
  } catch {
    return null
  }
}

async function fetchBestArticle(domain, yearMonth) {
  const candidates = await fetchCDX(domain, yearMonth)
  for (const archiveUrl of candidates) {
    await sleep(1200)
    const article = await extractText(archiveUrl)
    if (article && article.text.length > 250) return { domain, ...article }
  }
  return null
}

// ── Lexical / Payload ────────────────────────────────────────────────────────
function toLexi(text) {
  const paras = text.split(/\n\n+/).map(p => p.trim()).filter(Boolean)
  return {
    root: {
      type: 'root', version: 1, direction: 'ltr', format: '', indent: 0,
      children: paras.map(para => ({
        type: 'paragraph', version: 1, direction: 'ltr', format: '', indent: 0,
        children: [{ type: 'text', version: 1, text: para, format: 0, detail: 0, mode: 'normal', style: '' }],
      })),
    },
  }
}

async function getToken() {
  const res  = await fetch(`${PAYLOAD_URL}/api/users/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: PAYLOAD_EMAIL, password: PAYLOAD_PASSWORD }),
  })
  const data = await res.json()
  if (!data.token) throw new Error('Payload login failed')
  return data.token
}

async function createDraft(token, { title, excerpt, body, publishedAt }) {
  const slug = title.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').slice(0, 60)
    + '-' + new Date(publishedAt).getTime()

  const res  = await fetch(`${PAYLOAD_URL}/api/posts?locale=en`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `JWT ${token}` },
    body: JSON.stringify({
      title, slug, excerpt,
      content: toLexi(body),
      status: 'draft',
      publishedAt,
      category: Number(INDUSTRY_NEWS_CATEGORY_ID),
    }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error('Create failed: ' + JSON.stringify(data.errors || data))
  return data.doc
}

// ── Claude ───────────────────────────────────────────────────────────────────
async function generatePost(sources, label) {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY })

  const sourcesBlock = sources.map((s, i) =>
    `SOURCE ${i + 1} — ${s.domain}\nTitle: ${s.title}\nText: ${s.text}`
  ).join('\n\n---\n\n')

  const msg = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: `You are a content editor at KF Books — a platform for indie authors.

Below are excerpts from ${sources.length} real article(s) published in ${label}.

${sourcesBlock}

Write an ORIGINAL monthly roundup for indie authors covering ${label}. Requirements:
- Extract every specific fact, name, platform, figure, or event from the sources — these are your anchors
- Use your knowledge of the indie publishing industry to fill context around those anchors
- Maximum 20% of any single source used directly — everything else in your own voice
- Each paragraph covers a distinct angle (platforms, earnings/royalties, marketing, AI/rights, reader discovery)
- Editorial voice — opinionated and direct, not a bland news summary
- No generic openers ("This month saw…", "It's been a busy…", "The indie publishing world…")
- Final paragraph: one concrete, actionable takeaway tied to this specific period
- 380–420 words, 4–5 paragraphs

Return ONLY valid JSON (no markdown, no code fences):
{
  "title": "specific headline for ${label} — max 12 words",
  "excerpt": "one sharp sentence capturing the key theme, max 25 words",
  "body": "4-5 paragraphs separated by \\n\\n"
}`,
    }],
  })

  return JSON.parse(msg.content[0].text.trim())
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const months = []
  const cursor = new Date(START)
  while (cursor <= END) {
    months.push(new Date(cursor))
    cursor.setMonth(cursor.getMonth() + 1)
  }

  console.log(`📅 Retrospective import — ${months.length} months`)
  console.log(`   ${monthLabel(START)} → ${monthLabel(END)}\n`)

  const token = await getToken()
  console.log('✅ Payload authenticated\n')

  let created = 0, failed = 0

  for (const monthDate of months) {
    const yearMonth = `${monthDate.getFullYear()}${String(monthDate.getMonth() + 1).padStart(2, '0')}`
    const label     = monthLabel(monthDate)

    console.log(`[${created + failed + 1}/${months.length}] ${label}`)

    // Fetch sources concurrently
    process.stdout.write('  Fetching sources ')
    const results = await Promise.all(SOURCES.map(d => fetchBestArticle(d, yearMonth)))
    const sources = results.filter(Boolean)
    console.log(`→ ${sources.length}/${SOURCES.length} retrieved`)

    if (sources.length === 0) {
      console.log('  ⚠️  No sources found — skipping\n')
      failed++
      await sleep(DELAY_MS)
      continue
    }

    try {
      process.stdout.write('  Generating with Claude... ')
      const post = await generatePost(sources, label)
      await createDraft(token, {
        title: post.title,
        excerpt: post.excerpt,
        body: post.body,
        publishedAt: monthDate.toISOString(),
      })
      console.log(`✅ "${post.title}"\n`)
      created++
    } catch (err) {
      console.log(`❌ ${err.message}\n`)
      failed++
    }

    await sleep(DELAY_MS)
  }

  console.log('── Done ──────────────────────────────────────────')
  console.log(`Created: ${created}   Skipped/failed: ${failed}`)
  console.log(`Review: ${PAYLOAD_URL}/admin/collections/posts`)
}

main().catch(err => {
  console.error('Fatal:', err.message)
  process.exit(1)
})
