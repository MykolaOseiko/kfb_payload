#!/usr/bin/env node
/**
 * KFBooks Post Uploader
 *
 * Reads generated/*.md files and creates draft posts in Payload CMS.
 *
 * Usage:
 *   node upload-posts.js           — upload all .md files in generated/
 *   node upload-posts.js 1 10      — upload only posts with id 1–10
 *   node upload-posts.js --dry-run — print what would be uploaded, no API calls
 */

import { readFileSync, readdirSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── Load .env ─────────────────────────────────────────────────────────────────
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
} = process.env

const GENERATED_DIR = resolve(__dirname, 'generated')
const DRY_RUN       = process.argv.includes('--dry-run')
const fromArg       = parseInt(process.argv.find((a, i) => i === 2 && !a.startsWith('--'))) || 1
const toArg         = parseInt(process.argv.find((a, i) => i === 3 && !a.startsWith('--'))) || 9999

const DELAY_MS = 800

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// Parse frontmatter + body from .md files
function parseMd(filepath) {
  const raw = readFileSync(filepath, 'utf8')

  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/m)
  if (!fmMatch) throw new Error(`No frontmatter in ${filepath}`)

  const fm   = fmMatch[1]
  const body = fmMatch[2].trim()

  const get = (key) => {
    const m = fm.match(new RegExp(`^${key}:\\s*"?([^"\\n]+)"?`, 'm'))
    return m ? m[1].trim() : null
  }

  return {
    id:          parseInt(get('id')),
    title:       get('title'),
    excerpt:     get('excerpt'),
    category_id: parseInt(get('category_id')),
    body,
  }
}

// Convert plain paragraphs to Lexical JSON (Payload rich text format)
function toLexi(text) {
  const paras = text.split(/\n\n+/).map(p => p.trim()).filter(Boolean)
  return {
    root: {
      type: 'root', version: 1, direction: 'ltr', format: '', indent: 0,
      children: paras.map(para => ({
        type: 'paragraph', version: 1, direction: 'ltr', format: '', indent: 0,
        children: [{
          type: 'text', version: 1, text: para,
          format: 0, detail: 0, mode: 'normal', style: '',
        }],
      })),
    },
  }
}

function toSlug(title, id) {
  return title.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 60)
    + '-' + id
}

// ── Payload API ───────────────────────────────────────────────────────────────
async function getToken() {
  const res  = await fetch(`${PAYLOAD_URL}/api/users/login`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ email: PAYLOAD_EMAIL, password: PAYLOAD_PASSWORD }),
  })
  const data = await res.json()
  if (!data.token) throw new Error('Login failed: ' + JSON.stringify(data))
  return data.token
}

async function postExists(token, slug) {
  const res  = await fetch(`${PAYLOAD_URL}/api/posts?where[slug][equals]=${encodeURIComponent(slug)}&locale=en`, {
    headers: { Authorization: `JWT ${token}` },
  })
  const data = await res.json()
  return data.totalDocs > 0
}

async function createPost(token, { title, excerpt, body, category_id, id }) {
  const slug = toSlug(title, id)

  const res  = await fetch(`${PAYLOAD_URL}/api/posts?locale=en`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `JWT ${token}` },
    body: JSON.stringify({
      title,
      slug,
      excerpt,
      content:  toLexi(body),
      status:   'draft',
      category: category_id,
    }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(JSON.stringify(data.errors || data))
  return data.doc
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!existsSync(GENERATED_DIR)) {
    console.error(`❌ No generated/ folder found at: ${GENERATED_DIR}`)
    console.error('   Run generate-posts.js first.')
    process.exit(1)
  }

  const files = readdirSync(GENERATED_DIR)
    .filter(f => f.endsWith('.md'))
    .sort()

  if (files.length === 0) {
    console.error('❌ No .md files found in generated/')
    process.exit(1)
  }

  // Parse all files, filter by id range
  const posts = files
    .map(f => {
      try { return parseMd(resolve(GENERATED_DIR, f)) }
      catch (e) { console.warn(`⚠️  Skip ${f}: ${e.message}`); return null }
    })
    .filter(Boolean)
    .filter(p => p.id >= fromArg && p.id <= toArg)

  console.log(`📤 Upload posts #${fromArg}–${toArg} (${posts.length} files)`)
  console.log(`   Target: ${PAYLOAD_URL}`)
  if (DRY_RUN) console.log('   Mode: DRY RUN — no API calls\n')
  else         console.log()

  if (DRY_RUN) {
    for (const p of posts) {
      console.log(`  [${p.id}] "${p.title}" → category ${p.category_id}`)
    }
    console.log(`\n${posts.length} posts would be uploaded.`)
    return
  }

  const token = await getToken()
  console.log('✅ Authenticated\n')

  let ok = 0, skipped = 0, failed = 0

  for (const post of posts) {
    const slug = toSlug(post.title, post.id)
    process.stdout.write(`[${post.id}] "${post.title.slice(0, 55)}…" `)

    try {
      const exists = await postExists(token, slug)
      if (exists) {
        console.log('⏭️  already exists')
        skipped++
      } else {
        await createPost(token, post)
        console.log('✅')
        ok++
        await sleep(DELAY_MS)
      }
    } catch (err) {
      console.log(`❌ ${err.message}`)
      failed++
    }
  }

  console.log('\n── Done ──────────────────────────────────────────')
  console.log(`Uploaded: ${ok}   Skipped: ${skipped}   Failed: ${failed}`)
  console.log(`Review: ${PAYLOAD_URL}/admin/collections/posts`)
}

main().catch(err => {
  console.error('Fatal:', err.message)
  process.exit(1)
})
