import { useEffect, useMemo, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import clsx from 'clsx'
import { sidebar } from '../content/sidebar'
import { normalizePath } from '../content/loader'

type Props = {
  onNavigate?: () => void
}

export default function Sidebar({ onNavigate }: Props) {
  const loc = useLocation()
  const [q, setQ] = useState(() => new URLSearchParams(loc.search).get('q') ?? '')

  const currentPath = useMemo(() => normalizePath(loc.pathname), [loc.pathname])
  const activeSectionTitle = useMemo(() => {
    const found = sidebar.find(s => s.items.some(i => i.href === currentPath))
    return found?.title ?? null
  }, [currentPath])

  const [openSection, setOpenSection] = useState<string | null>(activeSectionTitle)
  useEffect(() => {
    setOpenSection(activeSectionTitle)
  }, [activeSectionTitle])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return sidebar

    return sidebar
      .map(section => {
        const items = section.items.filter(i => i.title.toLowerCase().includes(needle))
        return { ...section, items }
      })
      .filter(section => section.items.length > 0)
  }, [q])

  return (
    <div className="mb-panel h-full overflow-hidden rounded-[1.75rem]">
      <div className="border-b border-mb-border/60 p-3">
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search docs…"
          className="mb-input w-full rounded-2xl px-3 py-2.5 text-sm"
        />
      </div>

      <div className="h-[calc(100%-64px)] space-y-5 overflow-auto p-3">
        {filtered.map(section => (
          <div key={section.title}>
            <button
              type="button"
              onClick={() => {
                if (q.trim()) return
                setOpenSection(prev => (prev === section.title ? null : section.title))
              }}
              className="mb-2 flex w-full items-center justify-between px-1 text-xs uppercase tracking-[0.24em] text-mb-muted"
              aria-expanded={q.trim() ? true : openSection === section.title}
            >
              <span>{section.title}</span>
              <span
                className={clsx(
                  'transition-transform text-mb-accent',
                  q.trim() ? 'rotate-180' : openSection === section.title ? 'rotate-180' : 'rotate-0'
                )}
                aria-hidden
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            </button>

            {(q.trim() || openSection === section.title) && (
              <div className="space-y-1.5">
                {section.items.map(item => (
                  <NavLink
                    key={item.href}
                    to={item.href}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      clsx(
                        'block rounded-2xl border px-3 py-2.5 text-sm transition-all',
                        isActive
                          ? 'border-mb-accent/45 bg-[linear-gradient(180deg,rgba(255,138,42,0.16),rgba(240,106,26,0.08))] shadow-glow text-mb-text'
                          : 'border-transparent bg-transparent text-mb-text/90 hover:border-mb-border/70 hover:bg-mb-panel2/70'
                      )
                    }
                  >
                    {item.title}
                  </NavLink>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
