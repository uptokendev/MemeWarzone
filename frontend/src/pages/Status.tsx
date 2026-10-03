import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/apiBase";

type TelemetryResponse = {
  ts: number;
  services: Record<string, any>;
};

function fmtAge(seconds: number) {
  if (seconds < 0) seconds = 0;
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}

function statusColor(kind: "green" | "yellow" | "red") {
  return kind === "green" ? "text-[#6EE7A0]" : kind === "yellow" ? "text-mw-accent-soft" : "text-mw-sell";
}

export default function Status() {
  const [token, setToken] = useState(() => localStorage.getItem("memewarzone_status_token") || localStorage.getItem("memebattles_status_token") || "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<TelemetryResponse | null>(null);
  const [auto, setAuto] = useState(true);

  const now = Date.now();

  const rows = useMemo(() => {
    const services = data?.services || {};
    return Object.keys(services)
      .sort()
      .map((name) => {
        const s = services[name] || {};
        const ts = Number(s.ts || 0) * 1000;
        const ageSec = ts ? Math.floor((now - ts) / 1000) : 0;
        let overall: "green" | "yellow" | "red" = "green";
        if (ageSec > 120) overall = "red";
        else if (ageSec > 45) overall = "yellow";
        if (s.ok === false && overall !== "red") overall = "yellow";
        return {
          name,
          overall,
          ageSec,
          rps1m: s.rps_1m,
          err1m: s.errors_1m,
          lag: s.lag_blocks,
          lastIndexed: s.last_indexed_block,
          head: s.head_block,
        };
      });
  }, [data, now]);

  async function fetchStatus(tok: string) {
    setLoading(true);
    setError(null);
    try {
      const r = await apiFetch("/api/status", {
        headers: {
          authorization: `Bearer ${tok}`,
        },
      });
      if (!r.ok) {
        const j = await r.json().catch(() => null);
        throw new Error(j?.error || `HTTP ${r.status}`);
      }
      const j = (await r.json()) as TelemetryResponse;
      setData(j);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!auto) return;
    if (!token) return;
    fetchStatus(token);
    const t = window.setInterval(() => fetchStatus(token), 10_000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, token]);

  function saveToken() {
    localStorage.setItem("memewarzone_status_token", token);
    fetchStatus(token);
  }

  return (
    <div className="w-full h-full overflow-auto">
      <div className="mx-auto w-full max-w-[1480px] px-1 md:px-2">
        <section className="rounded-[14px] border border-mw-border bg-mw-surface font-mw-body text-mw-text">
          <div className="flex flex-col gap-2 p-4 sm:p-5">
            <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-[#FF9A4D]">Private</div>
            <h1 className="m-0 font-mw-cond text-[32px] font-bold leading-none text-mw-text lg:text-[40px]">MemeWarzone Status (Private)</h1>
          </div>
          <div className="space-y-4 p-4 pt-0 sm:p-5 sm:pt-0">
            <div className="flex flex-col md:flex-row gap-3 items-stretch md:items-center">
              <div className="flex-1 w-full">
                <Input
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="Enter status token"
                  className="h-11 rounded-[10px] border border-mw-edge bg-mw-input px-3 font-mw-mono text-[15px] text-mw-text placeholder:text-[#5C6670]"
                />
              </div>
              <Button onClick={saveToken} disabled={!token || loading} className="mw-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50">
                {loading ? "Loading…" : "Load"}
              </Button>
              <Button
                variant={auto ? "default" : "outline"}
                onClick={() => setAuto((v) => !v)}
                className={auto ? "mw-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-[#7A3A0C] bg-[#2A1609] px-4 text-[15px] font-semibold text-mw-accent-soft hover:bg-[#341B0B]" : "mw-focus inline-flex min-h-11 items-center justify-center gap-2 whitespace-nowrap rounded-[10px] border border-mw-edge bg-mw-raised px-4 text-[15px] font-semibold text-mw-text hover:bg-[#222830] hover:text-mw-text"}
              >
                Auto-refresh: {auto ? "ON" : "OFF"}
              </Button>
            </div>

            {error && (
              <div className="text-sm text-mw-sell">{error}</div>
            )}

            {!data ? (
              <div className="text-sm text-mw-muted">
                Enter your token to view telemetry.
              </div>
            ) : (
              <div className="mw-table overflow-x-auto rounded-[10px] border border-mw-border bg-mw-input">
                <div className="min-w-[640px]">
                <div className="grid grid-cols-6 gap-0 bg-[#171B20] font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted">
                  <div className="p-3 col-span-2">Service</div>
                  <div className="p-3">Status</div>
                  <div className="p-3">Freshness</div>
                  <div className="p-3">Lag</div>
                  <div className="p-3">RPS / Errors</div>
                </div>
                {rows.length === 0 ? (
                  <div className="p-4 text-sm text-mw-muted">No telemetry received yet.</div>
                ) : (
                  rows.map((r) => (
                    <div key={r.name} className="grid grid-cols-6 gap-0 border-t border-mw-border text-sm">
                      <div className="p-3 col-span-2 font-mw-mono truncate">{r.name}</div>
                      <div className={`p-3 font-semibold ${statusColor(r.overall)}`}>{r.overall.toUpperCase()}</div>
                      <div className="p-3 font-mw-mono">{fmtAge(r.ageSec)} ago</div>
                      <div className="p-3 font-mw-mono">
                        {typeof r.lag === "number" ? `${r.lag} blocks` : "—"}
                      </div>
                      <div className="p-3 font-mw-mono">
                        {typeof r.rps1m === "number" ? `${r.rps1m.toFixed(1)} rps` : "—"}
                        {typeof r.err1m === "number" ? ` / ${r.err1m}e` : ""}
                      </div>
                    </div>
                  ))
                )}
                </div>
              </div>
            )}

            {data && (
              <div className="font-mw-mono text-xs text-mw-muted">
                Last update: {new Date((data.ts || 0) * 1000).toLocaleString()}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
