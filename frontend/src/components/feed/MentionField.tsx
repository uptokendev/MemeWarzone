import { useEffect, useRef, useState } from "react";
import { FeedAvatar } from "@/components/feed/FeedCards";
import { searchHandles, type HandleSuggestion } from "@/lib/handlesApi";

type BaseProps = {
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (event: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => void;
  className?: string;
  wrapperClassName?: string;
  placeholder?: string;
  "aria-label"?: string;
  onFocus?: () => void;
  onBlur?: () => void;
};

/** The @word right before the caret, if the caret is inside one. */
function activeMention(value: string, caret: number) {
  const before = value.slice(0, caret);
  const m = /(^|[^A-Za-z0-9_@])@([A-Za-z0-9_]{0,20})$/.exec(before);
  if (!m) return null;
  return { start: caret - m[2].length - 1, query: m[2] };
}

/**
 * Grows a textarea with its text (founder, 2026-10-04: long posts were hard to read in a small box),
 * up to `max` px, then it scrolls. `rows` stays the minimum height.
 */
export function useAutoGrow(ref: { current: HTMLTextAreaElement | null }, value: string, max = 320) {
  useEffect(() => {
    const el = ref.current;
    if (!el || el.tagName !== "TEXTAREA") return;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight + 2, max);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight + 2 > max ? "auto" : "hidden";
  }, [ref, value, max]);
}

/**
 * Post / reply field with @username suggestions (founder, 2026-10-02). Typing @ and a letter lists
 * matching usernames; Enter or Tab inserts the highlighted one. Otherwise a plain textarea / input.
 */
export function MentionField(props: BaseProps & ({ multiline: true; rows?: number } | { multiline?: false; rows?: never })) {
  const { value, onChange, onKeyDown, className, wrapperClassName, multiline, ...rest } = props as BaseProps & { multiline?: boolean; rows?: number };
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  useAutoGrow(ref, multiline ? value : "");
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [items, setItems] = useState<HandleSuggestion[]>([]);
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (!mention || !mention.query) {
      setItems([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      searchHandles(mention.query)
        .then((list) => {
          if (!cancelled) {
            setItems(list);
            setActive(0);
          }
        })
        .catch(() => {});
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [mention?.query, mention?.start]);

  function refresh(next: string, caret: number | null) {
    setMention(caret == null ? null : activeMention(next, caret));
  }

  function pick(s: HandleSuggestion) {
    if (!mention) return;
    const end = mention.start + 1 + mention.query.length;
    const insert = `@${s.handle} `;
    const next = value.slice(0, mention.start) + insert + value.slice(end);
    onChange(next);
    setMention(null);
    setItems([]);
    const caret = mention.start + insert.length;
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  }

  const open = Boolean(mention && items.length);

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) {
    if (open) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((i) => (i + 1) % items.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((i) => (i - 1 + items.length) % items.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        pick(items[active]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMention(null);
        return;
      }
    }
    onKeyDown?.(event);
  }

  const shared = {
    ref,
    value,
    className,
    "aria-autocomplete": "list" as const,
    "aria-expanded": open,
    onChange: (event: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => {
      onChange(event.target.value);
      refresh(event.target.value, event.target.selectionStart);
    },
    onKeyDown: handleKeyDown,
    onClick: (event: React.MouseEvent<HTMLTextAreaElement | HTMLInputElement>) => refresh(value, (event.target as HTMLInputElement).selectionStart),
    onFocus: rest.onFocus,
    onBlur: () => {
      rest.onBlur?.();
      setTimeout(() => setMention(null), 150);
    },
    placeholder: rest.placeholder,
    "aria-label": rest["aria-label"],
  };

  return (
    <div className={`relative ${wrapperClassName ?? "min-w-0 flex-1"}`}>
      {multiline ? <textarea {...shared} rows={rest.rows} /> : <input {...shared} />}
      {open ? (
        <ul
          role="listbox"
          aria-label="Usernames"
          className="absolute left-0 right-0 top-full z-40 mt-1 max-h-72 overflow-y-auto rounded-[12px] border border-mw-edge bg-mw-surface p-1 shadow-[0_12px_32px_rgba(0,0,0,0.5)]"
        >
          {items.map((s, i) => (
            <li key={s.handle} role="option" aria-selected={i === active}>
              <button
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(s);
                }}
                onMouseEnter={() => setActive(i)}
                className={`flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left ${i === active ? "bg-[#1F252C]" : ""}`}
              >
                <FeedAvatar url={s.avatarUrl} label={s.handle} size={28} />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-mw-text">@{s.handle}</span>
                  {s.displayName ? <span className="block truncate text-xs text-mw-muted">{s.displayName}</span> : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
