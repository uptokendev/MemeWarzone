import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/apiBase";

/** Public line on a DBC token page: where the creator fees go and what has been paid (step 5b). */
export default function DbcFeeChoiceLine({ pool }: { pool: string }) {
  const [line, setLine] = useState<string | null>(null);
  useEffect(() => {
    if (!pool) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await apiFetch(`/api/dbc/creator-choice?pool=${encodeURIComponent(pool)}`, { cache: "no-store" });
        const payload = await response.json().catch(() => ({}));
        if (!cancelled) setLine(payload?.ok && payload.line ? String(payload.line) : null);
      } catch {
        if (!cancelled) setLine(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pool]);
  if (!line) return null;
  return <p className="text-[11px] text-muted-foreground">{line}</p>;
}
