import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  return kind === "green" ? "text-emerald-400" : kind === "yellow" ? "text-yellow-300" : "text-red-400";
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
        <Card className="bg-card/60 backdrop-blur border-border">
          <CardHeader>
            <CardTitle className="font-retro text-lg">MemeWarzone Status (Private)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col md:flex-row gap-3 items-start md:items-center">
              <div className="flex-1 w-full">
                <Input
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="Enter status token"
                />
              </div>
              <Button onClick={saveToken} disabled={!token || loading}>
                {loading ? "Loading…" : "Load"}
              </Button>
              <Button
                variant={auto ? "default" : "outline"}
                onClick={() => setAuto((v) => !v)}
              >
                Auto-refresh: {auto ? "ON" : "OFF"}
              </Button>
            </div>

            {error && (
              <div className="text-sm text-red-400">{error}</div>
            )}

            {!data ? (
              <div className="text-sm text-muted-foreground">
                Enter your token to view telemetry.
              </div>
            ) : (
              <div className="border border-border rounded-xl overflow-hidden">
                <div className="grid grid-cols-6 gap-0 text-xs font-semibold bg-muted/30">
                  <div className="p-3 col-span-2">Service</div>
                  <div className="p-3">Status</div>
                  <div className="p-3">Freshness</div>
                  <div className="p-3">Lag</div>
                  <div className="p-3">RPS / Errors</div>
                </div>
                {rows.length === 0 ? (
                  <div className="p-4 text-sm text-muted-foreground">No telemetry received yet.</div>
                ) : (
                  rows.map((r) => (
                    <div key={r.name} className="grid grid-cols-6 gap-0 text-sm border-t border-border">
                      <div className="p-3 col-span-2 font-mono truncate">{r.name}</div>
                      <div className={`p-3 font-semibold ${statusColor(r.overall)}`}>{r.overall.toUpperCase()}</div>
                      <div className="p-3">{fmtAge(r.ageSec)} ago</div>
                      <div className="p-3">
                        {typeof r.lag === "number" ? `${r.lag} blocks` : "—"}
                      </div>
                      <div className="p-3">
                        {typeof r.rps1m === "number" ? `${r.rps1m.toFixed(1)} rps` : "—"}
                        {typeof r.err1m === "number" ? ` / ${r.err1m}e` : ""}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}

            {data && (
              <div className="text-xs text-muted-foreground">
                Last update: {new Date((data.ts || 0) * 1000).toLocaleString()}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
