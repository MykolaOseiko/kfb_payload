import path from 'path'
import { fileURLToPath } from 'url'
import { buildConfig } from 'payload'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { lexicalEditor } from '@payloadcms/richtext-lexical'

import { Posts } from './collections/Posts'
import { Categories } from './collections/Categories'
import { Media } from './collections/Media'
import { EmailTemplates } from './collections/EmailTemplates'
import { Users } from './collections/Users'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

export default buildConfig({
  serverURL: process.env.NEXT_PUBLIC_SERVER_URL || 'http://localhost:3001',

  admin: {
    user: Users.slug,
    importMap: {
      baseDir: path.resolve(dirname),
    },
  },

  collections: [Posts, Categories, Media, EmailTemplates, Users],

  localization: {
    locales: [
      { label: 'Українська', code: 'uk' },
      { label: 'English', code: 'en' },
    ],
    defaultLocale: 'uk',
    fallback: true,
  },

  editor: lexicalEditor(),

  db: postgresAdapter({
    pool: {
      connectionString: process.env.DATABASE_URI || '',
    },
    schemaName: 'payload',
  }),

  secret: process.env.PAYLOAD_SECRET || '',

  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },

  upload: {
    limits: {
      fileSize: 5_000_000, // 5 MB
    },
  },

  // Allow the main site to fetch from this API
  cors: [
    'https://payload.kfbooks.eu',
    'https://kfbooks.eu',
    'http://localhost:3000',
    'http://localhost:3001',
  ],

  csrf: [
    'https://payload.kfbooks.eu',
    'https://kfbooks.eu',
    'http://localhost:3000',
    'http://localhost:3001',
  ],
})
