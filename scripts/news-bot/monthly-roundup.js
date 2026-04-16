#!/usr/bin/env node
/**
 * KFBooks Monthly Roundup
 *
 * Runs on the 1st of each month.
 * Fetches real articles published last calendar month from RSS sources,
 * extracts full text, synthesises an original roundup post with Claude.
 *
 * Cron: 0 9 1 * *
 * Run manually: node monthly-roundup.js
 */

import Anthropic from '@anthropic-ai/sdk'
import Parser from 'rss-parser'
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

// ── Sources ──────────────────────────────────────────────────────────────────
const SOURCES = [
  { name: 'Jane Friedman',      url: 'https://www.janefriedman.com/feed/' },
  { name: 'David Gaughran',     url: 'https://davidgaughran.com/feed/' },
  { name: 'ALLi',               url: 'https://www.allianceindependentauthors.org/feed/' },
  { name: 'The Creative Penn',  url: 'https://www.thecreativepenn.com/feed/' },
  { name: 'Reedsy',             url: 'https://blog.reedsy.com/feed/' },
  { name: 'Written Word Media', url: 'https://www.writtenwordmedia.com/feed/' },
]

const KEYWORDS = [
  'indie author', 'self-publishing', 'self-publish', 'ebook', 'kindle', 'kdp',
  'royalt', 'amazon', 'draft2digital', 'kobo', 'author income', 'book sales',
  'publishing', 'audiobook', 'isbn', 'print on demand', 'ai', 'copyright',
  'book market', 'wide publishing', 'book promotion',
]

// ── Helpers ───────────────────────────────────────────────────────────────────
function lastMonthRange() {
  const now   = new Date()
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const end   = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59)
  const label = start.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  return { start, end, label, publishedAt: start.toISOString() }
}

function isRelevant(item) {
  const text = `${item.title} ${item.contentSnippet || ''}`.toLowerCase()
  return KEYWORDS.some(kw => text.includes(kw))
}

async function fetchFullText(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KFBooksBot/2.0)' },
      signal: AbortSignal.timeout(15000),
    })
    const html = await res.text()
    const dom  = new JSDOM(html, { url })
    const art  = new Readability(dom.window.document).parse()
    return art?.textContent?.trim().replace(/\s+/g, ' ').slice(0, 1500) || ''
  } catch {
    return ''
  }
}

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

// ── Claude ────────────────────────────────────────────────────────────────────
async function generateRoundup(articles, label) {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY })

  const sourcesBlock = articles.map((a, i) =>
    `SOURCE ${i + 1} — ${a.source}\nTitle: ${a.title}\nText: ${a.body}`
  ).join('\n\n---\n\n')

  const msg = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: `You are a content editor at KF Books — a platform for indie authors.

Below are excerpts from ${articles.length} real articles published in ${label}.

${sourcesBlock}

Write an ORIGINAL monthly roundup for indie authors. Requirements:
- Ground every claim in specifics from the sources (names, platforms, figures, events)
- Maximum 20% of any single source used directly — everything else in your own voice
- Each paragraph covers a distinct angle (e.g. platform news, earnings, marketing, rights/AI, reader discovery)
- Editorial voice — opinionated, direct, useful — not a bland news summary
- No generic openers ("This month saw…", "It's been a busy month…")
- Final paragraph: one concrete, actionable takeaway tied to what actually happened this month
- 380–420 words, 4–5 paragraphs

Return ONLY valid JSON (no markdown, no code fences):
{
  "title": "specific, compelling headline for ${label} — max 12 words",
  "excerpt": "one sharp sentence capturing the key theme, max 25 words",
  "body": "4-5 paragraphs separated by \\n\\n"
}`,
    }],
  })

  return JSON.parse(msg.content[0].text.trim())
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const { start, end, label, publishedAt } = lastMonthRange()

  console.log(`📅 Monthly roundup — ${label}`)
  console.log(`   Scanning ${start.toDateString()} → ${end.toDateString()}\n`)

  const parser   = new Parser()
  const articles = []

  for (const source of SOURCES) {
    try {
      const feed  = await parser.parseURL(source.url)
      const match = feed.items.find(item => {
        const date = new Date(item.pubDate || item.isoDate)
        return date >= start && date <= end && isRelevant(item)
      })
      if (!match) { console.log(`  ${source.name}: no match`); continue }

      process.stdout.write(`  ${source.name}: "${match.title}" — extracting...`)
      const body = await fetchFullText(match.link) || match.contentSnippet?.slice(0, 800) || ''

      if (body.length > 150) {
        articles.push({ source: source.name, title: match.title, url: match.link, body })
        console.log(' ✅')
      } else {
        console.log(' ⚠️  too short, skipped')
      }
    } catch (err) {
      console.warn(`  ⚠️  ${source.name}: ${err.message}`)
    }
  }

  if (articles.length < 2) {
    console.error(`\n❌ Only ${articles.length} article(s) found — not enough for a roundup.`)
    process.exit(1)
  }

  console.log(`\n✍️  Generating from ${articles.length} sources...`)
  const post = await generateRoundup(articles, label)

  console.log('📤 Creating draft...')
  const token = await getToken()
  const doc   = await createDraft(token, { ...post, publishedAt })

  console.log(`\n✅ "${doc.title}"`)
  console.log(`   ${PAYLOAD_URL}/admin/collections/posts/${doc.id}`)
}

main().catch(err => {
  console.error('❌ Fatal:', err.message)
  process.exit(1)
})
