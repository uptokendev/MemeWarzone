import { useEffect, useMemo } from 'react'
import { useLocation, Link } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import Toc from './Toc'
import PrevNext from './PrevNext'
import { getPageByPath, getSourcePathByRoute, normalizePath } from '../content/loader'
import { getCanonicalPage } from '../content/sidebar'
import { parseFrontmatter } from '../lib/frontmatter'
import FaqContent from './FaqContent'
import { buildFaqToc, parseFaqMarkdown } from '../lib/faq'
import RoadmapBattlefield from './RoadmapBattlefield'
import ReadinessBanner from './ReadinessBanner'

function resolveDocLinkHref(href: string, sourcePath: string | null) {
  if (!href) return null

  if (href.startsWith('#')) {
    return { kind: 'anchor' as const, href }
  }

  if (/\.[a-z0-9]+(?=[#?]|$)/i.test(href) && !/\.md(?=[#?]|$)/i.test(href)) {
    return { kind: 'anchor' as const, href }
  }

  const externalSchemes = ['http://', 'https://', 'mailto:', 'tel:']
  if (externalSchemes.some((scheme) => href.startsWith(scheme))) {
    const url = new URL(href, 'https://docs.memewar.zone')
    if (url.origin !== 'https://docs.memewar.zone') {
      return { kind: 'external' as const, href }
    }

    const internalPath = `${url.pathname === '/' ? '/introduction' : url.pathname}${url.hash}`
    return { kind: 'internal' as const, href: internalPath }
  }

  const resolvedSourcePath = sourcePath ?? '/introduction'
  const sourceDir = resolvedSourcePath.endsWith('/index')
    ? resolvedSourcePath.slice(0, -'/index'.length)
    : resolvedSourcePath.split('/').slice(0, -1).join('/') || '/'
  const basePath = sourceDir.endsWith('/') ? sourceDir : `${sourceDir}/`
  const normalizedHref = href.replace(/\.md(?=[#?]|$)/, '')
  const resolved = new URL(normalizedHref, `https://docs.memewar.zone${basePath}`)

  let pathname = resolved.pathname.replace(/\/index$/, '')
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1)
  }

  return {
    kind: 'internal' as const,
    href: `${pathname || '/introduction'}${resolved.hash}`
  }
}

export default function DocPage() {
  const loc = useLocation()
  const path = useMemo(() => normalizePath(loc.pathname), [loc.pathname])

  const raw = useMemo(() => getPageByPath(path), [path])
  const sourcePath = useMemo(() => getSourcePathByRoute(path), [path])
  const pageMeta = useMemo(() => getCanonicalPage(path), [path])
  const { data, content } = useMemo(() => parseFrontmatter(raw ?? ''), [raw])

  const title = (data.title as string) || 'Not found'
  const description = (data.description as string) || ''
  const toc = useMemo(() => {
    if (!raw) return []
    if (path === '/faq') {
      const parsed = parseFaqMarkdown(content)
      return buildFaqToc(parsed)
    }

    const lines = content.split('\n')
    const headings: { depth: number; text: string; id: string }[] = []
    for (const line of lines) {
      const m = /^(#{2,3})\s+(.+)$/.exec(line.trim())
      if (!m) continue
      const depth = m[1].length
      const text = m[2].trim()
      const id = text
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
      headings.push({ depth, text, id })
    }
    return headings
  }, [raw, content, path])

  useEffect(() => {
    document.title = raw ? `${title} | MemeWarzone Docs` : 'MemeWarzone Docs'
    const meta = document.querySelector('meta[name="description"]')
    if (meta && description) meta.setAttribute('content', description)
  }, [raw, title, description])

  if (!raw) {
    return (
      <div className="mb-panel rounded-[1.75rem] p-8">
        <h1 className="mb-2 text-2xl font-bold">Page not found</h1>
        <p className="mb-6 text-mb-muted">
          The route <code>{path}</code> does not exist yet.
        </p>
        <Link to="/getting-started" className="mb-outline-button inline-flex rounded-2xl px-4 py-2.5">
          Go to Getting Started
        </Link>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-8 xl:grid-cols-[1fr_280px]">
      <article className="min-w-0">
        <div className="mb-panel rounded-[1.9rem] p-6 sm:p-8 lg:p-9">
          <div className="mb-8 border-b border-mb-border/40 pb-6">
            <div className="mb-3 inline-flex items-center rounded-full border border-mb-accent/30 bg-mb-panel2/70 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.28em] text-mb-accent2 shadow-[0_0_22px_rgba(240,106,26,0.08)]">
              MemeWarzone Docs
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-mb-text sm:text-4xl">{title}</h1>
            {description && <p className="mt-3 max-w-3xl text-mb-muted">{description}</p>}
          </div>

          {path === '/roadmap' && <RoadmapBattlefield />}

          {pageMeta && (
            <ReadinessBanner status={pageMeta.status} note={pageMeta.statusNote} />
          )}

          <div className="prose-mb text-mb-text">
            {path === '/faq' ? (
              <FaqContent markdown={content} />
            ) : (
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  h2: ({ node, ...props }) => {
                    const text = String(props.children)
                    const id = text
                      .toLowerCase()
                      .replace(/[^a-z0-9\s-]/g, '')
                      .replace(/\s+/g, '-')
                    return <h2 id={id} className="mt-12 mb-4 text-2xl font-semibold text-mb-text" {...props} />
                  },
                  h3: ({ node, ...props }) => {
                    const text = String(props.children)
                    const id = text
                      .toLowerCase()
                      .replace(/[^a-z0-9\s-]/g, '')
                      .replace(/\s+/g, '-')
                    return <h3 id={id} className="mt-8 mb-3 text-xl font-semibold text-mb-text" {...props} />
                  },
                  p: ({ node, ...props }) => <p className="my-4 leading-7 text-mb-text/95" {...props} />,
                  ul: ({ node, ...props }) => <ul className="my-4 list-disc space-y-2 pl-6" {...props} />,
                  ol: ({ node, ...props }) => <ol className="my-4 list-decimal space-y-2 pl-6" {...props} />,
                  blockquote: ({ node, ...props }) => (
                    <blockquote className="my-5 border-l-2 border-mb-accent/60 pl-4 text-mb-muted" {...props} />
                  ),
                  a: ({ node, href = '', children, ...props }) => {
                    const resolved = resolveDocLinkHref(href, sourcePath)

                    if (!resolved || resolved.kind === 'anchor') {
                      return (
                        <a href={href} className="text-mb-accent2 hover:text-mb-accent2/95" {...props}>
                          {children}
                        </a>
                      )
                    }

                    if (resolved.kind === 'external') {
                      return (
                        <a
                          href={resolved.href}
                          className="text-mb-accent2 hover:text-mb-accent2/95"
                          target="_blank"
                          rel="noreferrer"
                          {...props}
                        >
                          {children}
                        </a>
                      )
                    }

                    return (
                      <Link to={resolved.href} className="text-mb-accent2 hover:text-mb-accent2/95">
                        {children}
                      </Link>
                    )
                  }
                }}
              >
                {content}
              </ReactMarkdown>
            )}
          </div>

          <div className="mt-10 border-t border-mb-border/40 pt-6">
            <PrevNext currentPath={path} />
          </div>
        </div>
      </article>

      <aside className="hidden xl:block sticky top-24 h-[calc(100vh-112px)]">
        <div className="mb-panel rounded-[1.6rem] p-4">
          <div className="mb-3 text-xs uppercase tracking-[0.24em] text-mb-muted">On this page</div>
          <Toc items={toc} />
        </div>
      </aside>
    </div>
  )
}
