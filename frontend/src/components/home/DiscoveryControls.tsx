import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

import type { FeedTabKey, HomeQuery } from "./CampaignGrid";
import { Activity, Clock, FileText, Filter, Flame, Rocket } from "lucide-react";

type DiscoveryControlsProps = {
  className?: string;
  query: HomeQuery;
  onChange: (next: HomeQuery) => void;
};

const TAB_DEFS: Array<{ key: FeedTabKey; label: string; icon: ReactNode }> = [
  { key: "drafts", label: "Drafts", icon: <FileText className="h-4 w-4" /> },
  { key: "trending", label: "Trending", icon: <Flame className="h-4 w-4" /> },
  { key: "new", label: "New", icon: <Clock className="h-4 w-4" /> },
  { key: "ending", label: "Ending Soon", icon: <Activity className="h-4 w-4" /> },
  { key: "dex", label: "Graduated", icon: <Rocket className="h-4 w-4" /> },
];

const SORT_DEFS: Array<{ value: NonNullable<HomeQuery["sort"]>; label: string }> = [
  { value: "default", label: "Default" },
  { value: "mcap_desc", label: "Market Cap: High -> Low" },
  { value: "mcap_asc", label: "Market Cap: Low -> High" },
  { value: "votes_desc", label: "Upvotes (24h): High -> Low" },
  { value: "volume_desc", label: "Volume: High -> Low" },
  { value: "holders_desc", label: "Holders: High -> Low" },
  { value: "progress_desc", label: "Progress: High -> Low" },
  { value: "created_desc", label: "Created: New -> Old" },
  { value: "created_asc", label: "Created: Old -> New" },
];

const DRAFT_SORT_DEFS: Array<{ value: NonNullable<HomeQuery["sort"]>; label: string }> = [
  { value: "created_desc", label: "New" },
  { value: "progress_desc", label: "Near deployment" },
  { value: "popular_desc", label: "Most popular" },
];

function numOrUndef(s: string): number | undefined {
  const raw = String(s ?? "").trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export function DiscoveryControls({ className, query, onChange }: DiscoveryControlsProps) {
  const timeChips = useMemo(() => ["1h", "24h", "7d", "all"] as const, []);
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Phone sheet has its own open state so the desktop inline panel never opens an overlay.
  const [sheetOpen, setSheetOpen] = useState(false);

  const isDraftRow = query.tab === "drafts";
  const forcedStatus = query.tab === "ending" ? "live" : query.tab === "dex" ? "graduated" : null;
  const statusValue = forcedStatus ?? (query.status ?? "all");
  const sortValue = isDraftRow
    ? query.sort === "progress_desc" || query.sort === "popular_desc"
      ? query.sort
      : "created_desc"
    : query.sort ?? "default";

  const [mcapMin, setMcapMin] = useState<string>(query.mcapMinUsd != null ? String(query.mcapMinUsd) : "");
  const [mcapMax, setMcapMax] = useState<string>(query.mcapMaxUsd != null ? String(query.mcapMaxUsd) : "");
  const [pMin, setPMin] = useState<string>(query.progressMinPct != null ? String(query.progressMinPct) : "");
  const [pMax, setPMax] = useState<string>(query.progressMaxPct != null ? String(query.progressMaxPct) : "");

  useEffect(() => {
    setMcapMin(query.mcapMinUsd != null ? String(query.mcapMinUsd) : "");
    setMcapMax(query.mcapMaxUsd != null ? String(query.mcapMaxUsd) : "");
    setPMin(query.progressMinPct != null ? String(query.progressMinPct) : "");
    setPMax(query.progressMaxPct != null ? String(query.progressMaxPct) : "");
  }, [query.mcapMinUsd, query.mcapMaxUsd, query.progressMinPct, query.progressMaxPct]);

  const applyNumericFilters = () => {
    onChange({
      ...query,
      mcapMinUsd: numOrUndef(mcapMin),
      mcapMaxUsd: numOrUndef(mcapMax),
      progressMinPct: numOrUndef(pMin),
      progressMaxPct: numOrUndef(pMax),
    });
  };

  const resetFilters = () => {
    setMcapMin("");
    setMcapMax("");
    setPMin("");
    setPMax("");
    onChange({
      ...query,
      status: "all",
      mcapMinUsd: undefined,
      mcapMaxUsd: undefined,
      progressMinPct: undefined,
      progressMaxPct: undefined,
      sort: isDraftRow ? "created_desc" : "default",
    });
  };

  const fieldClass =
    "h-11 w-full rounded-[10px] border border-mw-edge bg-mw-input px-3.5 text-[15px] text-mw-text placeholder:text-[#7C858F] outline-none focus:ring-2 focus:ring-mw-accent";
  const labelClass = "font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-mw-muted";
  const activeFilterCount =
    (statusValue !== "all" && !forcedStatus ? 1 : 0) +
    (query.mcapMinUsd != null || query.mcapMaxUsd != null ? 1 : 0) +
    (query.progressMinPct != null || query.progressMaxPct != null ? 1 : 0);

  // One set of fields, shown inline on wider screens and in a bottom sheet on phones.
  const filterFields = (
    <div className="grid gap-4 md:grid-cols-[repeat(3,minmax(0,1fr))_auto] md:items-end">
      <div className="grid gap-1.5">
        <Label className={labelClass}>Status</Label>
        <Select value={statusValue} disabled={Boolean(forcedStatus)} onValueChange={(v) => onChange({ ...query, status: v as any })}>
          <SelectTrigger aria-label="Status" className="h-11 rounded-[10px] border-mw-edge bg-mw-input text-mw-text">
            <SelectValue placeholder="All" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="live">Live</SelectItem>
            <SelectItem value="graduated">Graduated</SelectItem>
          </SelectContent>
        </Select>
        {forcedStatus ? <div className="text-xs text-mw-muted">Status locked to {forcedStatus} for this tab.</div> : null}
      </div>

      <div className="grid gap-1.5">
        <Label className={labelClass}>Market cap (USD)</Label>
        <div className="grid grid-cols-2 gap-1.5">
          <input value={mcapMin} onChange={(e) => setMcapMin(e.target.value)} onBlur={applyNumericFilters} placeholder="Min" aria-label="Minimum market cap" inputMode="decimal" className={fieldClass} />
          <input value={mcapMax} onChange={(e) => setMcapMax(e.target.value)} onBlur={applyNumericFilters} placeholder="Max" aria-label="Maximum market cap" inputMode="decimal" className={fieldClass} />
        </div>
      </div>

      <div className="grid gap-1.5">
        <Label className={labelClass}>Progress (%)</Label>
        <div className="grid grid-cols-2 gap-1.5">
          <input value={pMin} onChange={(e) => setPMin(e.target.value)} onBlur={applyNumericFilters} placeholder="Min" aria-label="Minimum progress" inputMode="decimal" className={fieldClass} />
          <input value={pMax} onChange={(e) => setPMax(e.target.value)} onBlur={applyNumericFilters} placeholder="Max" aria-label="Maximum progress" inputMode="decimal" className={fieldClass} />
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <Button variant="outline" className="h-11 rounded-[10px] border-mw-edge bg-mw-raised px-4 text-[15px] font-semibold text-mw-text hover:bg-[#222830]" onClick={resetFilters}>Reset</Button>
        <Button className="h-11 rounded-[10px] bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D]" onClick={() => { applyNumericFilters(); setFiltersOpen(false); setSheetOpen(false); }}>Apply</Button>
      </div>
    </div>
  );

  return (
    <div className={cn("flex w-full flex-col gap-2.5 font-mw-body", className)}>
      <div className="flex flex-wrap items-center gap-3">
        <div role="tablist" aria-label="Coin lists" className="flex min-w-0 max-w-full gap-1 overflow-x-auto rounded-xl border border-[#2A3038] bg-mw-input p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {TAB_DEFS.map((t) => {
            const active = query.tab === t.key;
            return (
              <Button
                key={t.key}
                variant="ghost"
                size="sm"
                role="tab"
                aria-selected={active}
                className={cn(
                  "mw-focus min-h-10 shrink-0 rounded-lg border px-4 font-mw-cond text-sm font-bold uppercase tracking-[0.08em]",
                  active ? "border-[#3A424C] bg-[#1F252C] text-mw-text hover:bg-[#1F252C]" : "border-transparent text-mw-muted hover:bg-transparent hover:text-mw-text",
                )}
                onClick={() => {
                  const nextTab = t.key;
                  const nextStatus = nextTab === "ending" ? "live" : nextTab === "dex" ? "graduated" : "all";
                  const nextSort = nextTab === "drafts"
                    ? "created_desc"
                    : query.tab === "drafts"
                      ? "default"
                      : query.sort ?? "default";
                  onChange({ ...query, tab: nextTab, status: nextStatus, sort: nextSort });
                }}
              >
                <span>{t.label}</span>
              </Button>
            );
          })}
        </div>

        {!isDraftRow && (
          <div role="group" aria-label="Time window" className="flex items-center gap-1">
            {timeChips.map((k) => {
              const active = (query.timeFilter ?? "24h") === k;
              return (
                <Button
                  key={k}
                  size="sm"
                  variant="ghost"
                  aria-pressed={active}
                  className={cn(
                    "mw-focus min-h-10 rounded-lg border px-3 font-mw-mono text-[13px]",
                    active ? "border-mw-accent bg-[#2A1609] text-mw-accent-soft hover:bg-[#2A1609]" : "border-mw-edge bg-[#171B20] text-[#C9CED4] hover:bg-[#1F252C] hover:text-mw-text",
                  )}
                  onClick={() => onChange({ ...query, timeFilter: k })}
                >
                  {k.toUpperCase()}
                </Button>
              );
            })}
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
          <div className="min-w-0 w-[min(14rem,52vw)] shrink sm:w-[240px]">
            <Select value={sortValue} onValueChange={(v) => onChange({ ...query, sort: v as any })}>
              <SelectTrigger aria-label="Sort" className="h-11 rounded-[10px] border-mw-edge bg-mw-input text-[15px] text-mw-text">
                <SelectValue placeholder="Sort" />
              </SelectTrigger>
              <SelectContent>
                {(isDraftRow ? DRAFT_SORT_DEFS : SORT_DEFS).map((s) => (
                  <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {!isDraftRow && (
            <>
              <Button
                variant="outline"
                aria-expanded={filtersOpen}
                className="hidden h-11 gap-2 rounded-[10px] border-mw-edge bg-mw-raised px-4 text-[15px] font-semibold text-mw-text hover:bg-[#222830] md:inline-flex"
                onClick={() => setFiltersOpen((v) => !v)}
              >
                <Filter className="h-[18px] w-[18px]" aria-hidden="true" />
                Filters{activeFilterCount ? ` · ${activeFilterCount}` : ""}
              </Button>
              <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
                <SheetTrigger asChild>
                  <Button variant="outline" className="h-11 gap-2 rounded-[10px] border-mw-edge bg-mw-raised px-3 text-[15px] font-semibold text-mw-text hover:bg-[#222830] md:hidden">
                    <Filter className="h-[18px] w-[18px]" aria-hidden="true" />
                    Filters{activeFilterCount ? ` · ${activeFilterCount}` : ""}
                  </Button>
                </SheetTrigger>
                <SheetContent side="bottom" className="rounded-t-[20px] border-mw-edge bg-mw-surface font-mw-body text-mw-text md:hidden">
                  <SheetHeader>
                    <SheetTitle className="font-mw-cond text-xl font-bold text-mw-text">Filters</SheetTitle>
                  </SheetHeader>
                  <div className="mt-4">{filterFields}</div>
                </SheetContent>
              </Sheet>
            </>
          )}
        </div>
      </div>

      {!isDraftRow && filtersOpen ? (
        <div className="hidden rounded-[14px] border border-mw-border bg-mw-surface p-3.5 md:block">{filterFields}</div>
      ) : null}
    </div>
  );
}
