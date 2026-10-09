import { useEffect, useState } from "react";
import { searchTokensRemote } from "@/lib/searchClient";
import type { TokenSearchResult } from "@/types/search";

export function useTokenSearch(
  query: string,
  _campaigns?: unknown,
  opts?: { limit?: number; debounceMs?: number; chainId?: number; chainOnly?: boolean },
) {
  const limit = opts?.limit ?? 12;
  const debounceMs = opts?.debounceMs ?? 200;
  const chainId = opts?.chainId;
  const chainOnly = Boolean(opts?.chainOnly);
  const [results, setResults] = useState<TokenSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const q = String(query || "").trim();
    setError(null);
    if (q.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const next = await searchTokensRemote(q, { limit, signal: controller.signal, chainId, chainOnly });
        if (!controller.signal.aborted) setResults(next);
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") return;
        setError("Search failed");
        setResults([]);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, debounceMs);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [chainId, chainOnly, debounceMs, limit, query]);

  return { results, loading, error };
}
