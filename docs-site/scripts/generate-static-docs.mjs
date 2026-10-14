import fs from 'node:fs'
import path from 'node:path'
import { sourceLastModified } from './doc-lastmod.mjs'

const root = process.cwd()
const contentDir = path.join(root, 'src', 'content')
const outDir = path.join(root, 'dist')
const manifestPath = path.join(contentDir, 'page-manifest.json')
const siteUrl = process.env.DOCS_SITE_URL || 'https://docs.memewar.zone'

const escapeXml = (value = '') =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

function parseFrontmatter(raw) {
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) {
    return { data: {}, content: raw }
  }

  const fence = /\r?\n---\r?\n/
  const match = fence.exec(raw)
  if (!match) return { data: {}, content: raw }

  const data = {}
  const block = raw.slice(4, match.index)
  const content = raw.slice(match.index + match[0].length)

  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf(':')
    if (idx === -1) continue
    const key = trimmed.slice(0, idx).trim()
    let value = trimmed.slice(idx + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    data[key] = value
  }

  return { data, content }
}

function loadCanonicalPages() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

  return manifest.pages.map((page) => {
    const file = path.join(contentDir, page.source)
    if (!fs.existsSync(file)) {
      throw new Error(`Missing markdown source for canonical route ${page.route}: ${page.source}`)
    }

    const raw = fs.readFileSync(file, 'utf8')
    const { data, content } = parseFrontmatter(raw)

    return {
      route: page.route,
      source: page.source,
      title: data.title || page.title,
      description: data.description || '',
      content
    }
  })
}

if (!fs.existsSync(outDir)) {
  throw new Error('dist does not exist. Run the Vite build before generating docs artifacts.')
}

const pages = loadCanonicalPages()

const lastModified = sourceLastModified(contentDir, pages.map((page) => page.source))

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages
  .map((page) => {
    const lastmod = lastModified[page.source] ? `<lastmod>${lastModified[page.source]}</lastmod>` : ''
    return `  <url><loc>${siteUrl}${page.route}</loc>${lastmod}</url>`
  })
  .join('\n')}\n</urlset>\n`

fs.writeFileSync(path.join(outDir, 'sitemap.xml'), sitemap)

const feed = `<?xml version="1.0" encoding="UTF-8"?>\n<docs generated="${new Date().toISOString()}">\n${pages
  .map(
    (page) => `  <page>\n    <loc>${siteUrl}${page.route}</loc>\n    <title>${escapeXml(page.title)}</title>\n    <description>${escapeXml(page.description)}</description>\n    <content>${escapeXml(page.content.trim())}</content>\n  </page>`
  )
  .join('\n')}\n</docs>\n`

fs.writeFileSync(path.join(outDir, 'docs-feed.xml'), feed)

console.log(`Generated sitemap.xml and docs-feed.xml for ${pages.length} canonical pages`)
