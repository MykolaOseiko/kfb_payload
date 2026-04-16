#!/usr/bin/env node
/**
 * KFBooks Retrospective News Import
 *
 * Generates 1 post per week for a historical date range using Claude's
 * training knowledge of indie publishing industry events.
 *
 * Coverage: April 2024 – June 2025 (~60 weeks)
 * Note: The last 9 months (July 2025 – present) will be handled
 *       separately via newsletter archives.
 *
 * Run: node retrospective.js
 * Estimated time: ~60 posts × ~5s each ≈ 5-6 minutes
 */

import Anthropic from '@anthropic-ai/sdk'
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
// Adjust these dates as needed
const START_DATE = new Date('2024-04-01')
const END_DATE   = new Date('2025-06-30')

const DELAY_MS = 3000 // pause between API calls to respect rate limits

// ── Utilities ────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

function formatMonth(date) {
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}


function weekRangeLabel(date) {
  const end = new Date(date)
  end.setDate(end.getDate() + 6)
  const opts = { month: 'short', day: 'numeric' }
  return `${date.toLocaleDateString('en-US', opts)} – ${end.toLocaleDateString('en-US', { ...opts, year: 'numeric' })}`
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

// ── Payload Client ───────────────────────────────────────────────────────────
async function getToken() {
  const res = await fetch(`${PAYLOAD_URL}/api/users/login`, {
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
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 60) + '-' + new Date(publishedAt).getTime()

  const res = await fetch(`${PAYLOAD_URL}/api/posts?locale=en`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `JWT ${token}`,
    },
    body: JSON.stringify({
      title,
      slug,
      excerpt,
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
async function generateHistoricalPost(weekStart) {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY })
  const weekLabel = weekRangeLabel(weekStart)
  const monthLabel = formatMonth(weekStart)

  const message = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 800,
    messages: [{
      role: 'user',
      content: `You are a content writer for KF Books — a platform helping indie authors protect IP rights and grow loyal readerships.

Write a blog post about what was happening in the indie publishing industry during the week of ${weekLabel}.

Focus on: ebook market trends, self-publishing platform updates (KDP, Draft2Digital, Kobo, etc.), royalty changes, author income data, publishing industry news, or significant events affecting indie authors.

Return ONLY valid JSON (no markdown, no code blocks):
{
  "title": "engaging headline referencing this specific time period (max 12 words)",
  "excerpt": "one sentence capturing the key theme of that week (max 25 words)",
  "body": "3-4 paragraphs separated by \\n\\n, ~300 words total"
}

Rules for body:
- Ground it in real trends or events you know happened around ${monthLabel}
- If unsure about specific details, write about general industry direction of that period
- Focus on implications for indie authors
- Practical, informative tone
- End with a takeaway relevant to that moment in time`,
    }],
  })

  const raw = message.content[0].text.trim()
  return JSON.parse(raw)
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  // Count total weeks
  const weeks = []
  const cursor = new Date(START_DATE)
  while (cursor <= END_DATE) {
    weeks.push(new Date(cursor))
    cursor.setDate(cursor.getDate() + 7)
  }

  console.log(`📅 Generating ${weeks.length} retrospective posts`)
  console.log(`   Range: ${formatMonth(START_DATE)} → ${formatMonth(END_DATE)}`)
  console.log(`   Estimated time: ~${Math.ceil(weeks.length * DELAY_MS / 60000)} minutes\n`)

  const token = await getToken()
  console.log('✅ Payload authenticated\n')

  let created = 0
  let failed = 0

  for (const weekStart of weeks) {
    const label = weekRangeLabel(weekStart)
    process.stdout.write(`[${created + failed + 1}/${weeks.length}] ${label} ... `)

    try {
      const post = await generateHistoricalPost(weekStart)
      await createDraft(token, {
        title: post.title,
        excerpt: post.excerpt,
        body: post.body,
        publishedAt: weekStart.toISOString(),
      })
      console.log(`✅ "${post.title}"`)
      created++
    } catch (err) {
      console.log(`❌ ${err.message}`)
      failed++
    }

    await sleep(DELAY_MS)
  }

  console.log(`\n── Done ──────────────────────────────────`)
  console.log(`Created: ${created}  Failed: ${failed}`)
  console.log(`Review drafts at: ${PAYLOAD_URL}/admin/collections/posts`)
}

main().catch(err => {
  console.error('Fatal:', err.message)
  process.exit(1)
})
