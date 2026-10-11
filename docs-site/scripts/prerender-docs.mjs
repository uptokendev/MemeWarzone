// Writes one HTML file per canonical route (dist/<route>.html) with that page's title, description,
// canonical link, JSON-LD and the rendered markdown inside #root, so crawlers get the real page
// without running JavaScript. React replaces #root on load, so readers see the normal app.
// Netlify serves the files through explicit 200 rewrites written in front of the SPA fallback,
// and every alias gets a 301 to its canonical route.
import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { sourceLastModified } from './doc-lastmod.mjs'

const root = process.cwd()
const contentDir = path.join(root, 'src', 'content')
const distDir = path.join(root, 'dist')
const manifestPath = path.join(contentDir, 'page-manifest.json')
const siteUrl = process.env.DOCS_SITE_URL || 'https://docs.memewar.zone'
const ogImage = 'https://app.memewar.zone/assets/og-20260825.png'

const escapeHtml = (value = '') =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

function parseFrontmatter(raw) {
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) return { data: {}, content: raw }
  const match = /\r?\n---\r?\n/.exec(raw)
  if (!match) return { data: {}, content: raw }
  const data = {}
  for (const line of raw.slice(4, match.index).split(/\r?\n/)) {
    const trimmed = line.trim()
    const idx = trimmed.indexOf(':')
    if (!trimmed || trimmed.startsWith('#') || idx === -1) continue
    let value = trimmed.slice(idx + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    data[trimmed.slice(0, idx).trim()] = value
  }
  return { data, content: raw.slice(match.index + match[0].length) }
}

// Same resolution as DocPage: relative and .md links become site routes.
function resolveHref(href, source) {
  if (!href || href.startsWith('#') || /^(https?:|mailto:|tel:)/.test(href)) return href
  const sourceDir = path.posix.dirname(`/${source}`)
  const resolved = new URL(href.replace(/\.md(?=[#?]|$)/, ''), `https://x${sourceDir}/`)
  const pathname = resolved.pathname.replace(/\/index$/, '').replace(/(.)\/$/, '$1')
  return `${pathname}${resolved.hash}`
}

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
}

function textOf(children) {
  return React.Children.toArray(children)
    .map((child) => (typeof child === 'string' ? child : textOf(child?.props?.children)))
    .join('')
}

function renderMarkdown(content, source) {
  const heading = (Tag) =>
    function Heading({ children }) {
      return React.createElement(Tag, { id: slugify(textOf(children)) }, children)
    }
  return renderToStaticMarkup(
    React.createElement(
      ReactMarkdown,
      {
        remarkPlugins: [remarkGfm],
        components: {
          a: ({ href, children }) => React.createElement('a', { href: resolveHref(href, source) }, children),
          h2: heading('h2'),
          h3: heading('h3')
        }
      },
      content
    )
  )
}

function jsonLd(page, url) {
  const crumbs = [{ name: 'Docs', item: `${siteUrl}/introduction` }]
  if (page.group) crumbs.push({ name: page.group })
  crumbs.push({ name: page.title, item: url })
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'TechArticle',
        '@id': `${url}#article`,
        headline: page.title,
        description: page.description || undefined,
        url,
        inLanguage: 'en',
        isPartOf: { '@id': `${siteUrl}/#website` },
        about: { '@id': 'https://app.memewar.zone/#app' },
        publisher: { '@id': 'https://memewar.zone/#organization' },
        dateModified: page.lastModified || undefined
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: crumbs.map((crumb, index) => ({
          '@type': 'ListItem',
          position: index + 1,
          name: crumb.name,
          ...(crumb.item ? { item: crumb.item } : {})
        }))
      }
    ]
  }
}

function renderPage(shell, page) {
  const url = `${siteUrl}${page.route}`
  const title = `${page.title} | MemeWarzone Docs`
  const description = page.description || ''
  const head = [
    `<link rel="canonical" href="${url}" />`,
    `<meta property="og:type" content="article" />`,
    `<meta property="og:site_name" content="MemeWarzone Docs" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:description" content="${escapeHtml(description)}" />`,
    `<meta property="og:image" content="${ogImage}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:site" content="@memewarzone" />`,
    `<script type="application/ld+json">${JSON.stringify(jsonLd(page, url)).replace(/</g, '\\u003c')}</script>`
  ].join('\n    ')
  const body = `<main class="mx-auto max-w-3xl px-4 py-10"><article><h1>${escapeHtml(page.title)}</h1>${
    description ? `<p>${escapeHtml(description)}</p>` : ''
  }${renderMarkdown(page.content, page.source)}</article></main>`

  let html = shell
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`)
    .replace('<!--page-meta-->', head)
    .replace('<div id="root"></div>', `<div id="root">${body}</div>`)
  if (description) {
    html = html.replace(
      /<meta name="description" content="[^"]*" \/>/,
      `<meta name="description" content="${escapeHtml(description)}" />`
    )
  }
  return html
}

function main() {
  const shellPath = path.join(distDir, 'index.html')
  if (!fs.existsSync(shellPath)) throw new Error('dist/index.html is missing. Run the Vite build first.')
  const shell = fs.readFileSync(shellPath, 'utf8')
  for (const marker of ['<!--page-meta-->', '<div id="root"></div>', '<meta name="description"']) {
    if (!shell.includes(marker)) throw new Error(`dist/index.html is missing ${marker}`)
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const lastModified = sourceLastModified(contentDir, manifest.pages.map((entry) => entry.source))
  const rewrites = []
  const redirects = []
  const seen = new Set()

  for (const entry of manifest.pages) {
    if (seen.has(entry.route)) continue
    seen.add(entry.route)
    const raw = fs.readFileSync(path.join(contentDir, entry.source), 'utf8')
    const { data, content } = parseFrontmatter(raw)
    const page = {
      route: entry.route,
      source: entry.source,
      group: entry.group,
      title: data.title || entry.title,
      description: data.description || '',
      content,
      lastModified: lastModified[entry.source]
    }
    const outFile = path.join(distDir, `${entry.route.replace(/^\//, '')}.html`)
    fs.mkdirSync(path.dirname(outFile), { recursive: true })
    fs.writeFileSync(outFile, renderPage(shell, page))
    rewrites.push(`${entry.route} ${entry.route}.html 200`)
    for (const alias of entry.aliases || []) {
      if (alias !== entry.route) redirects.push(`${alias} ${entry.route} 301`)
    }
  }

  const redirectsPath = path.join(distDir, '_redirects')
  const existing = fs.readFileSync(redirectsPath, 'utf8')
  fs.writeFileSync(
    redirectsPath,
    [`/ /introduction 301!`, ...redirects, ...rewrites, existing.trim()].join('\n') + '\n'
  )
  console.log(`Prerendered ${rewrites.length} routes, ${redirects.length} alias redirects`)
}

main()
