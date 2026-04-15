# Інтеграція блогу: Payload CMS → kfbooks.eu

## 1. Що таке Payload у цьому проекті

Payload CMS — окремий Next.js 15 застосунок, що живе поруч з основним сайтом.

```
_KFB_payload/   → адмінка + REST API      (порт 3001, payload.kfbooks.eu)
_KFB_site/      → публічний сайт          (порт 3000, kfbooks.eu)
```

**Що Payload робить:**
- Зберігає пости (Posts), категорії (Categories), медіа (Media) у схемі `payload` тієї ж Supabase бази
- Надає REST API: `https://payload.kfbooks.eu/api/posts`, `/api/categories` тощо
- Підтримує локалізацію uk/en із коробки
- Адмін UI доступний за `/admin` — там редагується весь контент

**Що Payload НЕ робить:**
- Не рендерить публічні сторінки блогу — це завдання основного сайту
- Не торкається таблиць у схемі `public` Supabase (читачі, автори, роялті)

---

## 2. Що треба зробити на основному сайті (`_KFB_site`)

### Крок 1 — Типи даних

Створити файл `src/lib/payload.ts` з типами і функціями для фетчингу:

```ts
// src/lib/payload.ts

const PAYLOAD_URL = process.env.NEXT_PUBLIC_PAYLOAD_URL ?? 'https://payload.kfbooks.eu'

export type Post = {
  id: number
  slug: string
  title: string          // локалізоване поле
  excerpt?: string       // локалізоване поле
  content: unknown       // Lexical JSON — рендериться окремо
  publishedAt: string
  category?: { id: number; title: string }
  heroImage?: { url: string; alt: string }
}

export type PostsResponse = {
  docs: Post[]
  totalDocs: number
  totalPages: number
  page: number
}

export async function getPosts(params?: {
  locale?: 'uk' | 'en'
  page?: number
  limit?: number
  category?: string
}): Promise<PostsResponse> {
  const { locale = 'uk', page = 1, limit = 10, category } = params ?? {}
  const qs = new URLSearchParams({
    locale,
    page: String(page),
    limit: String(limit),
    'where[_status][equals]': 'published',
    sort: '-publishedAt',
    depth: '1',
  })
  if (category) qs.set('where[category.slug][equals]', category)

  const res = await fetch(`${PAYLOAD_URL}/api/posts?${qs}`, {
    next: { revalidate: 3600 }, // ISR: перебудова кожну годину
  })
  if (!res.ok) throw new Error(`Payload API error: ${res.status}`)
  return res.json()
}

export async function getPostBySlug(slug: string, locale: 'uk' | 'en' = 'uk'): Promise<Post | null> {
  const qs = new URLSearchParams({
    locale,
    'where[slug][equals]': slug,
    depth: '2',
    limit: '1',
  })
  const res = await fetch(`${PAYLOAD_URL}/api/posts?${qs}`, {
    next: { revalidate: 3600 },
  })
  if (!res.ok) return null
  const data: PostsResponse = await res.json()
  return data.docs[0] ?? null
}
```

---

### Крок 2 — Змінна середовища

Додати до `_KFB_site/.env.local` (і до `.env.example`):

```env
NEXT_PUBLIC_PAYLOAD_URL=https://payload.kfbooks.eu
```

При локальній розробці Payload крутиться на порту 3001, тому локально:
```env
NEXT_PUBLIC_PAYLOAD_URL=http://localhost:3001
```

---

### Крок 3 — Сторінка списку `/blog`

Створити `src/app/blog/page.tsx`:

```tsx
import Link from 'next/link'
import { PublicNav } from '@/components/layout/PublicNav'
import { PublicFooter } from '@/components/layout/PublicFooter'
import { getPosts } from '@/lib/payload'

export const revalidate = 3600

export default async function BlogPage() {
  const { docs: posts } = await getPosts({ locale: 'uk', limit: 20 })

  return (
    <div className="flex flex-col min-h-screen">
      <PublicNav />
      <main className="page-layout">
        <div className="page-container" style={{ maxWidth: '800px', margin: '0 auto', padding: '48px 24px' }}>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '2rem', marginBottom: '32px' }}>
            Блог
          </h1>
          <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: '24px' }}>
            {posts.map((post) => (
              <li key={post.id}>
                <Link href={`/blog/${post.slug}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                  <article>
                    <time style={{ fontSize: '13px', color: 'var(--color-muted)' }}>
                      {new Date(post.publishedAt).toLocaleDateString('uk-UA')}
                    </time>
                    <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '1.3rem', margin: '6px 0 8px' }}>
                      {post.title}
                    </h2>
                    {post.excerpt && (
                      <p style={{ color: 'var(--color-muted)', fontSize: '15px' }}>{post.excerpt}</p>
                    )}
                  </article>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </main>
      <PublicFooter />
    </div>
  )
}
```

---

### Крок 4 — Сторінка окремого поста `/blog/[slug]`

Встановити рендерер Lexical-контенту:
```bash
npm install @payloadcms/richtext-lexical
```
> Альтернатива без залежності — написати мінімальний рекурсивний рендерер самостійно (описано нижче).

Створити `src/app/blog/[slug]/page.tsx`:

```tsx
import { notFound } from 'next/navigation'
import { PublicNav } from '@/components/layout/PublicNav'
import { PublicFooter } from '@/components/layout/PublicFooter'
import { getPostBySlug, getPosts } from '@/lib/payload'
import { LexicalRenderer } from '@/components/blog/LexicalRenderer'

export const revalidate = 3600

export async function generateStaticParams() {
  const { docs } = await getPosts({ locale: 'uk', limit: 100 })
  return docs.map((p) => ({ slug: p.slug }))
}

export default async function PostPage({ params }: { params: { slug: string } }) {
  const post = await getPostBySlug(params.slug, 'uk')
  if (!post) notFound()

  return (
    <div className="flex flex-col min-h-screen">
      <PublicNav />
      <main className="page-layout">
        <article style={{ maxWidth: '720px', margin: '0 auto', padding: '48px 24px' }}>
          {post.heroImage && (
            <img
              src={post.heroImage.url}
              alt={post.heroImage.alt}
              style={{ width: '100%', borderRadius: '12px', marginBottom: '32px' }}
            />
          )}
          <time style={{ fontSize: '13px', color: 'var(--color-muted)' }}>
            {new Date(post.publishedAt).toLocaleDateString('uk-UA')}
          </time>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '2rem', margin: '12px 0 24px' }}>
            {post.title}
          </h1>
          <LexicalRenderer content={post.content} />
        </article>
      </main>
      <PublicFooter />
    </div>
  )
}
```

---

### Крок 5 — Компонент для Lexical-контенту

Payload зберігає richText у форматі Lexical JSON. Потрібен компонент для рендерингу.

Створити `src/components/blog/LexicalRenderer.tsx`:

```tsx
// Мінімальний рендерер Lexical-вузлів без зовнішніх залежностей
type LexicalNode = {
  type: string
  tag?: string
  text?: string
  format?: number
  url?: string
  children?: LexicalNode[]
}

type LexicalRoot = {
  root: { children: LexicalNode[] }
}

function renderNode(node: LexicalNode, key: number): React.ReactNode {
  switch (node.type) {
    case 'paragraph':
      return <p key={key}>{node.children?.map(renderNode)}</p>
    case 'heading':
      const Tag = (node.tag ?? 'h2') as keyof JSX.IntrinsicElements
      return <Tag key={key}>{node.children?.map(renderNode)}</Tag>
    case 'text': {
      let el: React.ReactNode = node.text
      if (node.format) {
        if (node.format & 1) el = <strong>{el}</strong>
        if (node.format & 2) el = <em>{el}</em>
        if (node.format & 8) el = <u>{el}</u>
      }
      return <span key={key}>{el}</span>
    }
    case 'link':
      return <a key={key} href={node.url}>{node.children?.map(renderNode)}</a>
    case 'list':
      return node.tag === 'ol'
        ? <ol key={key}>{node.children?.map(renderNode)}</ol>
        : <ul key={key}>{node.children?.map(renderNode)}</ul>
    case 'listitem':
      return <li key={key}>{node.children?.map(renderNode)}</li>
    case 'quote':
      return <blockquote key={key}>{node.children?.map(renderNode)}</blockquote>
    default:
      return null
  }
}

export function LexicalRenderer({ content }: { content: unknown }) {
  if (!content) return null
  const { root } = content as LexicalRoot
  return (
    <div className="prose">
      {root.children.map((node, i) => renderNode(node, i))}
    </div>
  )
}
```

---

### Крок 6 — Посилання в навігації

У `src/components/layout/PublicNav.tsx` додати посилання на блог у список навігаційних пунктів:

```tsx
<Link href="/blog">Блог</Link>
```

---

### Крок 7 — next.config.mjs (дозвіл на зображення з Payload)

Додати домен Payload до `images.remotePatterns`:

```js
// _KFB_site/next.config.mjs
const nextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'payload.kfbooks.eu',
        pathname: '/media/**',
      },
    ],
  },
}
```

Якщо `next/image` не використовується — цей крок пропустити.

---

## Підсумок змін у `_KFB_site`

| Файл | Дія |
|------|-----|
| `src/lib/payload.ts` | Створити — типи і fetch-функції |
| `.env.local` | Додати `NEXT_PUBLIC_PAYLOAD_URL` |
| `src/app/blog/page.tsx` | Створити — список постів |
| `src/app/blog/[slug]/page.tsx` | Створити — окремий пост |
| `src/components/blog/LexicalRenderer.tsx` | Створити — рендер richText |
| `src/components/layout/PublicNav.tsx` | Змінити — додати посилання «Блог» |
| `next.config.mjs` | Змінити — дозвіл на зображення з payload.kfbooks.eu |

**Жодні залежності додавати не потрібно** — всі зміни чистий Next.js + fetch.
