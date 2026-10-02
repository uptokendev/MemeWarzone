import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Copy,
  Eye,
  FileText,
  Globe,
  ListChecks,
  Plus,
  Radio,
  Rocket,
  Save,
  Share2,
  ShieldCheck,
  Trash2,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  calculateDraftPopularity,
  demoDraft,
  formatDraftDate,
  formatDraftDateTime,
  getDraftById,
  publishDraft,
  type CampaignDraft,
  type DraftDocsSet,
  type DraftLinkSet,
  type DraftRoadmapItem,
  type DraftVisibility,
  upsertDraft,
} from "@/lib/draftPromotion";

function toDatetimeLocal(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function fromDatetimeLocal(value: string) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function setupInputClass(className?: string) {
  return cn(
    "h-11 bg-background/60 border-border text-foreground placeholder:text-muted-foreground font-retro focus:border-accent",
    className,
  );
}

function sectionTitle(icon: ReactNode, title: string, label: string) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <span className="text-accent">{icon}</span>
        <div className="min-w-0">
          <h2 className="font-retro text-sm uppercase tracking-[0.14em] text-foreground">{title}</h2>
          <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
        </div>
      </div>
    </div>
  );
}

const PromotionSetup = () => {
  const params = useParams();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<CampaignDraft | null>(null);
  const [savedAt, setSavedAt] = useState<string>("");

  useEffect(() => {
    const next = getDraftById(params.draftId) || demoDraft;
    setDraft(next);
    setSavedAt(next.updatedAt);
  }, [params.draftId]);

  const popularity = useMemo(() => (draft ? calculateDraftPopularity(draft) : null), [draft]);

  const readiness = useMemo(() => {
    if (!draft) return { score: 0, items: [] as Array<{ label: string; done: boolean }> };
    const items = [
      { label: "Draft identity", done: Boolean(draft.name.trim() && draft.ticker.trim() && draft.tagline.trim()) },
      { label: "Mission statement", done: Boolean(draft.mission.trim()) },
      { label: "Battle plan", done: draft.roadmap.every((item) => item.title.trim() && item.body.trim()) },
      { label: "Launch strategy", done: Boolean(draft.launchStrategy.trim()) },
      { label: "Community link", done: Object.values(draft.communityLinks).some((value) => value.trim()) },
      { label: "Share message", done: Boolean(draft.shareMessage.trim()) },
      { label: "Visibility set", done: Boolean(draft.visibility) },
    ];
    const done = items.filter((item) => item.done).length;
    return { score: Math.round((done / items.length) * 100), items };
  }, [draft]);

  if (!draft) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-10">
        <div className="mwz-panel p-6 font-retro text-muted-foreground">Loading draft command center...</div>
      </div>
    );
  }

  const previewUrl = `/prepare/${draft.slug}`;
  const publicUrl = typeof window !== "undefined" ? `${window.location.origin}${previewUrl}` : previewUrl;

  const updateDraft = (patch: Partial<CampaignDraft>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  };

  const updateCommunity = (key: keyof DraftLinkSet, value: string) => {
    updateDraft({ communityLinks: { ...draft.communityLinks, [key]: value } });
  };

  const updateDocs = (key: keyof DraftDocsSet, value: string) => {
    updateDraft({ docsLinks: { ...draft.docsLinks, [key]: value } });
  };

  const updateRoadmap = (id: string, patch: Partial<DraftRoadmapItem>) => {
    updateDraft({
      roadmap: draft.roadmap.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    });
  };

  const handleAddPhase = () => {
    updateDraft({
      roadmap: [
        ...draft.roadmap,
        {
          id: `phase-${Date.now()}`,
          title: "New phase",
          body: "Add the next campaign milestone.",
        },
      ],
    });
  };

  const handleRemovePhase = (id: string) => {
    if (draft.roadmap.length <= 1) return;
    updateDraft({ roadmap: draft.roadmap.filter((item) => item.id !== id) });
  };

  const handleSave = () => {
    const saved = upsertDraft(draft);
    setDraft(saved);
    setSavedAt(saved.updatedAt);
    toast.success("Promotion setup saved.");
  };

  const handlePublish = () => {
    const saved = upsertDraft(draft);
    const published = publishDraft(saved.id) || saved;
    setDraft(published);
    setSavedAt(published.updatedAt);
    toast.success("Promotion page published.");
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(publicUrl);
      toast.success("Prepare page link copied.");
    } catch {
      toast.message(publicUrl);
    }
  };

  return (
    <div className="mx-auto w-full max-w-[1480px] px-1 py-4 md:px-2 md:py-6">
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <Link to="/create" className="mb-2 inline-flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" />
            Exit setup
          </Link>
          <h1 className="mwz-section-title text-3xl md:text-5xl">Promotion Setup</h1>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            Configure the public Prepare Mode page for ${draft.ticker}. Saved as a draft until you publish it.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button asChild className="mwz-button h-10 px-3 text-xs font-retro">
            <Link to={previewUrl}>
              <Eye className="h-4 w-4" />
              Preview
            </Link>
          </Button>
          <Button type="button" onClick={handleCopy} className="mwz-button h-10 px-3 text-xs font-retro">
            <Copy className="h-4 w-4" />
            Copy link
          </Button>
          <Button type="button" onClick={handleSave} className="mwz-button h-10 px-3 text-xs font-retro">
            <Save className="h-4 w-4" />
            Save
          </Button>
          <Button type="button" onClick={handlePublish} className="mwz-button mwz-button-orange h-10 px-3 text-xs font-retro">
            <Radio className="h-4 w-4" />
            Publish
          </Button>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <section className="mwz-panel overflow-hidden">
            {sectionTitle(<ShieldCheck className="h-4 w-4" />, "Draft Identity", "Prepare page hero")}
            <div className="grid gap-4 p-4 md:grid-cols-[160px_minmax(0,1fr)]">
              <div className="space-y-3">
                <div className="aspect-square overflow-hidden border border-border/70 bg-background/60">
                  <img src={draft.logoUrl || "/assets/ticker.png"} alt={draft.name} className="h-full w-full object-cover" />
                </div>
                <Input
                  value={draft.logoUrl}
                  onChange={(event) => updateDraft({ logoUrl: event.target.value })}
                  className={setupInputClass("text-xs")}
                  placeholder="/assets/ticker.png"
                />
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <label className="space-y-2">
                  <span className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Token name</span>
                  <Input value={draft.name} onChange={(event) => updateDraft({ name: event.target.value })} className={setupInputClass()} />
                </label>
                <label className="space-y-2">
                  <span className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Ticker</span>
                  <Input value={draft.ticker} onChange={(event) => updateDraft({ ticker: event.target.value.toUpperCase() })} className={setupInputClass("uppercase")} />
                </label>
                <label className="space-y-2 md:col-span-2">
                  <span className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Tagline</span>
                  <Input value={draft.tagline} onChange={(event) => updateDraft({ tagline: event.target.value })} className={setupInputClass()} />
                </label>
                <label className="space-y-2 md:col-span-2">
                  <span className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Banner image</span>
                  <Input value={draft.bannerUrl} onChange={(event) => updateDraft({ bannerUrl: event.target.value })} className={setupInputClass()} />
                </label>
              </div>
            </div>
          </section>

          <section className="mwz-panel overflow-hidden">
            {sectionTitle(<FileText className="h-4 w-4" />, "Mission Statement", "Public brief")}
            <div className="space-y-3 p-4">
              <Textarea
                value={draft.mission}
                onChange={(event) => updateDraft({ mission: event.target.value })}
                className={setupInputClass("min-h-32 resize-none")}
                placeholder="Explain why this draft should gather a squad before launch."
              />
            </div>
          </section>

          <section className="mwz-panel overflow-hidden">
            {sectionTitle(<ListChecks className="h-4 w-4" />, "Roadmap", "Battle plan")}
            <div className="grid gap-3 p-4 md:grid-cols-2">
              {draft.roadmap.map((item, index) => (
                <div key={item.id} className="mwz-card p-4">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <span className="text-[11px] uppercase tracking-[0.18em] text-accent">Phase {index + 1}</span>
                    <button
                      type="button"
                      onClick={() => handleRemovePhase(item.id)}
                      className="text-muted-foreground hover:text-foreground"
                      aria-label="Remove phase"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  <Input
                    value={item.title}
                    onChange={(event) => updateRoadmap(item.id, { title: event.target.value })}
                    className={setupInputClass("mb-3")}
                  />
                  <Textarea
                    value={item.body}
                    onChange={(event) => updateRoadmap(item.id, { body: event.target.value })}
                    className={setupInputClass("min-h-24 resize-none text-sm")}
                  />
                </div>
              ))}
              <button type="button" onClick={handleAddPhase} className="mwz-button flex min-h-36 items-center justify-center gap-2 p-4 font-retro text-sm">
                <Plus className="h-4 w-4" />
                Add phase
              </button>
            </div>
          </section>

          <section className="mwz-panel overflow-hidden">
            {sectionTitle(<Rocket className="h-4 w-4" />, "Launch Strategy", "How the draft becomes live")}
            <div className="space-y-3 p-4">
              <Textarea
                value={draft.launchStrategy}
                onChange={(event) => updateDraft({ launchStrategy: event.target.value })}
                className={setupInputClass("min-h-32 resize-none")}
                placeholder="Describe launch timing, community thresholds, and push-live conditions."
              />
              <div className="grid gap-3 md:grid-cols-2">
                <label className="space-y-2">
                  <span className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Deploy target</span>
                  <Input
                    type="datetime-local"
                    value={toDatetimeLocal(draft.deployTarget)}
                    onChange={(event) => updateDraft({ deployTarget: fromDatetimeLocal(event.target.value) })}
                    className={setupInputClass()}
                  />
                </label>
                <label className="space-y-2">
                  <span className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Creator handle</span>
                  <Input value={draft.creatorHandle} onChange={(event) => updateDraft({ creatorHandle: event.target.value })} className={setupInputClass()} />
                </label>
              </div>
            </div>
          </section>

          <section className="mwz-panel overflow-hidden">
            {sectionTitle(<Globe className="h-4 w-4" />, "Community And Docs", "Links on the public page")}
            <div className="grid gap-4 p-4 lg:grid-cols-2">
              <div className="space-y-3">
                {(
                  [
                    ["website", "Website"],
                    ["x", "X / Twitter"],
                    ["telegram", "Telegram"],
                    ["discord", "Discord"],
                  ] as Array<[keyof DraftLinkSet, string]>
                ).map(([key, label]) => (
                  <label key={key} className="space-y-2">
                    <span className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{label}</span>
                    <Input value={draft.communityLinks[key]} onChange={(event) => updateCommunity(key, event.target.value)} className={setupInputClass()} />
                  </label>
                ))}
              </div>
              <div className="space-y-3">
                {(
                  [
                    ["litepaper", "Litepaper"],
                    ["audit", "Audit / lock proof"],
                    ["deck", "Pitch deck"],
                  ] as Array<[keyof DraftDocsSet, string]>
                ).map(([key, label]) => (
                  <label key={key} className="space-y-2">
                    <span className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{label}</span>
                    <Input value={draft.docsLinks[key]} onChange={(event) => updateDocs(key, event.target.value)} className={setupInputClass()} />
                  </label>
                ))}
              </div>
            </div>
          </section>

          <section className="mwz-panel overflow-hidden">
            {sectionTitle(<Share2 className="h-4 w-4" />, "Visibility And Share Message", "Distribution controls")}
            <div className="space-y-4 p-4">
              <div className="grid gap-2 md:grid-cols-3">
                {(["public", "unlisted", "private"] as DraftVisibility[]).map((visibility) => {
                  const isSelected = draft.visibility === visibility;
                  let description: string;
                  if (visibility === "public") description = "Listed and shareable";
                  else if (visibility === "unlisted") description = "Share link only";
                  else description = "Owner only";
                  return (
                    <button
                      key={visibility}
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => updateDraft({ visibility })}
                      className={cn(
                        "mwz-button p-3 text-left font-retro text-xs",
                        isSelected && "mwz-button-orange !bg-orange-500/25 !text-orange-100 font-semibold",
                      )}
                    >
                      <span className="block uppercase tracking-[0.16em]">{visibility}</span>
                      <span className="mt-1 block text-[11px] normal-case tracking-normal text-muted-foreground">
                        {description}
                      </span>
                    </button>
                  );
                })}
              </div>
              <Textarea
                value={draft.shareMessage}
                onChange={(event) => updateDraft({ shareMessage: event.target.value })}
                className={setupInputClass("min-h-24 resize-none")}
                placeholder="Short rally message copied with the public link."
              />
              <Textarea
                value={draft.creatorNote}
                onChange={(event) => updateDraft({ creatorNote: event.target.value })}
                className={setupInputClass("min-h-24 resize-none")}
                placeholder="Creator note shown near the bottom of the public page."
              />
            </div>
          </section>
        </div>

        <aside className="space-y-4 xl:sticky xl:top-28 xl:self-start">
          <div className="mwz-panel p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <p className="text-[11px] uppercase tracking-[0.18em] text-accent">Command Center</p>
                <h2 className="font-retro text-xl text-foreground">Draft control</h2>
              </div>
              <span className="mwz-chip px-2 py-1 text-[10px]">{draft.status}</span>
            </div>

            <div className="mwz-card p-4">
              <div className="flex items-end justify-between gap-3">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Readiness</p>
                  <p className="font-retro text-4xl text-accent">{readiness.score}</p>
                </div>
                <span className="text-xs uppercase tracking-[0.16em] text-muted-foreground">/ 100</span>
              </div>
              <div className="mt-3 h-2 border border-border/70 bg-background">
                <div className="h-full bg-[linear-gradient(90deg,var(--mwz-orange),var(--mwz-green))]" style={{ width: `${readiness.score}%` }} />
              </div>
              <div className="mt-3 space-y-2">
                {readiness.items.map((item) => (
                  <div key={item.label} className="flex items-center justify-between gap-3 text-xs">
                    <span className={item.done ? "text-foreground" : "text-muted-foreground"}>{item.label}</span>
                    <span className={item.done ? "text-accent" : "text-muted-foreground"}>{item.done ? "ready" : "missing"}</span>
                  </div>
                ))}
              </div>
            </div>

            <Button type="button" onClick={handlePublish} className="mwz-button mwz-button-orange mt-3 h-11 w-full font-retro">
              <Rocket className="h-4 w-4" />
              Publish page
            </Button>
            <Button type="button" onClick={handleSave} className="mwz-button mt-2 h-10 w-full font-retro">
              <Save className="h-4 w-4" />
              Save setup
            </Button>
          </div>

          <div className="mwz-panel p-4">
            <p className="mb-3 text-[11px] uppercase tracking-[0.18em] text-accent">Draft traffic</p>
            <div className="grid grid-cols-2 gap-3">
              {[
                ["Popularity", `${popularity?.percentage ?? 0}%`],
                ["Heat", popularity?.label ?? "Cold"],
                ["Follows", String(popularity?.totals.follows ?? 0)],
                ["Comments", String(popularity?.totals.comments ?? 0)],
                ["Shares", String(popularity?.totals.shares ?? 0)],
                ["Deploy", formatDraftDate(draft.deployTarget)],
              ].map(([label, value]) => (
                <div key={label} className="mwz-card p-3">
                  <p className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
                  <p className="mt-1 truncate font-retro text-lg text-foreground">{value}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="mwz-panel p-4">
            <p className="mb-3 text-[11px] uppercase tracking-[0.18em] text-accent">Share link</p>
            <div className="border border-border/70 bg-background/70 p-3 text-xs text-muted-foreground">
              <span className="block truncate">{publicUrl}</span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Button type="button" onClick={handleCopy} className="mwz-button h-10 text-xs font-retro">
                <Copy className="h-4 w-4" />
                Copy
              </Button>
              <Button asChild className="mwz-button h-10 text-xs font-retro">
                <Link to={previewUrl}>
                  <Eye className="h-4 w-4" />
                  Open
                </Link>
              </Button>
            </div>
          </div>

          <div className="mwz-panel p-4">
            <p className="mb-2 text-[11px] uppercase tracking-[0.18em] text-accent">Last saved</p>
            <p className="text-sm text-muted-foreground">{formatDraftDateTime(savedAt)}</p>
            <p className="mt-3 text-xs leading-5 text-muted-foreground">
              Comments, follows, shares, and signed-in actions feed the public popularity score.
            </p>
            <Button type="button" onClick={() => navigate(previewUrl)} className="mwz-button mt-3 h-10 w-full text-xs font-retro">
              <Users className="h-4 w-4" />
              View bunker
            </Button>
          </div>
        </aside>
      </div>
    </div>
  );
};

export default PromotionSetup;
