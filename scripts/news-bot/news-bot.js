#!/usr/bin/env node
/**
 * KFBooks News Bot
 * Fetches indie publishing industry news from RSS feeds,
 * generates a short analysis using Claude API,
 * and creates a draft post in Payload CMS.
 *
 * Cron: 0 9 * * 1,3,5  (Mon/Wed/Fri at 09:00 UTC)
 * Run manually: node news-bot.js
 */

import Parser from 'rss-parser'
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

// ── RSS Sources ──────────────────────────────────────────────────────────────
const SOURCES = [
  { name: 'Jane Friedman',       url: 'https://www.janefriedman.com/feed/' },
  { name: 'The Creative Penn',   url: 'https://www.thecreativepenn.com/feed/' },
  { name: 'ALLi',                url: 'https://www.allianceindependentauthors.org/feed/' },
  { name: 'Reedsy',              url: 'https://blog.reedsy.com/feed/' },
  { name: 'David Gaughran',      url: 'https://davidgaughran.com/feed/' },
  { name: 'Written Word Media',  url: 'https://www.writtenwordmedia.com/feed/' },
  { name: 'Draft2Digital',       url: 'https://draft2digital.com/blog/feed/' },
]

const KEYWORDS = [
  'indie author', 'self-publishing', 'self-publish', 'ebook', 'kindle', 'kdp',
  'royalt', 'amazon', 'draft2digital', 'kobo', 'book market', 'author income',
  'book sales', 'publishing industry', 'audiobook', 'book promotion',
  'wide publishing', 'isbn', 'print on demand',
]

// ── Utilities ────────────────────────────────────────────────────────────────
function isRelevant(item) {
  const text = `${item.title} ${item.contentSnippet || ''}`.toLowerCase()
  return KEYWORDS.some(kw => text.includes(kw))
}

function toSlug(title) {
  return title.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 60) + '-' + Date.now()
}

/**
 * Converts plain text (paragraphs separated by \n\n) to Payload Lexical JSON.
 */
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
  if (!data.token) throw new Error('Payload login failed: ' + JSON.stringify(data))
  return data.token
}

async function createDraft(token, { title, excerpt, body, publishedAt }) {
  const res = await fetch(`${PAYLOAD_URL}/api/posts?locale=en`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `JWT ${token}`,
    },
    body: JSON.stringify({
      title,
      slug: toSlug(title),
      excerpt,
      content: toLexi(body),
      status: 'draft',
      publishedAt,
      category: Number(INDUSTRY_NEWS_CATEGORY_ID),
    }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error('Payload create failed: ' + JSON.stringify(data))
  return data.doc
}

// ── Claude ───────────────────────────────────────────────────────────────────
async function generatePost(article) {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY })

  const message = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 800,
    messages: [{
      role: 'user',
      content: `You are a content writer for KF Books — a platform that helps indie authors protect their IP rights and build loyal readerships.

Write a short blog post analyzing this industry news for indie authors.
Return ONLY valid JSON (no markdown, no code blocks), with exactly these keys:
{
  "title": "engaging headline (max 10 words)",
  "excerpt": "one sentence summary (max 25 words)",
  "body": "3-4 paragraphs separated by \\n\\n, ~300 words total"
}

Rules for body:
- Hook in first sentence
- Focus on what it means specifically for indie authors
- Practical and actionable tone
- End with one clear takeaway
- No filler phrases like "In conclusion"

Article to analyze:
Source: ${article.source}
Headline: ${article.title}
Summary: ${article.summary}
URL: ${article.url}`,
    }],
  })

  const raw = message.content[0].text.trim()
  return JSON.parse(raw)
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🔍 Fetching RSS feeds...')
  const parser = new Parser()
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const articles = []

  for (const source of SOURCES) {
    try {
      const feed = await parser.parseURL(source.url)
      for (const item of feed.items) {
        const pubDate = new Date(item.pubDate || item.isoDate)
        if (pubDate < cutoff) continue
        if (!isRelevant(item)) continue
        articles.push({
          source: source.name,
          title: item.title,
          url: item.link,
          summary: (item.contentSnippet || '').slice(0, 600),
          date: pubDate,
        })
      }
    } catch (err) {
      console.warn(`⚠️  ${source.name}: ${err.message}`)
    }
  }

  if (articles.length === 0) {
    console.log('No relevant articles found this week. Exiting.')
    return
  }

  articles.sort((a, b) => b.date - a.date)
  const article = articles[0]
  console.log(`📰 Selected: "${article.title}" (${article.source})`)

  console.log('✍️  Generating post with Claude...')
  const post = await generatePost(article)

  console.log('📤 Creating draft in Payload...')
  const token = await getToken()
  const doc = await createDraft(token, {
    title: post.title,
    excerpt: post.excerpt,
    body: post.body,
    publishedAt: new Date().toISOString(),
  })

  console.log(`✅ Draft created: "${doc.title}" → ${PAYLOAD_URL}/admin/collections/posts/${doc.id}`)
}

main().catch(err => {
  console.error('❌ Error:', err.message)
  process.exit(1)
})
