#!/usr/bin/env node
/**
 * KFBooks Blog Post Generator
 *
 * Reads source files from blog/*.txt, finds relevant articles per post topic,
 * generates original posts with Claude, saves locally as .md files for review.
 *
 * Usage:
 *   node generate-posts.js          — generate all pending posts
 *   node generate-posts.js 1 10     — generate posts #1–10
 */

import Anthropic from '@anthropic-ai/sdk'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
try {
  const env = readFileSync(resolve(__dirname, '.env'), 'utf8')
  env.split('\n').forEach(line => {
    const [k, ...v] = line.split('=')
    if (k && !k.startsWith('#')) process.env[k.trim()] = v.join('=').trim()
  })
} catch {}

const { ANTHROPIC_API_KEY } = process.env

// ── Paths ─────────────────────────────────────────────────────────────────────
const SOURCES_DIR = resolve(__dirname, '../../../_KFB_site/blog')
const OUTPUT_DIR  = resolve(SOURCES_DIR, 'generated')

// ── Post list (44 approved posts, audio removed) ─────────────────────────────
const POSTS = [
  // ── Category 3: Rights & AI ──────────────────────────────────────────────
  { id: 1,  title: 'AI Copyright Law for Indie Authors: What the Courts Actually Decided (Not What Twitter Says)',        category: 'Rights & AI',          category_id: 3, keywords: ['ai', 'copyright', 'law', 'court', 'legal', 'anthropic', 'meta'] },
  { id: 2,  title: 'The Bartz v. Anthropic Ruling: What the $1.5B Settlement Means for Your Books',                       category: 'Rights & AI',          category_id: 3, keywords: ['bartz', 'anthropic', 'settlement', 'ruling', 'court', 'lawsuit'] },
  { id: 3,  title: 'AI Training Licenses: When Publishers Ask to Use Your Backlist — What to Say',                        category: 'Rights & AI',          category_id: 3, keywords: ['ai training', 'license', 'publisher', 'backlist', 'rights', 'wiley', 'harpercollins'] },
  { id: 4,  title: "KDP's AI Disclosure Rules: What They Cover, What They Don't, and What's Next",                        category: 'Rights & AI',          category_id: 3, keywords: ['kdp', 'ai disclosure', 'disclosure', 'amazon', 'policy'] },
  { id: 5,  title: '"Human Authored" Certification: Does the Authors Guild Badge Actually Mean Anything?',                category: 'Rights & AI',          category_id: 3, keywords: ['human authored', 'certification', 'authors guild', 'pangram', 'verify'] },
  { id: 6,  title: "Writing in Someone's Style Is Legal — Until It Isn't: The Right of Publicity Problem",               category: 'Rights & AI',          category_id: 3, keywords: ['style', 'right of publicity', 'voice', 'copyright', 'ai generated'] },
  { id: 7,  title: 'AI Detection Tools Have a Reliability Problem. Here\'s What That Means for Authors',                 category: 'Rights & AI',          category_id: 3, keywords: ['ai detection', 'detection tool', 'pangram', 'reliable', 'false positive'] },
  { id: 8,  title: 'Three Contract Clauses Indie Authors Can No Longer Afford to Skip in 2025',                          category: 'Rights & AI',          category_id: 3, keywords: ['contract', 'clause', 'ai rights', 'reversion', 'rights'] },
  { id: 9,  title: 'Publishers Are Already Licensing Books for AI Training. Here\'s What You Can Do',                    category: 'Rights & AI',          category_id: 3, keywords: ['ai training', 'licensing', 'publisher', 'opt out', 'ingram'] },
  { id: 10, title: 'Kindle Translate Beta: Real Opportunity or a Rights Trap You Should Read First?',                    category: 'Rights & AI',          category_id: 3, keywords: ['kindle translate', 'translation', 'kdp', 'rights', 'beta'] },
  // ── Category 4: Marketing & Promotion ───────────────────────────────────
  { id: 11, title: 'BookBub Featured Deals: The Real 20% Acceptance Rate — and What Actually Improves Your Odds',        category: 'Marketing & Promotion', category_id: 4, keywords: ['bookbub', 'featured deal', 'acceptance', 'application'] },
  { id: 12, title: 'Promo Stacking: Why Running Several Sites Back-to-Back Beats Any Single Promotion',                  category: 'Marketing & Promotion', category_id: 4, keywords: ['promo stacking', 'stacking', 'promotion', 'freebooksy', 'ent'] },
  { id: 13, title: 'Free vs. Discounted Promotions: Which One Actually Builds a Reader Base?',                           category: 'Marketing & Promotion', category_id: 4, keywords: ['free promotion', 'discount', 'permafree', '99 cent', 'reader'] },
  { id: 14, title: 'Series Promotions Are a Different Game: Why the Freebooksy Stacked Model Works',                     category: 'Marketing & Promotion', category_id: 4, keywords: ['series promo', 'freebooksy', 'series', 'read-through'] },
  { id: 15, title: 'The Email List vs. Social Media Debate: What the Data Says (and What It Doesn\'t)',                  category: 'Marketing & Promotion', category_id: 4, keywords: ['email list', 'newsletter', 'social media', 'marketing'] },
  { id: 16, title: 'YouTube for Authors: Expect Nothing Before 100 Videos — and Why That\'s Reasonable',                 category: 'Marketing & Promotion', category_id: 4, keywords: ['youtube', 'video', '100 videos', 'channel', 'author'] },
  { id: 17, title: "Video Marketing for Authors Isn't About Book Sales. It's About Community",                           category: 'Marketing & Promotion', category_id: 4, keywords: ['video marketing', 'community', 'youtube', 'engagement'] },
  { id: 18, title: 'Library Outreach for Indie Authors: The Simple Email Pitch That Works',                              category: 'Marketing & Promotion', category_id: 4, keywords: ['library', 'outreach', 'email', 'pitch', 'large print'] },
  { id: 19, title: 'Direct Sales via Shopify: Is the Switch Worth It for Indie Authors Right Now?',                      category: 'Marketing & Promotion', category_id: 4, keywords: ['shopify', 'direct sales', 'store', 'direct'] },
  { id: 20, title: 'Kickstarter for Book Launches: What Two Months of Real Preparation Looks Like',                      category: 'Marketing & Promotion', category_id: 4, keywords: ['kickstarter', 'crowdfunding', 'launch', 'preparation'] },
  { id: 21, title: 'Special Editions as a Marketing Tool: More Than Aesthetics, Less Than Magic',                        category: 'Marketing & Promotion', category_id: 4, keywords: ['special edition', 'limited edition', 'physical', 'hardback'] },
  { id: 22, title: 'The $15 Microphone Rule: What Equipment Indie Authors Actually Need for Video',                      category: 'Marketing & Promotion', category_id: 4, keywords: ['microphone', 'equipment', 'camera', 'video', 'lighting'] },
  { id: 23, title: 'BookBub Ads vs. Amazon Ads vs. Facebook Ads: Where to Start and When to Scale',                     category: 'Marketing & Promotion', category_id: 4, keywords: ['bookbub ads', 'amazon ads', 'facebook ads', 'advertising', 'roas'] },
  // ── Category 5: Platforms & Sales ───────────────────────────────────────
  { id: 24, title: 'Wide Distribution vs. KDP Select: What the Numbers Show After a Full Year',                          category: 'Platforms & Sales',    category_id: 5, keywords: ['wide', 'kdp select', 'exclusive', 'distribution', 'draft2digital'] },
  { id: 25, title: "Amazon's 14,000 Categories: How to Pick the Right One and Why It Changes Everything",                category: 'Platforms & Sales',    category_id: 5, keywords: ['category', 'amazon category', '14000', 'rank', 'bestseller'] },
  { id: 26, title: 'Series vs. Standalones: The Income Case for Writing in Sequence',                                    category: 'Platforms & Sales',    category_id: 5, keywords: ['series', 'standalone', 'income', 'read-through', 'revenue'] },
  { id: 27, title: "Pricing as a Marketing Lever: Why $2.99 Isn't the Safe Default Anymore",                            category: 'Platforms & Sales',    category_id: 5, keywords: ['pricing', 'price', '$2.99', '$4.99', 'permafree'] },
  { id: 28, title: 'Which Edit Do You Actually Need? Dev Edit, Line Edit, Copy Edit — Explained Without the Jargon',    category: 'Platforms & Sales',    category_id: 5, keywords: ['editing', 'developmental edit', 'copy edit', 'line edit', 'proofreading'] },
  { id: 29, title: 'Metadata Is Your Discoverability Engine: The Five Fields Most Authors Get Wrong',                    category: 'Platforms & Sales',    category_id: 5, keywords: ['metadata', 'keywords', 'description', 'subtitle', 'discoverability'] },
  { id: 30, title: 'Print on Demand in 2025: IngramSpark vs. KDP Print — The Trade-offs No One Lists Together',         category: 'Platforms & Sales',    category_id: 5, keywords: ['print on demand', 'pod', 'ingramspark', 'kdp print', 'paperback'] },
  { id: 31, title: "Cover Design by Age Group: Why Children's Book Covers Follow Completely Different Rules",            category: 'Platforms & Sales',    category_id: 5, keywords: ['cover design', 'children', 'age group', 'illustration', 'typography'] },
  { id: 32, title: 'Translation Rights for Indie Authors: Germany, Japan, and the Markets Worth Targeting',             category: 'Platforms & Sales',    category_id: 5, keywords: ['translation', 'foreign rights', 'germany', 'international', 'rights'] },
  { id: 33, title: 'The Self-Publishing 10-Step Checklist: Where Most Guides Stop Too Early',                           category: 'Platforms & Sales',    category_id: 5, keywords: ['self-publishing', 'checklist', 'steps', 'guide', 'publish'] },
  { id: 34, title: 'Kindle Devices Going Dark in 2026: What It Actually Means for Your Readers',                        category: 'Platforms & Sales',    category_id: 5, keywords: ['kindle device', 'end of support', '2026', 'ebook reader'] },
  { id: 35, title: 'BookVault, Print-on-Demand, and Direct Shipping: A Working Model for Print Indies',                 category: 'Platforms & Sales',    category_id: 5, keywords: ['bookvault', 'print on demand', 'direct shipping', 'bookshop'] },
  // ── Category 6: Craft & Career ───────────────────────────────────────────
  { id: 36, title: "The Hand-Editing Method: Why Printing Your Manuscript Catches What Screens Miss",                   category: 'Craft & Career',       category_id: 6, keywords: ['hand editing', 'print', 'manuscript', 'editing', 'revision'] },
  { id: 37, title: 'Series Architecture: How to Build Read-Through Before the Second Book Exists',                      category: 'Craft & Career',       category_id: 6, keywords: ['series architecture', 'read-through', 'series', 'structure', 'hook'] },
  { id: 38, title: 'Short Stories as a Career Tool: The 10,000-Word Format That Builds Series Readers',                 category: 'Craft & Career',       category_id: 6, keywords: ['short story', 'novella', 'series', 'format', 'mystery'] },
  { id: 39, title: 'Theme Over Mystery Boxes: What *The Leftovers* Teaches About Story Resonance',                      category: 'Craft & Career',       category_id: 6, keywords: ['theme', 'mystery box', 'leftovers', 'story', 'resonance'] },
  { id: 40, title: 'Writing to Market Without Selling Out: Where the Line Actually Falls',                              category: 'Craft & Career',       category_id: 6, keywords: ['writing to market', 'genre', 'selling out', 'commercial', 'niche'] },
  { id: 41, title: 'How to Manage Three Story Ideas Without Abandoning Your Current Draft',                             category: 'Craft & Career',       category_id: 6, keywords: ['story ideas', 'multiple projects', 'draft', 'focus', 'productivity'] },
  { id: 42, title: 'Sustainable vs. Aggressive Marketing: Why Low-Key Works — and for Whom',                           category: 'Craft & Career',       category_id: 6, keywords: ['sustainable', 'marketing', 'burnout', 'low-key', 'personality'] },
  { id: 43, title: 'The Prequel Problem: What *Better Call Saul* Teaches About Character Continuity',                  category: 'Craft & Career',       category_id: 6, keywords: ['prequel', 'better call saul', 'character', 'continuity', 'series'] },
  { id: 44, title: 'When to Stop Editing: The Decision Most Indie Authors Get Wrong',                                   category: 'Craft & Career',       category_id: 6, keywords: ['stop editing', 'editing', 'perfection', 'publish', 'done'] },
]

const DELAY_MS = 3000

// ── Source file parser ────────────────────────────────────────────────────────
function parseSourceFiles() {
  const articles = []
  const files    = ['jane_friedman.txt', 'kindlepreneur.txt', 'alli.txt',
                    'david_gaughran.txt', 'joanna_penn.txt', 'mark_dawson.txt']

  for (const file of files) {
    const path = resolve(SOURCES_DIR, file)
    if (!existsSync(path)) continue

    const source = file.replace('.txt', '').replace(/_/g, ' ')
    const text   = readFileSync(path, 'utf8')

    // Split by separator (both dash variants)
    const chunks = text.split(/\n-{5,}\n/)

    for (const chunk of chunks) {
      if (chunk.trim().length < 100) continue

      // Try structured format: TITLE: / DATE:
      const titleMatch  = chunk.match(/^TITLE:\s*(.+)/m)
      const authorMatch = chunk.match(/^AUTHOR:\s*(.+)/m)
      const topicMatch  = chunk.match(/^TOPIC:\s*(.+)/m)

      // Try Gaughran/Penn format: first line is title, "Posted by" line has date
      const postedMatch = chunk.match(/Posted by .+ (\w+ \d+,? \d{4})/i)
      const firstLine   = chunk.split('\n').find(l => l.trim().length > 10)?.trim() || ''

      articles.push({
        source:  authorMatch?.[ 1]?.trim() || source,
        title:   titleMatch?.[ 1]?.trim()  || firstLine.slice(0, 120),
        topic:   topicMatch?.[ 1]?.trim()  || '',
        // First 1200 chars of body (skip header lines)
        excerpt: chunk.replace(/^(TITLE|AUTHOR|DATE|TOPIC):.*\n/gm, '')
                      .replace(/^-{5,}$/gm, '')
                      .trim()
                      .slice(0, 1200),
      })
    }
  }

  return articles
}

// ── Relevance scoring ─────────────────────────────────────────────────────────
function scoreArticle(article, keywords) {
  const haystack = `${article.title} ${article.topic} ${article.excerpt}`.toLowerCase()
  return keywords.reduce((score, kw) => score + (haystack.includes(kw.toLowerCase()) ? 1 : 0), 0)
}

function findSources(articles, post) {
  return articles
    .map(a => ({ ...a, score: scoreArticle(a, post.keywords) }))
    .filter(a => a.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function toSlug(title) {
  return title.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 60)
}

// ── Claude ────────────────────────────────────────────────────────────────────
async function generatePost(post, sources) {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY })

  const hasSource = sources.length > 0
  const sourceBlock = hasSource
    ? sources.map((s, i) =>
        `SOURCE ${i + 1} — ${s.source}\n"${s.title}"\n${s.excerpt}`
      ).join('\n\n---\n\n')
    : 'Write from your expert knowledge of the indie publishing industry — be specific with data, names, and platform details.'

  const msg = await client.messages.create({
    model:      'claude-opus-4-6',
    max_tokens: 1200,
    messages: [{
      role: 'user',
      content: `You are a senior content editor at KF Books — a platform that helps indie authors protect their IP rights and grow loyal readerships.

${hasSource ? `Below are excerpts from ${sources.length} real articles on this topic:\n\n${sourceBlock}` : sourceBlock}

Write an ORIGINAL analytical post with this exact title: "${post.title}"

Requirements:
- Use the sources as raw material — draw out specific facts, names, platforms, rulings, figures
- Maximum 20% of any single source reflected directly — rest in your own editorial voice
- Take a clear position and argue it — not a neutral overview
- Written for indie authors with 1–3 years of publishing experience
- Strong hook in the first sentence: a specific fact, a hard truth, or a counterintuitive claim
- No filler openers ("In today's publishing landscape…", "As an indie author…", "Publishing has changed…")
- End with one concrete, specific action the reader can take now
- 600–700 words, 5–6 paragraphs

Return ONLY valid JSON (no markdown, no code fences):
{
  "title": "${post.title}",
  "excerpt": "one sharp sentence that makes them click — max 25 words",
  "body": "5-6 paragraphs separated by \\n\\n"
}`,
    }],
  })

  return JSON.parse(msg.content[0].text.trim())
}

// ── Save locally ──────────────────────────────────────────────────────────────
function savePost(post, generated) {
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true })

  const num      = String(post.id).padStart(2, '0')
  const filename = `${num}-${toSlug(post.title)}.md`
  const filepath = resolve(OUTPUT_DIR, filename)

  const content = `---
id: ${post.id}
title: "${generated.title}"
category: "${post.category}"
category_id: ${post.category_id}
excerpt: "${generated.excerpt}"
status: draft
---

${generated.body}
`
  writeFileSync(filepath, content, 'utf8')
  return filename
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Range from CLI args (e.g. node generate-posts.js 1 10)
  const fromArg = parseInt(process.argv[2]) || 1
  const toArg   = parseInt(process.argv[3]) || POSTS.length
  const batch   = POSTS.filter(p => p.id >= fromArg && p.id <= toArg)

  console.log(`📝 Generating posts #${fromArg}–${toArg} (${batch.length} total)`)
  console.log(`📂 Output: ${OUTPUT_DIR}\n`)

  console.log('📚 Parsing source files...')
  const articles = parseSourceFiles()
  console.log(`   ${articles.length} source articles loaded\n`)

  let ok = 0, fail = 0

  for (const post of batch) {
    const sources = findSources(articles, post)
    process.stdout.write(`[${post.id}/${POSTS.length}] "${post.title.slice(0, 60)}…" (${sources.length} sources) ... `)

    try {
      const generated = await generatePost(post, sources)
      const filename  = savePost(post, generated)
      console.log(`✅ ${filename}`)
      ok++
    } catch (err) {
      console.log(`❌ ${err.message}`)
      fail++
    }

    if (post.id < batch[batch.length - 1].id) await sleep(DELAY_MS)
  }

  console.log(`\n── Done ──────────────────────────────────────────`)
  console.log(`Generated: ${ok}   Failed: ${fail}`)
  console.log(`Review files in: ${OUTPUT_DIR}`)
}

main().catch(err => {
  console.error('Fatal:', err.message)
  process.exit(1)
})
