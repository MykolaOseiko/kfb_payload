#!/usr/bin/env node
/**
 * KFBooks Evergreen Posts
 *
 * Runs ~15th of each month.
 * Picks the next topic from a predefined list, searches RSS sources for
 * relevant recent articles, synthesises an original analytical deep-dive.
 * Tracks progress in evergreen-state.json.
 *
 * Cron: 0 9 15 * *
 * Run manually: node evergreen.js
 */

import Anthropic from '@anthropic-ai/sdk'
import Parser from 'rss-parser'
import { JSDOM } from 'jsdom'
import { Readability } from '@mozilla/readability'
import { readFileSync, writeFileSync, existsSync } from 'fs'
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

// ── Topic list ────────────────────────────────────────────────────────────────
const TOPICS = [
  {
    title: 'Wide distribution vs KDP Select: what the data actually shows',
    keywords: ['wide', 'kdp select', 'exclusive', 'draft2digital', 'distribution'],
  },
  {
    title: 'How Kindle Unlimited page rates work — and what that means for your income',
    keywords: ['kindle unlimited', 'ku ', 'page reads', 'kenp', 'per page'],
  },
  {
    title: 'The real economics of self-publishing: income, costs, and what the surveys miss',
    keywords: ['income', 'earnings', 'royalt', 'revenue', 'survey', 'profit'],
  },
  {
    title: 'Your email list is worth more than any social platform — here is why',
    keywords: ['email', 'newsletter', 'mailing list', 'subscriber', 'direct'],
  },
  {
    title: 'AI in the indie author workflow: where it helps and where it hurts',
    keywords: ['ai ', 'artificial intelligence', 'chatgpt', 'generated content', 'disclosure'],
  },
  {
    title: 'Beyond Amazon: the case for global indie distribution in 2025',
    keywords: ['kobo', 'global', 'international', 'apple books', 'barnes', 'wide'],
  },
  {
    title: 'IP rights for indie authors: what you own, what you sign away, and how to protect it',
    keywords: ['copyright', 'ip rights', 'intellectual property', 'trademark', 'contract'],
  },
  {
    title: 'What actually moves books: a hard look at indie marketing ROI',
    keywords: ['marketing', 'amazon ads', 'facebook ads', 'promotion', 'visibility', 'roi'],
  },
  {
    title: 'The indie audiobook opportunity: ACX, Findaway, and going wide on audio',
    keywords: ['audiobook', 'audio', 'acx', 'findaway', 'spoken word', 'narrator'],
  },
  {
    title: 'Series vs standalones: what the data says about reader retention',
    keywords: ['series', 'standalone', 'sequel', 'backlist', 'read-through'],
  },
  {
    title: 'How to read your KDP dashboard — and what it is not telling you',
    keywords: ['kdp', 'dashboard', 'analytics', 'sales data', 'reporting'],
  },
  {
    title: 'Print on demand in 2025: IngramSpark vs KDP Print, costs and reach',
    keywords: ['print on demand', 'pod', 'ingramspark', 'kdp print', 'paperback', 'hardcover'],
  },
  {
    title: 'Translation rights: the most underused revenue stream for indie authors',
    keywords: ['translat', 'foreign rights', 'rights', 'language rights', 'international'],
  },
  {
    title: 'Cover design as a business decision: what converts browsers into buyers',
    keywords: ['cover', 'design', 'thumbnail', 'visual', 'branding', 'genre'],
  },
  {
    title: 'How to build a reader community that outlasts any algorithm',
    keywords: ['reader', 'community', 'loyalty', 'direct', 'patreon', 'substack'],
  },
  {
    title: 'Understanding the Amazon search algorithm: what signals actually matter',
    keywords: ['algorithm', 'amazon search', 'visibility', 'rank', 'keywords', 'metadata'],
  },
  {
    title: 'Ebook pricing strategy: what the data says about the $2.99–$4.99 range',
    keywords: ['price', 'pricing', '$2.99', '$4.99', '$0.99', 'permafree', 'discount'],
  },
  {
    title: 'BookTok, BookStagram, and the real value of social media for book discovery',
    keywords: ['booktok', 'tiktok', 'instagram', 'bookstagram', 'social media', 'discovery'],
  },
]

// ── State ─────────────────────────────────────────────────────────────────────
const STATE_FILE = resolve(__dirname, 'evergreen-state.json')

function loadState() {
  if (existsSync(STATE_FILE)) {
    try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch {}
  }
  return { index: 0 }
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

// ── Sources ──────────────────────────────────────────────────────────────────
const SOURCES = [
  { name: 'Jane Friedman',      url: 'https://www.janefriedman.com/feed/' },
  { name: 'David Gaughran',     url: 'https://davidgaughran.com/feed/' },
  { name: 'ALLi',               url: 'https://www.allianceindependentauthors.org/feed/' },
  { name: 'The Creative Penn',  url: 'https://www.thecreativepenn.com/feed/' },
  { name: 'Reedsy',             url: 'https://blog.reedsy.com/feed/' },
  { name: 'Written Word Media', url: 'https://www.writtenwordmedia.com/feed/' },
]

// ── Helpers ───────────────────────────────────────────────────────────────────
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

async function fetchTopicSources(topic) {
  const parser   = new Parser()
  const articles = []

  for (const source of SOURCES) {
    try {
      const feed  = await parser.parseURL(source.url)
      const match = feed.items.find(item => {
        const text = `${item.title} ${item.contentSnippet || ''}`.toLowerCase()
        return topic.keywords.some(kw => text.includes(kw))
      })
      if (!match) continue

      const body = await fetchFullText(match.link) || match.contentSnippet?.slice(0, 800) || ''
      if (body.length > 150) {
        articles.push({ source: source.name, title: match.title, body })
        if (articles.length >= 3) break
      }
    } catch {}
  }

  return articles
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

async function createDraft(token, { title, excerpt, body }) {
  const slug = title.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').slice(0, 60)
    + '-' + Date.now()

  const res  = await fetch(`${PAYLOAD_URL}/api/posts?locale=en`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `JWT ${token}` },
    body: JSON.stringify({
      title, slug, excerpt,
      content: toLexi(body),
      status: 'draft',
      publishedAt: new Date().toISOString(),
      category: Number(INDUSTRY_NEWS_CATEGORY_ID),
    }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error('Create failed: ' + JSON.stringify(data.errors || data))
  return data.doc
}

// ── Claude ────────────────────────────────────────────────────────────────────
async function generateEvergreenPost(topic, articles) {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY })

  const hasArticles  = articles.length > 0
  const sourcesBlock = hasArticles
    ? articles.map((a, i) =>
        `SOURCE ${i + 1} — ${a.source}\nTitle: ${a.title}\nText: ${a.body}`
      ).join('\n\n---\n\n')
    : null

  const sourceInstructions = hasArticles
    ? `Use these ${articles.length} source articles as reference material (max 20% from each, thorough rewrite):\n\n${sourcesBlock}\n\n`
    : 'No source articles were found. Write from your knowledge of the indie publishing industry — be specific with real data points, platform names, and concrete examples.\n\n'

  const msg = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 1200,
    messages: [{
      role: 'user',
      content: `You are a senior content editor at KF Books — a platform helping indie authors protect IP rights and grow loyal readerships.

${sourceInstructions}Write an ORIGINAL analytical deep-dive on the topic: "${topic.title}"

Requirements:
- This is an evergreen piece — no news hooks, no "this month" framing
- Take a clear editorial position and argue it with specific evidence
- Include real data points, named platforms, concrete examples
- Written for an indie author who has been publishing for 1–3 years — skip beginner basics
- Strong hook in the first sentence: a counterintuitive fact, a hard number, or a precise claim
- No filler openers ("In today's publishing landscape…", "As an indie author you know…")
- 600–700 words, 5–6 paragraphs

Return ONLY valid JSON (no markdown, no code fences):
{
  "title": "sharp, specific headline — max 12 words",
  "excerpt": "one sentence that makes them click — max 25 words",
  "body": "5-6 paragraphs separated by \\n\\n"
}`,
    }],
  })

  return JSON.parse(msg.content[0].text.trim())
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const state      = loadState()
  const topic      = TOPICS[state.index % TOPICS.length]
  const nextTopic  = TOPICS[(state.index + 1) % TOPICS.length]

  console.log(`📝 Evergreen post #${state.index + 1} of ${TOPICS.length}`)
  console.log(`   Topic: "${topic.title}"\n`)

  process.stdout.write('🔍 Searching for relevant source articles...')
  const articles = await fetchTopicSources(topic)
  console.log(` ${articles.length > 0 ? articles.length + ' found' : 'none — writing from knowledge'}`)

  console.log('✍️  Generating with Claude...')
  const post = await generateEvergreenPost(topic, articles)

  console.log('📤 Creating draft...')
  const token = await getToken()
  const doc   = await createDraft(token, post)

  saveState({ index: state.index + 1 })

  console.log(`\n✅ "${doc.title}"`)
  console.log(`   ${PAYLOAD_URL}/admin/collections/posts/${doc.id}`)
  console.log(`\n   Next topic: "${nextTopic.title}"`)
}

main().catch(err => {
  console.error('❌ Fatal:', err.message)
  process.exit(1)
})
