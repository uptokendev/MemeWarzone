import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { WalletLabel } from "@/components/ui-v2/WalletLabel";
import { Link, useParams } from "react-router-dom";
import {
  Bell,
  CalendarClock,
  Check,
  Copy,
  Eye,
  FileText,
  Flame,
  Globe,
  Link2,
  Lock,
  MessageSquare,
  Radio,
  Reply,
  Rocket,
  Send,
  Share2,
  ShieldCheck,
  Star,
  ThumbsUp,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useWallet } from "@/contexts/WalletContext";
import { cn } from "@/lib/utils";
import {
  addDraftComment,
  calculateDraftPopularity,
  demoDraft,
  formatDraftDate,
  formatDraftDateTime,
  getDraftBySlug,
  isDraftFollowed,
  recordDraftShare,
  recordDraftView,
  shortAddress,
  toggleDraftCommentReaction,
  toggleDraftFollow,
  type CampaignDraft,
  type DraftComment,
  type DraftPopularity,
} from "@/lib/draftPromotion";

const actionClass = "mwz-button h-11 px-4 font-retro text-xs md:text-sm";

function formatNumber(value: number) {
  return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function formatShortTime(value: string) {
  const date = new Date(value).getTime();
  if (!Number.isFinite(date)) return "";
  const diff = Math.max(0, Date.now() - date);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function timeUntil(value: string, now: number) {
  const target = new Date(value).getTime();
  if (!Number.isFinite(target)) return { days: "--", hours: "--", minutes: "--", seconds: "--" };
  const diff = Math.max(0, target - now);
  const totalSeconds = Math.floor(diff / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return {
    days: String(days).padStart(2, "0"),
    hours: String(hours).padStart(2, "0"),
    minutes: String(minutes).padStart(2, "0"),
    seconds: String(seconds).padStart(2, "0"),
  };
}

function externalLabel(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return url || "Not set";
  }
}

function DraftStatusPill({ draft }: { draft: CampaignDraft }) {
  return (
    <span className="mwz-chip mwz-chip-active inline-flex h-8 items-center gap-2 px-3 text-[10px]">
      <span className="h-2 w-2 animate-pulse rounded-full bg-accent shadow-[0_0_10px_var(--mwz-orange)]" />
      Recon draft preview
      <span className="hidden opacity-70 sm:inline">deploys {formatDraftDate(draft.deployTarget)}</span>
    </span>
  );
}

function CoinAvatar({ draft, size = "h-28 w-28" }: { draft: CampaignDraft; size?: string }) {
  return (
    <div className={cn("relative grid shrink-0 place-items-center overflow-hidden rounded-full border-2 border-border bg-background", size)}>
      {draft.logoUrl ? (
        <img src={draft.logoUrl} alt={draft.name} className="absolute inset-0 h-full w-full object-cover opacity-80" />
      ) : null}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(57,255,79,0.30),rgba(0,0,0,0.50)_60%)]" />
      <span className="relative z-10 font-retro text-2xl text-foreground drop-shadow-[0_0_12px_rgba(57,255,79,0.45)]">
        {draft.ticker.slice(0, 4)}
      </span>
    </div>
  );
}

function ReconRadar({ percentage }: { percentage: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [signal, setSignal] = useState(percentage);

  useEffect(() => {
    setSignal(percentage);
  }, [percentage]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const size = 200;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = "100%";
    canvas.style.maxWidth = `${size}px`;
    canvas.style.aspectRatio = "1 / 1";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const blips = [
      { angle: -0.45, radius: 0.55, size: 2.4 },
      { angle: 2.3, radius: 0.62, size: 2 },
      { angle: 1.4, radius: 0.55, size: 1.8 },
      { angle: -1.2, radius: 0.48, size: 1.8 },
      { angle: 0.45, radius: 0.7, size: 2 },
      { angle: 2.95, radius: 0.4, size: 1.6 },
    ].map((blip) => ({ ...blip, hit: -9999 }));

    const cx = size / 2;
    const cy = size / 2;
    const radius = 90;
    const start = performance.now();
    let raf = 0;

    const angleDistance = (a: number, b: number) => {
      let distance = a - b;
      while (distance > Math.PI) distance -= Math.PI * 2;
      while (distance < -Math.PI) distance += Math.PI * 2;
      return distance;
    };

    const draw = (time: number) => {
      const elapsed = (time - start) / 1000;
      const sweep = -Math.PI / 2 + (elapsed * Math.PI * 2) / 4;
      ctx.clearRect(0, 0, size, size);

      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
      glow.addColorStop(0, "rgba(57,255,79,0.22)");
      glow.addColorStop(1, "rgba(57,255,79,0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = "rgba(57,255,79,0.38)";
      ctx.lineWidth = 0.75;
      ctx.setLineDash([2, 4]);
      [30, 60, 90].forEach((ring) => {
        ctx.beginPath();
        ctx.arc(cx, cy, ring, 0, Math.PI * 2);
        ctx.stroke();
      });
      ctx.setLineDash([]);

      ctx.strokeStyle = "rgba(57,255,79,0.24)";
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.moveTo(cx, 10);
      ctx.lineTo(cx, size - 10);
      ctx.moveTo(10, cy);
      ctx.lineTo(size - 10, cy);
      ctx.stroke();

      const trail = Math.PI / 2.2;
      for (let index = 0; index < 24; index += 1) {
        const a0 = sweep - (trail * (index + 1)) / 24;
        const a1 = sweep - (trail * index) / 24;
        const alpha = 0.24 * (1 - index / 24);
        ctx.fillStyle = `rgba(57,255,79,${alpha})`;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, radius, a0, a1);
        ctx.closePath();
        ctx.fill();
      }

      ctx.strokeStyle = "rgba(200,255,208,0.96)";
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(sweep) * radius, cy + Math.sin(sweep) * radius);
      ctx.stroke();

      blips.forEach((blip) => {
        const distance = angleDistance(sweep, blip.angle);
        if (distance >= 0 && distance < 0.06 && time - blip.hit > 800) blip.hit = time;
        const age = (time - blip.hit) / 1000;
        const pulse = age >= 0 && age < 1.6 ? Math.exp(-age * 1.8) : 0;
        const grow = 1 + pulse * 1.8;
        const x = cx + Math.cos(blip.angle) * radius * blip.radius;
        const y = cy + Math.sin(blip.angle) * radius * blip.radius;
        ctx.fillStyle = `rgba(255,153,0,${0.18 + pulse * 0.5})`;
        ctx.beginPath();
        ctx.arc(x, y, blip.size * grow * 2.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `rgba(255,190,80,${0.85 + pulse * 0.15})`;
        ctx.beginPath();
        ctx.arc(x, y, blip.size * grow, 0, Math.PI * 2);
        ctx.fill();
      });

      ctx.strokeStyle = "rgba(57,255,79,0.55)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.stroke();

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    const tick = window.setInterval(() => {
      setSignal((current) => {
        const next = current + (Math.random() - 0.5) * 0.6;
        return Math.max(Math.max(0, percentage - 1.6), Math.min(Math.min(100, percentage + 1.6), next));
      });
    }, 280);

    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(tick);
    };
  }, [percentage]);

  return (
    <>
      <canvas ref={canvasRef} className="mx-auto mt-3 block" />
      <div className="mt-3 flex justify-between text-[11px] uppercase tracking-[0.16em]">
        <span className="text-muted-foreground">Signal</span>
        <span className="font-mono text-accent">{signal.toFixed(1)}% rising</span>
      </div>
    </>
  );
}

function SectionHeader({ icon, title, meta }: { icon?: ReactNode; title: string; meta?: string }) {
  return (
    <div className="mb-4 flex flex-wrap items-baseline gap-3">
      <div className="mwz-progress-strip h-1 w-10" />
      <h2 className="mwz-section-title flex items-center gap-2 text-2xl md:text-3xl">
        {icon}
        {title}
      </h2>
      {meta ? <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{meta}</span> : null}
    </div>
  );
}

function CountdownCard({ draft, countdown }: { draft: CampaignDraft; countdown: ReturnType<typeof timeUntil> }) {
  return (
    <div className="mwz-card p-5">
      <div className="mb-3 text-[11px] uppercase tracking-[0.18em] text-accent">Deploy Window</div>
      <div className="grid grid-cols-4 gap-2">
        {[
          [countdown.days, "D"],
          [countdown.hours, "H"],
          [countdown.minutes, "M"],
          [countdown.seconds, "S"],
        ].map(([value, label]) => (
          <div key={label} className="border border-border bg-background/70 px-1 py-3 text-center">
            <div className="font-retro text-3xl leading-none text-foreground">{value}</div>
            <div className="mt-1 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{label}</div>
          </div>
        ))}
      </div>
      <div className="mt-3 text-center text-xs text-muted-foreground">
        Estimated deploy: <span className="text-foreground">{formatDraftDateTime(draft.deployTarget)}</span>
      </div>
    </div>
  );
}

function ReconSignalCard({ popularity }: { popularity: DraftPopularity }) {
  const rows = [
    ["Notifications armed", formatNumber(popularity.totals.signedInActions), <Bell className="h-4 w-4" />],
    ["On watchlists", formatNumber(popularity.totals.follows), <Star className="h-4 w-4" />],
    ["Comments", formatNumber(popularity.totals.comments), <MessageSquare className="h-4 w-4" />],
    ["Shares", formatNumber(popularity.totals.shares), <Share2 className="h-4 w-4" />],
  ] as const;

  return (
    <div className="mwz-card p-5">
      <div className="mb-3 text-[11px] uppercase tracking-[0.18em] text-accent">Recon Signal</div>
      <div className="space-y-1">
        {rows.map(([label, value, icon], index) => (
          <div key={label} className={cn("flex items-center justify-between gap-3 py-2", index < rows.length - 1 && "border-b border-border/60")}>
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <span className="text-accent">{icon}</span>
              {label}
            </div>
            <span className="font-mono text-sm text-foreground">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CommsCard({ draft }: { draft: CampaignDraft }) {
  const links = [
    ["X", draft.communityLinks.x, <Flame className="h-4 w-4" />],
    ["Telegram", draft.communityLinks.telegram, <Users className="h-4 w-4" />],
    ["Discord", draft.communityLinks.discord, <MessageSquare className="h-4 w-4" />],
    ["Website", draft.communityLinks.website, <Globe className="h-4 w-4" />],
  ] as const;

  return (
    <div className="mwz-card p-4">
      <div className="mb-3 text-[11px] uppercase tracking-[0.18em] text-accent">Comms</div>
      <div className="grid grid-cols-2 gap-2">
        {links.map(([label, url, icon]) => (
          <a
            key={label}
            href={url || "#"}
            target="_blank"
            rel="noreferrer"
            className={cn("mwz-button h-10 justify-start px-3 text-xs", !url && "pointer-events-none opacity-50")}
          >
            {icon}
            <span className="min-w-0 truncate">{externalLabel(url)}</span>
          </a>
        ))}
      </div>
    </div>
  );
}

function TokenomicsSection() {
  const allocations = [
    ["Liquidity pool", 80, "bg-accent"],
    ["Community rewards", 12, "bg-success"],
    ["Creator vested", 5, "bg-orange-400"],
    ["Marketing and leagues", 3, "bg-yellow-300"],
  ] as const;
  const rules = [
    ["Tax on buys", "0%"],
    ["Tax on sells", "0%"],
    ["LP locked", "12 months"],
    ["Mint disabled", "Yes"],
    ["Freeze authority", "Revoked"],
    ["Bonding curve", "85 BNB graduate"],
  ] as const;

  return (
    <section className="mt-12">
      <SectionHeader title="Tokenomics" meta="/ section 02 template: standard split" icon={<ShieldCheck className="h-5 w-5 text-accent" />} />
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="mwz-card p-5 md:p-6">
          <div className="mb-3 text-[11px] uppercase tracking-[0.18em] text-accent">Supply</div>
          <div className="font-retro text-4xl text-foreground md:text-5xl">1,000,000,000</div>
          <div className="mt-1 text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Fixed no mint function</div>
          <div className="mt-5 space-y-3">
            {allocations.map(([label, percent, color]) => (
              <div key={label}>
                <div className="mb-1 flex justify-between gap-3 text-xs">
                  <span className="text-muted-foreground">{label}</span>
                  <span className="font-mono text-accent">{percent}%</span>
                </div>
                <div className="h-2 border border-border bg-background">
                  <div className={cn("h-full", color)} style={{ width: `${percent}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="mwz-card p-5 md:p-6">
          <div className="mb-3 text-[11px] uppercase tracking-[0.18em] text-accent">Rules Of Engagement</div>
          {rules.map(([label, value], index) => (
            <div key={label} className={cn("flex items-center justify-between gap-4 py-3 text-sm", index < rules.length - 1 && "border-b border-border/60")}>
              <span className="text-muted-foreground">{label}</span>
              <span className="font-mono text-foreground">{value}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function MissionPhases({ draft }: { draft: CampaignDraft }) {
  return (
    <section className="mt-12">
      <SectionHeader title="Mission Phases" meta="/ section 03 template: roadmap" icon={<Rocket className="h-5 w-5 text-accent" />} />
      <div className="mwz-card p-5 md:p-7">
        <div className="relative grid gap-5 md:grid-cols-4 md:gap-0">
          <div className="absolute left-[12.5%] right-[12.5%] top-4 hidden h-px bg-[linear-gradient(90deg,var(--mwz-orange)_0%,var(--mwz-orange)_25%,rgba(57,255,79,0.35)_25%,rgba(57,255,79,0.35)_100%)] md:block" />
          {draft.roadmap.slice(0, 4).map((item, index) => {
            const active = index === 0;
            return (
              <div key={item.id} className="relative pr-4 md:pt-9">
                <div
                  className={cn(
                    "mb-3 h-4 w-4 border-2 md:absolute md:left-0 md:top-2",
                    active ? "border-accent bg-accent shadow-[0_0_14px_var(--mwz-orange)]" : "border-border bg-background",
                  )}
                />
                <div className={cn("text-[10px] uppercase tracking-[0.18em]", active ? "text-accent" : "text-muted-foreground")}>
                  Phase {String(index + 1).padStart(2, "0")}
                </div>
                <div className={cn("mt-1 font-retro text-xl", active ? "text-foreground" : "text-muted-foreground")}>{item.title}</div>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{item.body}</p>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function BunkerComment({
  comment,
  account,
  onReact,
}: {
  comment: DraftComment;
  account: string;
  onReact: (commentId: string) => void;
}) {
  const reacted = account ? comment.reactions.some((item) => item.toLowerCase() === account.toLowerCase()) : false;

  return (
    <div className="flex gap-3 border-t border-border/70 py-4">
      <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-border bg-background font-retro text-xs text-accent">
        {comment.authorLabel.replace("@", "").slice(0, 2).toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="font-retro text-sm text-foreground">{comment.authorLabel}</span>
          <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
            Recon <WalletLabel wallet={comment.authorAddress} /> {formatShortTime(comment.createdAt)}
          </span>
        </div>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">{comment.body}</p>
        <div className="mt-2 flex gap-4 text-xs text-muted-foreground">
          <button type="button" onClick={() => onReact(comment.id)} className={cn("inline-flex items-center gap-1 hover:text-foreground", reacted && "text-accent")}>
            <ThumbsUp className="h-4 w-4" />
            {comment.reactions.length}
          </button>
          <button type="button" className="inline-flex items-center gap-1 hover:text-foreground">
            <Reply className="h-4 w-4" />
            Reply
          </button>
        </div>
      </div>
    </div>
  );
}

const PublicPromotion = () => {
  const params = useParams();
  const wallet = useWallet();
  const [draft, setDraft] = useState<CampaignDraft | null>(null);
  const [commentBody, setCommentBody] = useState("");
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const next = getDraftBySlug(params.slug) || demoDraft;
    const viewKey = `mwz_prepare_viewed_${next.id}`;
    let viewed = false;
    try {
      viewed = window.sessionStorage.getItem(viewKey) === "1";
      if (!viewed) window.sessionStorage.setItem(viewKey, "1");
    } catch {
      viewed = false;
    }
    setDraft(viewed ? next : recordDraftView(next.id) || next);
  }, [params.slug]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const onDraftsChanged = () => setDraft((current) => (current ? getDraftBySlug(current.slug) || current : current));
    window.addEventListener("mwz:drafts-changed", onDraftsChanged as EventListener);
    return () => window.removeEventListener("mwz:drafts-changed", onDraftsChanged as EventListener);
  }, []);

  const popularity = useMemo(() => (draft ? calculateDraftPopularity(draft) : null), [draft]);
  const countdown = useMemo(() => (draft ? timeUntil(draft.deployTarget, now) : timeUntil("", now)), [draft, now]);

  if (!draft || !popularity) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-10">
        <div className="mwz-panel p-6 font-retro text-muted-foreground">Loading Prepare Mode page...</div>
      </div>
    );
  }

  const account = wallet.account || "";
  const followed = isDraftFollowed(draft.id, account);
  const isOwner = draft.creatorAddress === "local-creator" || account.toLowerCase() === draft.creatorAddress.toLowerCase();
  const privateBlocked = draft.visibility === "private" && !isOwner;
  const publicUrl = typeof window !== "undefined" ? `${window.location.origin}/prepare/${draft.slug}` : `/prepare/${draft.slug}`;

  const requireWallet = () => {
    if (wallet.isConnected && wallet.account) return wallet.account;
    window.dispatchEvent(new CustomEvent("memewarzone:openWalletModal"));
    toast.message("Connect your wallet to join this draft.");
    return "";
  };

  const handleFollow = () => {
    const address = requireWallet();
    if (!address) return;
    const next = toggleDraftFollow(draft.id, address);
    if (next) {
      setDraft(next);
      toast.success(followed ? "Removed from watchlist." : "Draft added to watchlist.");
    }
  };

  const handleShare = async () => {
    try {
      await navigator.clipboard.writeText(`${draft.shareMessage}\n${publicUrl}`);
      toast.success("Dossier link copied.");
    } catch {
      toast.message(publicUrl);
    }
    const next = recordDraftShare(draft.id, account || null);
    if (next) setDraft(next);
  };

  const handleComment = () => {
    const address = requireWallet();
    if (!address) return;
    const next = addDraftComment(draft.id, address, commentBody);
    if (next) {
      setDraft(next);
      setCommentBody("");
      toast.success("Transmission posted.");
    }
  };

  const handleReaction = (commentId: string) => {
    const address = requireWallet();
    if (!address) return;
    const next = toggleDraftCommentReaction(draft.id, commentId, address);
    if (next) setDraft(next);
  };

  if (privateBlocked) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10">
        <div className="mwz-panel p-8 text-center">
          <Lock className="mx-auto mb-4 h-10 w-10 text-accent" />
          <h1 className="mwz-section-title text-3xl">Private Draft</h1>
          <p className="mt-3 text-sm text-muted-foreground">This Prepare Mode page is only visible to the creator.</p>
          <Button type="button" onClick={requireWallet} className="mwz-button mt-5 font-retro">
            Connect wallet
          </Button>
        </div>
      </div>
    );
  }

  const profileTarget = draft.creatorAddress.startsWith("0x")
    ? `/profile?address=${encodeURIComponent(draft.creatorAddress)}`
    : "/profile?tab=balances";

  return (
    <div className="mx-auto w-full max-w-[1480px] px-1 py-4 md:px-2 md:py-6">
      <div className="mb-4 flex flex-wrap items-center gap-3 border border-border/70 bg-background/70 px-3 py-2">
        <DraftStatusPill draft={draft} />
        <span className="text-xs uppercase tracking-[0.16em] text-muted-foreground">
          This recon page is shared by the creator. The coin has not deployed yet.
        </span>
        {isOwner ? (
          <Button asChild className="mwz-button ml-auto h-9 px-3 text-xs font-retro">
            <Link to={`/drafts/${draft.id}/promotion`}>Edit setup</Link>
          </Button>
        ) : null}
      </div>

      <main className="pb-12">
        <section className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="mwz-card mwz-panel overflow-hidden p-5 md:p-7">
            <div className="pointer-events-none absolute -right-20 -top-20 h-72 w-72 rounded-full bg-accent/10 blur-3xl" />
            <div className="relative">
              <div className="mb-5 flex flex-wrap items-center gap-2">
                <span className="text-[11px] uppercase tracking-[0.18em] text-accent">// Dossier</span>
                <span className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                  #{draft.id.slice(-6).toUpperCase()} Chain: BNB
                </span>
                <span className="mwz-chip px-2 py-1 text-[10px]">{draft.visibility}</span>
                <span className="mwz-chip mwz-chip-active px-2 py-1 text-[10px]">{popularity.label}</span>
              </div>

              <div className="flex flex-col gap-5 md:flex-row md:items-start">
                <CoinAvatar draft={draft} size="h-28 w-28 md:h-32 md:w-32" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm uppercase tracking-[0.16em] text-accent">${draft.ticker}</div>
                  <h1 className="mwz-section-title mt-1 break-words text-5xl leading-none md:text-7xl">{draft.name}</h1>
                  <p className="mt-3 max-w-2xl text-base leading-7 text-muted-foreground">{draft.tagline}</p>

                  <div className="mt-5 flex flex-wrap gap-2">
                    <Button type="button" onClick={handleFollow} className={cn(actionClass, followed && "mwz-button-orange")}>
                      <Bell className="h-4 w-4" />
                      {followed ? "Notification armed" : "Get notified on launch"}
                    </Button>
                    <Button type="button" onClick={handleFollow} className={cn(actionClass, followed && "mwz-button-orange")}>
                      <Star className="h-4 w-4" />
                      {followed ? "Watching" : "Watchlist"}
                    </Button>
                    <Button type="button" onClick={handleShare} className={actionClass}>
                      <Share2 className="h-4 w-4" />
                      Share
                    </Button>
                  </div>
                </div>
              </div>

              <div className="mt-7 flex flex-col justify-between gap-4 border-t border-dashed border-border/80 pt-5 md:flex-row md:items-center">
                <div className="flex items-center gap-3">
                  <div className="grid h-10 w-10 place-items-center rounded-full border border-border bg-background font-retro text-xs text-accent">
                    {draft.creatorHandle.replace("@", "").slice(0, 2).toUpperCase()}
                  </div>
                  <div>
                    <div className="font-retro text-sm text-foreground">
                      Built by <span className="text-accent">{draft.creatorHandle}</span>
                    </div>
                    <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground">
                      Recruiter since {formatDraftDate(draft.createdAt)} {draft.status === "launched" ? "live" : "draft mode"}
                    </div>
                  </div>
                </div>
                <Button asChild className="mwz-button h-9 px-3 text-xs font-retro">
                  <Link to={profileTarget}>
                    <Eye className="h-4 w-4" />
                    View profile
                  </Link>
                </Button>
              </div>
            </div>
          </div>

          <aside className="flex flex-col gap-4">
            <CountdownCard draft={draft} countdown={countdown} />
            <div className="mwz-card p-5">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-[11px] uppercase tracking-[0.18em] text-accent">Recon Radar</div>
                <span className="font-mono text-xs text-muted-foreground">{popularity.percentage}%</span>
              </div>
              <ReconRadar percentage={popularity.percentage} />
            </div>
            <ReconSignalCard popularity={popularity} />
            <CommsCard draft={draft} />
          </aside>
        </section>

        <section className="mt-12">
          <SectionHeader title="The Brief" meta="/ section 01 added by creator" icon={<FileText className="h-5 w-5 text-accent" />} />
          <div className="mwz-card p-5 md:p-7">
            <p className="max-w-4xl text-base leading-8 text-muted-foreground">
              {draft.mission || draft.description}
              {draft.creatorNote ? (
                <>
                  <br />
                  <br />
                  <span className="text-foreground">{draft.creatorNote}</span>
                </>
              ) : null}
            </p>
          </div>
        </section>

        <TokenomicsSection />
        <MissionPhases draft={draft} />

        <section className="mt-12">
          <SectionHeader title="The Bunker" meta={`/ section 04 ${formatNumber(popularity.totals.comments)} transmissions`} icon={<MessageSquare className="h-5 w-5 text-accent" />} />
          <div className="mwz-card p-4 md:p-6">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              {[
                ["Fire", popularity.totals.reactions + 142, <Flame className="h-4 w-4" />],
                ["Signal", popularity.totals.follows + 88, <Radio className="h-4 w-4" />],
                ["Send", popularity.totals.shares + 67, <Rocket className="h-4 w-4" />],
                ["Trust", popularity.totals.uniqueCommenters + 54, <Check className="h-4 w-4" />],
              ].map(([label, value, icon]) => (
                <button key={String(label)} type="button" className="mwz-button h-9 px-3 text-xs">
                  {icon}
                  {label} {formatNumber(Number(value))}
                </button>
              ))}
              <div className="flex-1" />
              <Button type="button" onClick={handleComment} className="mwz-button h-9 px-3 text-xs font-retro">
                <Send className="h-4 w-4" />
                React
              </Button>
            </div>

            <div className="mb-4 border border-border/80 bg-background/60 p-3">
              <Textarea
                value={commentBody}
                onChange={(event) => setCommentBody(event.target.value)}
                className="min-h-20 resize-none border-border bg-background/70 font-retro text-foreground placeholder:text-muted-foreground"
                placeholder={wallet.isConnected ? "Drop a transmission..." : "Drop a transmission... connect wallet to post"}
                maxLength={500}
              />
              <div className="mt-3 flex items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground">{commentBody.length}/500</span>
                <Button type="button" onClick={handleComment} className="mwz-button h-10 px-4 font-retro">
                  <Send className="h-4 w-4" />
                  Send transmission
                </Button>
              </div>
            </div>

            {draft.comments.map((comment) => (
              <BunkerComment key={comment.id} comment={comment} account={account} onReact={handleReaction} />
            ))}
          </div>
        </section>

        <section className="mt-12">
          <div className="mwz-card mwz-panel overflow-hidden p-7 text-center md:p-10">
            <div className="mwz-progress-strip absolute left-0 right-0 top-0 h-1" />
            <div className="text-[11px] uppercase tracking-[0.18em] text-accent">// Deployment imminent</div>
            <h3 className="mwz-section-title mt-2 text-4xl md:text-5xl">Do not miss the drop.</h3>
            <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
              Get pinged the second ${draft.ticker} hits the bonding curve. {formatNumber(popularity.totals.signedInActions)} recruits already armed.
            </p>
            <div className="mx-auto mt-6 flex max-w-xl flex-col gap-2 sm:flex-row">
              <Input className="h-12 border-border bg-background/70 font-retro text-foreground placeholder:text-muted-foreground" placeholder="wallet address or notification handle" />
              <Button type="button" onClick={handleFollow} className="mwz-button mwz-button-orange h-12 px-5 font-retro">
                <CalendarClock className="h-4 w-4" />
                Arm me
              </Button>
              <Button type="button" onClick={handleShare} className="mwz-button h-12 px-5 font-retro">
                <Copy className="h-4 w-4" />
                Copy
              </Button>
            </div>
            <div className="mt-5 flex flex-wrap justify-center gap-3 text-xs uppercase tracking-[0.16em] text-muted-foreground">
              <a href={draft.docsLinks.litepaper || "#"} target="_blank" rel="noreferrer" className={cn("inline-flex items-center gap-2 hover:text-foreground", !draft.docsLinks.litepaper && "pointer-events-none opacity-50")}>
                <Link2 className="h-4 w-4" />
                Litepaper
              </a>
              <span>Public URL: {publicUrl.replace(/^https?:\/\//, "")}</span>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
};

export default PublicPromotion;
