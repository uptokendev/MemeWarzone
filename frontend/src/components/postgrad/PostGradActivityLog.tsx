import { Activity, Crosshair, Eye, Flag, RotateCcw, Swords, Trophy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { postGradFlags } from "@/features/postgrad/config";
import type { MockActivityScope } from "@/features/postgrad/mockActivityRuntime";
import { useMockActivityLog } from "@/hooks/useMockActivityRuntime";

const scopeIcon: Record<MockActivityScope, typeof Activity> = {
  arena: Crosshair,
  battle: Swords,
  war_room: Eye,
  war_pool: Activity,
  events: Flag,
  league: Trophy,
  system: RotateCcw,
};

const scopeLabel: Record<MockActivityScope, string> = {
  arena: "Warzone",
  battle: "Battle",
  war_room: "Trade War Room",
  war_pool: "War Pool",
  events: "Events",
  league: "League",
  system: "System",
};

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "just now";
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function PostGradActivityLog() {
  const { activityLog, resetMockActivityRuntime } = useMockActivityLog();

  if (!postGradFlags.mocks) return null;

  return (
    <section className="rounded-2xl border border-white/10 bg-black/25 p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-[0.28em] text-accent/80">Sandbox activity log</div>
          <div className="mt-1 text-sm text-white/65">Latest frontend-only QA actions across the post-grad flow.</div>
        </div>
        <Button size="sm" variant="outline" onClick={resetMockActivityRuntime}>
          Clear log
        </Button>
      </div>

      <div className="mt-4 space-y-2">
        {activityLog.length ? (
          activityLog.map((entry) => {
            const Icon = scopeIcon[entry.scope];
            return (
              <div key={entry.id} className="flex items-start gap-3 rounded-xl border border-white/10 bg-white/5 px-3 py-2">
                <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-black/25 text-accent">
                  <Icon className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[10px] uppercase tracking-[0.22em] text-white/40">{scopeLabel[entry.scope]}</span>
                    <span className="text-[10px] text-white/35">{formatTime(entry.createdAt)}</span>
                  </div>
                  <div className="mt-1 text-sm font-semibold text-white">{entry.label}</div>
                  {entry.detail ? <div className="mt-1 text-xs text-white/55">{entry.detail}</div> : null}
                </div>
              </div>
            );
          })
        ) : (
          <div className="rounded-xl border border-dashed border-white/10 bg-black/20 p-4 text-sm text-white/55">
            No sandbox actions yet. Watch a token, support a War Pool, advance an event, or cycle the league to populate this log.
          </div>
        )}
      </div>
    </section>
  );
}
