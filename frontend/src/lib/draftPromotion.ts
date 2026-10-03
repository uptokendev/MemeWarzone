export type DraftVisibility = "public" | "unlisted" | "private";
export type DraftStatus = "draft" | "published" | "launched";

export type DraftRoadmapItem = {
  id: string;
  title: string;
  body: string;
};

export type DraftLinkSet = {
  website: string;
  x: string;
  telegram: string;
  discord: string;
};

export type DraftDocsSet = {
  litepaper: string;
  audit: string;
  deck: string;
};

export type DraftComment = {
  id: string;
  authorAddress: string;
  authorLabel: string;
  body: string;
  createdAt: string;
  reactions: string[];
  parentId?: string | null;
};

export type DraftNotification = {
  id: string;
  title: string;
  body: string;
  target: string;
  createdAt: string;
  read: boolean;
  kind: "follow" | "comment" | "heat" | "publish" | "launch";
  /** CO-5 notification category from the API; absent on local draft notices (coin events). */
  category?: "battles" | "social" | "rewards" | "coin";
};

export type DraftMetricsSeed = {
  views: number;
  follows: number;
  comments: number;
  uniqueCommenters: number;
  reactions: number;
  shares: number;
  signedInActions: number;
};

export type CampaignDraft = {
  id: string;
  slug: string;
  name: string;
  ticker: string;
  tagline: string;
  description: string;
  logoUrl: string;
  bannerUrl: string;
  creatorAddress: string;
  creatorHandle: string;
  createdAt: string;
  updatedAt: string;
  deployTarget: string;
  status: DraftStatus;
  visibility: DraftVisibility;
  mission: string;
  launchStrategy: string;
  creatorNote: string;
  shareMessage: string;
  communityLinks: DraftLinkSet;
  docsLinks: DraftDocsSet;
  roadmap: DraftRoadmapItem[];
  views: number;
  shares: number;
  signedInActions: number;
  followers: string[];
  comments: DraftComment[];
  metricsSeed: DraftMetricsSeed;
};

export type DraftPopularity = {
  percentage: number;
  label: "Cold" | "Building" | "Heating Up" | "Hot" | "Warzone Trending";
  totals: DraftMetricsSeed;
};

export type CreateDraftInput = {
  name: string;
  ticker: string;
  description?: string;
  logoUrl?: string;
  creatorAddress?: string | null;
  website?: string;
  x?: string;
  extraLink?: string;
};

const DRAFTS_KEY = "mwz_prepare_drafts_v1";
const NOTIFICATIONS_KEY = "mwz_prepare_notifications_v1";

const nowIso = () => new Date().toISOString();

function canUseStorage() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function randomId(prefix: string) {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${id}`;
}

export function slugify(value: string) {
  return String(value || "draft")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "draft";
}

export function shortAddress(address?: string | null) {
  const value = String(address || "").trim();
  if (!value) return "local creator";
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export const demoDraft: CampaignDraft = {
  id: "draft-bunny-x4471",
  slug: "barrack-bunny",
  name: "Barrack Bunny",
  ticker: "BUNNY",
  tagline: "The fluffiest recruit preparing to storm the meme warzone.",
  description:
    "A fair-launch meme coin in Prepare Mode. The squad is gathering before the campaign goes live.",
  logoUrl: "/assets/ticker.png",
  bannerUrl: "/assets/ui/menuandhero.png",
  creatorAddress: "local-creator",
  creatorHandle: "@MEMEWARZONE",
  createdAt: "2026-05-02T10:00:00.000Z",
  updatedAt: "2026-05-02T10:00:00.000Z",
  deployTarget: "2026-05-14T18:00:00.000Z",
  status: "published",
  visibility: "public",
  mission:
    "Barrack Bunny is a community-first meme launch built around weekly meme battles, holder rewards, and a launch page that lets the squad assemble before any gas is spent.",
  launchStrategy:
    "Prepare Mode stays open until launch day. Recruits can watch the draft, comment in The Bunker, share the rally message, and arm launch alerts. The creator pushes live only once the page reaches Hot status and the readiness checklist is complete.",
  creatorNote:
    "No presale, no hidden allocation, and no stealth launch. The campaign goes live when the community signal is loud enough.",
  shareMessage:
    "Barrack Bunny is gathering recruits in Prepare Mode. Watch the draft and get ready for launch.",
  communityLinks: {
    website: "https://memewar.zone",
    x: "https://x.com/memewarzone",
    telegram: "https://t.me/launchpad",
    discord: "https://discord.gg/launchpad",
  },
  docsLinks: {
    litepaper: "https://docs.memewar.zone",
    audit: "",
    deck: "",
  },
  roadmap: [
    {
      id: "phase-1",
      title: "Recon",
      body: "Open the Prepare page, collect watchlists, and refine launch messaging with public feedback.",
    },
    {
      id: "phase-2",
      title: "Deploy",
      body: "Push live from the draft once readiness, creator checks, and launch timing are locked.",
    },
    {
      id: "phase-3",
      title: "Graduate",
      body: "Move from launch momentum into active trading, leagues, and community rewards.",
    },
    {
      id: "phase-4",
      title: "Conquest",
      body: "Run weekly meme battles, feature community winners, and keep the squad active.",
    },
  ],
  views: 0,
  shares: 0,
  signedInActions: 0,
  followers: [],
  metricsSeed: {
    views: 6294,
    follows: 412,
    comments: 127,
    uniqueCommenters: 83,
    reactions: 382,
    shares: 93,
    signedInActions: 214,
  },
  comments: [
    {
      id: "comment-recon-1",
      authorAddress: "0xrecruit000000000000000000000000000000000001",
      authorLabel: "@whalepaw",
      body: "Early page feels clean. Watching this before deploy.",
      createdAt: "2026-05-02T09:15:00.000Z",
      reactions: ["0xseed1", "0xseed2", "0xseed3", "0xseed4"],
    },
    {
      id: "comment-recon-2",
      authorAddress: "0xrecruit000000000000000000000000000000000002",
      authorLabel: "@xenon_bnb",
      body: "Prepare Mode makes sense. I want the launch alert when this goes live.",
      createdAt: "2026-05-02T10:05:00.000Z",
      reactions: ["0xseed5", "0xseed6"],
    },
    {
      id: "comment-recon-3",
      authorAddress: "0xrecruit000000000000000000000000000000000003",
      authorLabel: "@grunt_404",
      body: "The bunker should count for heat. Real comments beat empty views.",
      createdAt: "2026-05-02T11:20:00.000Z",
      reactions: ["0xseed7", "0xseed8", "0xseed9"],
    },
  ],
};

function normalizeDraft(raw: CampaignDraft): CampaignDraft {
  return {
    ...demoDraft,
    ...raw,
    communityLinks: { ...demoDraft.communityLinks, ...(raw.communityLinks || {}) },
    docsLinks: { ...demoDraft.docsLinks, ...(raw.docsLinks || {}) },
    roadmap: Array.isArray(raw.roadmap) && raw.roadmap.length ? raw.roadmap : demoDraft.roadmap,
    comments: Array.isArray(raw.comments) ? raw.comments : [],
    followers: Array.isArray(raw.followers) ? raw.followers : [],
    metricsSeed: { ...demoDraft.metricsSeed, ...(raw.metricsSeed || {}) },
  };
}

export function listDrafts(): CampaignDraft[] {
  if (!canUseStorage()) return [demoDraft];

  try {
    const parsed = JSON.parse(window.localStorage.getItem(DRAFTS_KEY) || "[]");
    const drafts = Array.isArray(parsed) ? parsed.map(normalizeDraft) : [];
    if (!drafts.some((draft) => draft.id === demoDraft.id)) drafts.unshift(demoDraft);
    return drafts;
  } catch {
    return [demoDraft];
  }
}

function writeDrafts(drafts: CampaignDraft[]) {
  if (!canUseStorage()) return;
  window.localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
  window.dispatchEvent(new CustomEvent("mwz:drafts-changed"));
}

export function getDraftById(id?: string | null) {
  const target = String(id || "").trim();
  return listDrafts().find((draft) => draft.id === target) || null;
}

export function getDraftBySlug(slug?: string | null) {
  const target = String(slug || "").trim().toLowerCase();
  return listDrafts().find((draft) => draft.slug.toLowerCase() === target) || null;
}

export function upsertDraft(draft: CampaignDraft) {
  const normalized = normalizeDraft({ ...draft, updatedAt: nowIso() });
  const drafts = listDrafts().filter((item) => item.id !== normalized.id);
  writeDrafts([normalized, ...drafts]);
  return normalized;
}

export function createDraft(input: CreateDraftInput) {
  const ticker = input.ticker.trim().toUpperCase();
  const name = input.name.trim();
  const baseSlug = slugify(`${name}-${ticker}`);
  const slugExists = new Set(listDrafts().map((draft) => draft.slug));
  let slug = baseSlug;
  let suffix = 2;
  while (slugExists.has(slug)) {
    slug = `${baseSlug}-${suffix}`;
    suffix += 1;
  }

  const createdAt = nowIso();
  const draft: CampaignDraft = {
    ...demoDraft,
    id: randomId("draft"),
    slug,
    name,
    ticker,
    tagline: input.description?.trim() || `${ticker} is gathering launch signal in Prepare Mode.`,
    description: input.description?.trim() || "",
    logoUrl: input.logoUrl || "/assets/ticker.png",
    bannerUrl: "/assets/ui/menuandhero.png",
    creatorAddress: input.creatorAddress?.toLowerCase() || "local-creator",
    creatorHandle: input.creatorAddress ? shortAddress(input.creatorAddress) : "local creator",
    createdAt,
    updatedAt: createdAt,
    deployTarget: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    status: "draft",
    visibility: "unlisted",
    mission: input.description?.trim() || "",
    launchStrategy: "",
    creatorNote: "",
    shareMessage:
      `Incoming transmission from the Warzone:\n\n` +
      `${name} is preparing for war on MemeWarzone.\n\n` +
      `Follow the signal → @memewarzone`,
    communityLinks: {
      website: input.website || "",
      x: input.x || "",
      telegram: "",
      discord: input.extraLink || "",
    },
    docsLinks: {
      litepaper: "",
      audit: "",
      deck: "",
    },
    views: 0,
    shares: 0,
    signedInActions: 0,
    followers: [],
    comments: [],
    metricsSeed: {
      views: 0,
      follows: 0,
      comments: 0,
      uniqueCommenters: 0,
      reactions: 0,
      shares: 0,
      signedInActions: 0,
    },
  };

  upsertDraft(draft);
  addNotification({
    id: randomId("note"),
    title: "Draft created",
    body: `${draft.ticker} is ready for promotion setup.`,
    target: `/drafts/${draft.id}/promotion`,
    createdAt,
    read: false,
    kind: "publish",
  });
  return draft;
}

export function hasTickerDraft(ticker: string, ownerAddress?: string | null) {
  const normalizedTicker = ticker.trim().toUpperCase();
  const owner = ownerAddress?.toLowerCase();
  return listDrafts().some((draft) => {
    if (draft.ticker.toUpperCase() !== normalizedTicker) return false;
    if (!owner) return true;
    return draft.creatorAddress.toLowerCase() === owner;
  });
}

export function countDraftsForOwner(ownerAddress?: string | null) {
  const owner = ownerAddress?.toLowerCase() || "local-creator";
  return listDrafts().filter((draft) => draft.creatorAddress.toLowerCase() === owner).length;
}

export function recordDraftView(id: string) {
  const draft = getDraftById(id);
  if (!draft) return null;
  return upsertDraft({ ...draft, views: draft.views + 1 });
}

export function recordDraftShare(id: string, actor?: string | null) {
  const draft = getDraftById(id);
  if (!draft) return null;
  const signedInActions = actor ? draft.signedInActions + 1 : draft.signedInActions;
  return upsertDraft({ ...draft, shares: draft.shares + 1, signedInActions });
}

export function isDraftFollowed(id: string, address?: string | null) {
  if (!address) return false;
  const draft = getDraftById(id);
  const key = address.toLowerCase();
  return Boolean(draft?.followers.some((item) => item.toLowerCase() === key));
}

export function toggleDraftFollow(id: string, address: string) {
  const draft = getDraftById(id);
  if (!draft) return null;
  const key = address.toLowerCase();
  const follows = draft.followers.some((item) => item.toLowerCase() === key);
  const nextFollowers = follows
    ? draft.followers.filter((item) => item.toLowerCase() !== key)
    : [...draft.followers, key];
  const next = upsertDraft({
    ...draft,
    followers: nextFollowers,
    signedInActions: follows ? draft.signedInActions : draft.signedInActions + 1,
  });
  if (!follows) {
    addNotification({
      id: randomId("note"),
      title: "Draft watched",
      body: `${shortAddress(address)} watched ${draft.ticker}.`,
      target: `/prepare/${draft.slug}`,
      createdAt: nowIso(),
      read: false,
      kind: "follow",
    });
  }
  return next;
}

export function addDraftComment(id: string, address: string, body: string) {
  const draft = getDraftById(id);
  const trimmed = body.trim();
  if (!draft || !trimmed) return null;
  const comment: DraftComment = {
    id: randomId("comment"),
    authorAddress: address.toLowerCase(),
    authorLabel: shortAddress(address),
    body: trimmed.slice(0, 500),
    createdAt: nowIso(),
    reactions: [],
  };
  const next = upsertDraft({
    ...draft,
    comments: [comment, ...draft.comments],
    signedInActions: draft.signedInActions + 1,
  });
  addNotification({
    id: randomId("note"),
    title: "New bunker comment",
    body: `${comment.authorLabel} commented on ${draft.ticker}.`,
    target: `/prepare/${draft.slug}`,
    createdAt: comment.createdAt,
    read: false,
    kind: "comment",
  });
  return next;
}

export function toggleDraftCommentReaction(id: string, commentId: string, address: string) {
  const draft = getDraftById(id);
  if (!draft) return null;
  const key = address.toLowerCase();
  const comments = draft.comments.map((comment) => {
    if (comment.id !== commentId) return comment;
    const active = comment.reactions.some((item) => item.toLowerCase() === key);
    return {
      ...comment,
      reactions: active
        ? comment.reactions.filter((item) => item.toLowerCase() !== key)
        : [...comment.reactions, key],
    };
  });
  return upsertDraft({ ...draft, comments, signedInActions: draft.signedInActions + 1 });
}

export function publishDraft(id: string) {
  const draft = getDraftById(id);
  if (!draft) return null;
  const next = upsertDraft({ ...draft, status: "published", visibility: draft.visibility === "private" ? "unlisted" : draft.visibility });
  addNotification({
    id: randomId("note"),
    title: "Promotion page published",
    body: `${draft.ticker} is now available at /prepare/${draft.slug}.`,
    target: `/prepare/${draft.slug}`,
    createdAt: nowIso(),
    read: false,
    kind: "publish",
  });
  return next;
}

export function calculateDraftPopularity(draft: CampaignDraft): DraftPopularity {
  const commentAuthors = new Set(draft.comments.map((comment) => comment.authorAddress.toLowerCase()));
  const commentReactions = draft.comments.reduce((total, comment) => total + comment.reactions.length, 0);
  const totals: DraftMetricsSeed = {
    views: draft.metricsSeed.views + draft.views,
    follows: draft.metricsSeed.follows + draft.followers.length,
    comments: draft.metricsSeed.comments + draft.comments.length,
    uniqueCommenters: draft.metricsSeed.uniqueCommenters + commentAuthors.size,
    reactions: draft.metricsSeed.reactions + commentReactions,
    shares: draft.metricsSeed.shares + draft.shares,
    signedInActions: draft.metricsSeed.signedInActions + draft.signedInActions,
  };

  const weighted =
    totals.follows * 9 +
    totals.uniqueCommenters * 12 +
    totals.comments * 4 +
    totals.reactions * 3 +
    totals.shares * 5 +
    totals.signedInActions * 6 +
    Math.min(totals.views, 8000) * 0.18;

  const percentage = Math.max(0, Math.min(100, Math.round(weighted / 78)));
  const label =
    percentage <= 20
      ? "Cold"
      : percentage <= 50
        ? "Building"
        : percentage <= 75
          ? "Heating Up"
          : percentage <= 90
            ? "Hot"
            : "Warzone Trending";

  return { percentage, label, totals };
}

function readNotifications(): DraftNotification[] {
  if (!canUseStorage()) return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(NOTIFICATIONS_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeNotifications(items: DraftNotification[]) {
  if (!canUseStorage()) return;
  window.localStorage.setItem(NOTIFICATIONS_KEY, JSON.stringify(items.slice(0, 50)));
  window.dispatchEvent(new CustomEvent("mwz:notifications-changed"));
}

export function getDraftNotifications(): DraftNotification[] {
  const stored = readNotifications();
  if (stored.length > 0) return stored;
  const seeded: DraftNotification[] = [
    {
      id: "seed-note-hot",
      title: "Draft reached Hot status",
      body: "BUNNY crossed the Hot threshold in Prepare Mode.",
      target: "/prepare/barrack-bunny",
      createdAt: "2026-05-02T12:00:00.000Z",
      read: false,
      kind: "heat",
    },
    {
      id: "seed-note-comment",
      title: "New bunker comment",
      body: "@grunt_404 commented on BUNNY.",
      target: "/prepare/barrack-bunny",
      createdAt: "2026-05-02T11:20:00.000Z",
      read: false,
      kind: "comment",
    },
    {
      id: "seed-note-publish",
      title: "Promotion page published",
      body: "The BUNNY Prepare page is public.",
      target: "/drafts/draft-bunny-x4471/promotion",
      createdAt: "2026-05-02T10:00:00.000Z",
      read: true,
      kind: "publish",
    },
  ];
  writeNotifications(seeded);
  return seeded;
}

export function addNotification(notification: DraftNotification) {
  writeNotifications([notification, ...getDraftNotifications()]);
}

export function markDraftNotificationRead(id: string) {
  writeNotifications(getDraftNotifications().map((item) => (item.id === id ? { ...item, read: true } : item)));
}

export function markAllDraftNotificationsRead() {
  writeNotifications(getDraftNotifications().map((item) => ({ ...item, read: true })));
}

export function formatDraftDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "TBD";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatDraftDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "TBD";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
