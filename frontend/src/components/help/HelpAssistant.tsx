/**
 * Help assistant on the Help Center pages: a floating Ask button and a small chat panel. Answers come from
 * POST /api/help/ask (api/helpAssistant.js), which answers only from Help Center articles and links them.
 * Renders nothing unless GET /api/help/assistant says the assistant is enabled.
 * Other components open it with window.dispatchEvent(new Event(HELP_ASSISTANT_OPEN_EVENT)).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { HelpCircle, Loader2, Send, Sparkles, X } from "lucide-react";

import { apiFetch } from "@/lib/apiBase";
import { cn } from "@/lib/utils";

export const HELP_ASSISTANT_OPEN_EVENT = "mwz:help-assistant-open";

type Source = { slug: string; q: string; url: string };
type Message = { role: "user" | "assistant"; content: string; sources?: Source[]; error?: boolean };

const HISTORY_TURNS = 6;

export function useHelpAssistantEnabled() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let alive = true;
    apiFetch("/api/help/assistant")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (alive) setEnabled(Boolean(j?.enabled));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return enabled;
}

export function HelpAssistant() {
  const enabled = useHelpAssistantEnabled();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(HELP_ASSISTANT_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(HELP_ASSISTANT_OPEN_EVENT, onOpen);
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  const send = useCallback(async () => {
    const question = input.trim();
    if (!question || busy) return;
    const history = messages
      .filter((m) => !m.error)
      .slice(-HISTORY_TURNS)
      .map((m) => ({ role: m.role, content: m.content }));
    setMessages((prev) => [...prev, { role: "user", content: question }]);
    setInput("");
    setBusy(true);
    try {
      const res = await apiFetch("/api/help/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, history }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) {
        setMessages((prev) => [...prev, { role: "assistant", content: json?.error || "The assistant could not answer right now.", error: true }]);
      } else {
        setMessages((prev) => [...prev, { role: "assistant", content: String(json.answer || ""), sources: json.sources || [] }]);
      }
    } catch {
      setMessages((prev) => [...prev, { role: "assistant", content: "The assistant could not be reached. Check your connection and try again.", error: true }]);
    } finally {
      setBusy(false);
    }
  }, [busy, input, messages]);

  if (!enabled) return null;

  return (
    <>
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mw-focus fixed bottom-24 right-4 z-[60] inline-flex min-h-12 items-center gap-2 rounded-full border border-mw-accent bg-mw-accent px-5 text-[15px] font-semibold text-[#140A02] shadow-[0_8px_30px_rgba(0,0,0,0.45)] hover:bg-[#FF8F3D] md:bottom-6 md:right-6"
        >
          <Sparkles className="h-5 w-5" aria-hidden="true" />
          Ask the assistant
        </button>
      ) : null}

      {open ? (
        <section
          role="dialog"
          aria-label="Help assistant"
          className="fixed inset-x-0 bottom-0 top-14 z-[70] flex flex-col border border-mw-edge bg-[#0E1114] shadow-[0_20px_60px_rgba(0,0,0,0.6)] md:inset-x-auto md:bottom-6 md:right-6 md:top-auto md:h-[600px] md:max-h-[calc(100vh-7rem)] md:w-[400px] md:rounded-[16px]"
        >
          <header className="flex items-center gap-2.5 border-b border-mw-border px-4 py-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-[10px] border border-[#7A3A0C] bg-[#2A1609] text-mw-accent-soft">
              <Sparkles className="h-[18px] w-[18px]" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="font-mw-cond text-lg font-bold leading-tight text-mw-text">Help assistant</div>
              <div className="text-[12px] text-mw-muted">Answers from the Help Center</div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close the assistant"
              className="mw-focus inline-flex h-9 w-9 items-center justify-center rounded-[8px] text-mw-muted hover:bg-[#1F252C] hover:text-mw-text"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          </header>

          <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
            <div className="rounded-[12px] border border-mw-border bg-mw-input p-3 text-[14px] leading-6 text-[#C9CED4]">
              Ask a question about MemeWarzone. Answers come from the Help Center and link the answer they used. The assistant can be
              wrong, so check the linked answer. It never asks for your seed phrase or private key.
            </div>
            {messages.map((m, i) =>
              m.role === "user" ? (
                <div key={i} className="ml-8 rounded-[12px] rounded-br-[4px] bg-[#2A1609] px-3.5 py-2.5 text-[14px] leading-6 text-[#F2E3D3]">
                  {m.content}
                </div>
              ) : (
                <div
                  key={i}
                  className={cn(
                    "mr-4 rounded-[12px] rounded-bl-[4px] border px-3.5 py-2.5 text-[14px] leading-6",
                    m.error ? "border-[#5A2A2A] bg-[#1E1212] text-[#F0C4C4]" : "border-mw-border bg-[#14181C] text-[#D5D9DE]",
                  )}
                >
                  {m.content.split(/\n+/).map((line, j) => (
                    <p key={j} className="m-0 [&+p]:mt-2">
                      {line}
                    </p>
                  ))}
                  {m.sources?.length ? (
                    <ul className="m-0 mt-2.5 list-none space-y-1 border-t border-mw-border p-0 pt-2.5">
                      {m.sources.map((s, n) => (
                        <li key={s.slug}>
                          <Link to={s.url} className="flex gap-1.5 text-[13px] leading-5 text-mw-accent-soft hover:underline">
                            <HelpCircle className="mt-[2px] h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            <span className="min-w-0">
                              [{n + 1}] {s.q}
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ),
            )}
            {busy ? (
              <div className="mr-4 inline-flex items-center gap-2 rounded-[12px] border border-mw-border bg-[#14181C] px-3.5 py-2.5 text-[14px] text-mw-muted">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Looking it up
              </div>
            ) : null}
          </div>

          <form
            className="flex items-end gap-2 border-t border-mw-border p-3"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value.slice(0, 500))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              rows={1}
              placeholder="Ask about fees, battles, wallets..."
              aria-label="Your question"
              className="mw-focus max-h-32 min-h-11 flex-1 resize-none rounded-[10px] border border-mw-edge bg-[#0B0D10] px-3 py-2.5 text-[15px] text-mw-text placeholder:text-[#6B737C] focus:border-mw-accent focus:outline-none"
            />
            <button
              type="submit"
              disabled={busy || !input.trim()}
              aria-label="Send"
              className="mw-focus inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] border border-mw-accent bg-mw-accent text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50"
            >
              <Send className="h-[18px] w-[18px]" aria-hidden="true" />
            </button>
          </form>
        </section>
      ) : null}
    </>
  );
}
