#!/usr/bin/env node
/**
 * Creates 4 blog categories in Payload CMS.
 * Run once: node create-categories.js
 */

import { readFileSync } from 'fs'
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

const {
  PAYLOAD_URL = 'https://payload.kfbooks.eu',
  PAYLOAD_EMAIL,
  PAYLOAD_PASSWORD,
} = process.env

const CATEGORIES = [
  { title: 'Rights & AI' },
  { title: 'Marketing & Promotion' },
  { title: 'Platforms & Sales' },
  { title: 'Craft & Career' },
]

async function getToken() {
  const res  = await fetch(`${PAYLOAD_URL}/api/users/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: PAYLOAD_EMAIL, password: PAYLOAD_PASSWORD }),
  })
  const data = await res.json()
  if (!data.token) throw new Error('Login failed: ' + JSON.stringify(data))
  return data.token
}

async function main() {
  const token = await getToken()
  console.log('✅ Authenticated\n')

  for (const cat of CATEGORIES) {
    const res  = await fetch(`${PAYLOAD_URL}/api/categories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `JWT ${token}` },
      body: JSON.stringify(cat),
    })
    const data = await res.json()
    if (res.ok) {
      console.log(`✅ Created: "${data.doc.title}" → ID ${data.doc.id}`)
    } else {
      console.log(`❌ Failed "${cat.title}": ${JSON.stringify(data.errors || data)}`)
    }
  }
}

main().catch(err => {
  console.error('Fatal:', err.message)
  process.exit(1)
})
