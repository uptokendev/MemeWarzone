import { useCallback, useEffect, useMemo, useState } from "react";
import { ItemMenu } from "@/components/moderation/ItemMenu";
import { useModeration } from "@/hooks/useModeration";
import { WalletLabel } from "@/components/ui-v2/WalletLabel";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { OperativeMark } from "@/components/ui-v2/OperativeMark";
import { Textarea } from "@/components/ui/textarea";
import { AbuseReportShortcut, currentPageUrl } from "@/components/abuse/AbuseReportShortcut";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { useWallet } from "@/contexts/WalletContext";
import { useFeedSession } from "@/hooks/useFeedSession";
import { isSolanaAddress } from "@/lib/address";
import { apiFetch } from "@/lib/apiBase";
import { isSolanaChainId } from "@/lib/chainConfig";
import { signSolanaMessage } from "@/lib/solanaWallet";
import { toast } from "sonner";

type TokenCommentsProps = {
  chainId: number;
  campaignAddress: string;
  tokenAddress?: string;
  mode?: "comments" | "chat" | "updates";
  authorFilterAddress?: string;
  hideComposer?: boolean;
  pollIntervalMs?: number;
  emptyStateText?: string;
};

type CommentRow = {
  id: number;
  body: string;
  createdAt: string;
  authorAddress: string;
  parentId?: number | null;
  authorDisplayName?: string | null;
  authorAvatarUrl?: string | null;
};

const isEvmAddress = (v?: string | null) => /^0x[a-fA-F0-9]{40}$/.test(String(v ?? ""));
const isCampaignAddress = (v?: string | null) => isEvmAddress(v) || isSolanaAddress(v);
const canonAddress = (v?: string | null, solana = false) => {
  const raw = String(v || "").trim();
  if (solana || isSolanaAddress(raw)) return isSolanaAddress(raw) ? raw : "";
  return isEvmAddress(raw) ? raw.toLowerCase() : "";
};

const shorten = (addr: string) =>
  addr.length > 10 ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr;

const initials = (nameOrAddr: string) => {
  const s = (nameOrAddr ?? "").trim();
  if (!s) return "?";
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase();
};

const timeAgo = (iso: string) => {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const now = Date.now();
  const diff = Math.max(0, now - t);
  const s = Math.floor(diff / 1000);
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  const w = Math.floor(d / 7);
  return `${w}w`;
};

async function readJson(res: Response) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function getNonce(chainId: number, address: string): Promise<string> {
  const url = `/api/auth/nonce?chainId=${encodeURIComponent(String(chainId))}&address=${encodeURIComponent(address)}`;
  const res = await apiFetch(url, { method: "GET" });
  if (!res.ok) {
    const j = await readJson(res);
    throw new Error(j?.error || `Nonce request failed (${res.status})`);
  }
  const j = await res.json();
  if (!j?.nonce) throw new Error("Nonce missing");
  return String(j.nonce);
}

function buildCommentMessage(args: {
  chainId: number;
  address: string;
  campaignAddress: string;
  nonce: string;
  body: string;
}) {
  const bodyPreview = args.body.replace(/\s+/g, " ").trim().slice(0, 180);
  return [
    "MemeWarzone Comment",
    `Action: COMMENT_CREATE`,
    `ChainId: ${args.chainId}`,
    `Address: ${isSolanaAddress(args.address) ? args.address : args.address.toLowerCase()}`,
    `Campaign: ${isSolanaAddress(args.campaignAddress) ? args.campaignAddress : args.campaignAddress.toLowerCase()}`,
    `Nonce: ${args.nonce}`,
    "",
    bodyPreview,
  ].join("\n");
}

export function TokenComments({
  chainId,
  campaignAddress,
  tokenAddress,
  mode = "comments",
  authorFilterAddress,
  hideComposer = false,
  pollIntervalMs,
  emptyStateText,
}: TokenCommentsProps) {
  const wallet = useWallet();
  const solanaWallet = useSolanaWallet();
  const solana = isSolanaChainId(chainId) || isSolanaAddress(campaignAddress);
  const account = solana ? String(solanaWallet.solanaAccount || "").trim() : String(wallet.account || "").trim();
  const [items, setItems] = useState<CommentRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [posting, setPosting] = useState(false);
  const [body, setBody] = useState("");
  const moderation = useModeration();
  const feedSession = useFeedSession();
  const [error, setError] = useState<string | null>(null);

  const normalizedCampaign = useMemo(() => canonAddress(campaignAddress, solana), [campaignAddress, solana]);
  const normalizedToken = useMemo(() => canonAddress(tokenAddress, solana) || undefined, [solana, tokenAddress]);
  const normalizedAuthorFilter = useMemo(
    () => canonAddress(authorFilterAddress, solana),
    [authorFilterAddress, solana],
  );

  const load = useCallback(async () => {
    if (!isCampaignAddress(normalizedCampaign)) return;
    try {
      setLoading(true);
      setError(null);
      const url = `/api/comments?chainId=${encodeURIComponent(String(chainId))}&campaignAddress=${encodeURIComponent(normalizedCampaign)}`;
      const res = await apiFetch(url);
      if (!res.ok) {
        const j = await readJson(res);
        throw new Error(j?.error || `Failed to load comments (${res.status})`);
      }
      const j = await res.json();
      const rows = Array.isArray(j?.items) ? (j.items as CommentRow[]) : [];
      setItems(rows);
    } catch (e: any) {
      setError(e?.message || "Failed to load comments");
    } finally {
      setLoading(false);
    }
  }, [chainId, normalizedCampaign]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!pollIntervalMs || pollIntervalMs < 3000) return;
    const timer = window.setInterval(() => {
      void load();
    }, pollIntervalMs);
    return () => window.clearInterval(timer);
  }, [load, pollIntervalMs]);

  const canPost = useMemo(() => body.trim().length > 0 && body.trim().length <= 500, [body]);

  const filteredItems = useMemo(() => {
    let next = [...items];
    if (normalizedAuthorFilter) {
      next = next.filter((item) => canonAddress(item.authorAddress, solana) === normalizedAuthorFilter);
    }
    next.sort((a, b) => {
      const at = new Date(a.createdAt).getTime();
      const bt = new Date(b.createdAt).getTime();
      return mode === "chat" ? bt - at : at - bt;
    });
    return next;
  }, [items, mode, normalizedAuthorFilter, solana]);

  const effectiveEmptyState = useMemo(() => {
    if (emptyStateText) return emptyStateText;
    if (mode === "chat") return "No messages yet.";
    if (mode === "updates") return "No creator updates yet.";
    return "No comments yet.";
  }, [emptyStateText, mode]);

  const handlePost = useCallback(async () => {
    try {
      if (!isCampaignAddress(normalizedCampaign)) return;
      if (!canPost) return;

      if (!account) {
        window.dispatchEvent(new CustomEvent("memewarzone:openWalletModal"));
        return;
      }
      const author = canonAddress(account, solana);
      if (!author) {
        toast("Connect the matching wallet to comment.");
        return;
      }

      // One wallet signature per 30 days (founder, 2026-10-03): when the feed session's wallet is the
      // author, the comment goes through on that session with no signature of its own.
      if (canonAddress(feedSession.account, solana) === author) {
        await feedSession.withSession(async (token) => {
          setPosting(true);
          const res = await apiFetch("/api/comments", {
            method: "POST",
            headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({
              chainId,
              campaignAddress: normalizedCampaign,
              tokenAddress: normalizedToken,
              body: body.trim(),
            }),
          });
          if (!res.ok) {
            const j = await readJson(res);
            throw Object.assign(new Error(j?.error || `Failed to post comment (${res.status})`), { code: j?.code });
          }
        });
        setBody("");
        await load();
        toast(mode === "chat" ? "Message sent." : "Comment posted.");
        return;
      }

      if (!solana && !wallet.signer) {
        toast("Connect your wallet to comment.");
        return;
      }
      const nonce = await getNonce(chainId, author);
      const msg = buildCommentMessage({
        chainId,
        address: author,
        campaignAddress: normalizedCampaign,
        nonce,
        body,
      });
      const signature = solana
        ? (await signSolanaMessage(msg, author)).signature
        : await wallet.signer!.signMessage(msg);

      setPosting(true);

      const res = await apiFetch("/api/comments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chainId,
          campaignAddress: normalizedCampaign,
          tokenAddress: normalizedToken,
          address: author,
          body: body.trim(),
          nonce,
          signature,
        }),
      });

      if (!res.ok) {
        const j = await readJson(res);
        throw new Error(j?.error || `Failed to post comment (${res.status})`);
      }

      setBody("");
      await load();
      toast(mode === "chat" ? "Message sent." : "Comment posted.");
    } catch (e: any) {
      toast(e?.message || "Failed to post comment");
    } finally {
      setPosting(false);
    }
  }, [account, body, canPost, chainId, feedSession, load, mode, normalizedCampaign, normalizedToken, solana, wallet.signer]);

  const showComposer = !hideComposer && mode !== "updates";

  return (
    <div className="h-full w-full flex flex-col min-h-0 gap-3">
      {showComposer ? (
        <div className={`rounded-[14px] border border-mw-border bg-mw-input font-mw-body text-mw-text ${mode === "chat" ? "p-2.5" : "p-3"}`}>
          <div className="flex items-start gap-3">
            <Avatar className="mw-avatar h-9 w-9">
              <AvatarImage src={undefined} />
              <AvatarFallback className="bg-transparent p-0"><OperativeMark fill /></AvatarFallback>
            </Avatar>

            <div className="flex-1">
              <Textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder={
                  account
                    ? mode === "chat"
                      ? "Jump into the war room…"
                      : "Write a comment…"
                    : mode === "chat"
                    ? "Connect wallet to join chat…"
                    : "Connect wallet to comment…"
                }
                className={`${mode === "chat" ? "min-h-[72px]" : "min-h-[96px]"} resize-none rounded-[10px] border-mw-edge bg-mw-surface text-[15px] text-mw-text placeholder:text-[#5C6670] focus-visible:ring-mw-accent`}
                maxLength={500}
                disabled={posting}
              />
              <div className="mt-2 flex items-center justify-between">
                <span className="font-mw-mono text-xs text-mw-muted">
                  {mode === "chat" ? "Fast lane · newest first" : `${body.trim().length}/500`}
                </span>
                <div className="flex items-center gap-2">
                  {!account ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      className="mw-focus inline-flex min-h-10 items-center justify-center rounded-[10px] border border-mw-edge bg-mw-raised px-4 text-sm font-semibold text-mw-text hover:bg-[#222830]"
                      onClick={() => window.dispatchEvent(new CustomEvent("memewarzone:openWalletModal"))}
                      disabled={posting}
                    >
                      Connect wallet
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    className="mw-focus inline-flex min-h-10 items-center justify-center rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-sm font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50"
                    onClick={handlePost}
                    disabled={posting || !account || !canPost}
                  >
                    {posting ? (mode === "chat" ? "Sending…" : "Posting…") : mode === "chat" ? "Send" : "Post"}
                  </Button>
                </div>
              </div>
              {error ? (
                <p className="mt-2 text-sm text-mw-sell">{error}</p>
              ) : null}
            </div>
          </div>
        </div>
      ) : mode === "updates" ? (
        <div className="rounded-[10px] border border-mw-border bg-mw-input px-3 py-2.5 text-[13px] text-mw-muted">
          Creator-only feed. Newest official notes appear here.
        </div>
      ) : null}

      <div className="flex-1 min-h-0 overflow-auto pr-1">
        {loading ? (
          <div className="py-6 text-center text-sm text-mw-muted">
            {mode === "chat" ? "Loading war room…" : "Loading comments…"}
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="py-6 text-center text-sm text-mw-muted">{effectiveEmptyState}</div>
        ) : (
          <div className={`flex flex-col ${mode === "chat" ? "gap-2" : "gap-3"}`}>
            {filteredItems.filter((c) => !moderation.isHidden("comment", c.id) && !moderation.isBlocked(c.authorAddress)).map((c) => {
              const label = (c.authorDisplayName ?? "").trim();
              const display = label.length ? label : shorten(c.authorAddress);
              const isCreatorUpdate =
                normalizedAuthorFilter && c.authorAddress?.toLowerCase() === normalizedAuthorFilter;

              return (
                <div
                  key={c.id}
                  className={
                    mode === "chat"
                      ? "flex items-start gap-3 rounded-[14px] border border-mw-border bg-mw-input p-2.5 font-mw-body text-mw-text"
                      : isCreatorUpdate
                      ? "flex items-start gap-3 rounded-[14px] border border-[#5A3416] bg-mw-accent-fill p-3.5 font-mw-body text-mw-text"
                      : "flex items-start gap-3 rounded-[14px] border border-mw-border bg-mw-input p-3.5 font-mw-body text-mw-text"
                  }
                >
                  <Avatar className={mode === "chat" ? "mw-avatar h-8 w-8" : "mw-avatar h-9 w-9"}>
                    {c.authorAvatarUrl ? <AvatarImage src={c.authorAvatarUrl} /> : null}
                    <AvatarFallback className="bg-transparent p-0"><OperativeMark fill /></AvatarFallback>
                  </Avatar>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <WalletLabel className="truncate text-sm font-bold text-mw-text" wallet={c.authorAddress} displayName={c.authorDisplayName} />
                        {isCreatorUpdate ? (
                          <span className="ml-2 inline-flex h-5 items-center rounded-full border border-[#7A3A0C] bg-[#2A1609] px-2 text-[11px] font-semibold text-mw-accent-soft">
                            Creator
                          </span>
                        ) : null}
                        <span className="ml-2 text-[13px] text-mw-muted">
                          {timeAgo(c.createdAt)}
                        </span>
                      </div>
                      <ItemMenu
                        className="-mr-1 -mt-1"
                        report={{ entityType: "post", subject: "Reported comment", reportedWallet: c.authorAddress, reportedUrl: currentPageUrl(`/token/${normalizedCampaign}`) }}
                        hide={{ type: "comment", id: c.id }}
                        author={c.authorAddress}
                        authorLabel={(c.authorDisplayName ?? "").trim() || null}
                      />
                    </div>
                    <p className={`m-0 mt-1 whitespace-pre-wrap break-words ${mode === "chat" ? "text-[14px]" : "text-[15px]"} text-mw-text`}>
                      {c.body}
                    </p>
                    {account && c.authorAddress && canonAddress(c.authorAddress, solana) === account ? null : (
                      <div className="mt-2">
                        <AbuseReportShortcut
                          prefill={{
                            entityType: "campaign",
                            reportedWallet: c.authorAddress,
                            reportedCampaignAddress: normalizedCampaign,
                            reportedTokenAddress: normalizedToken || "",
                            reportedUrl: currentPageUrl(`/token/${normalizedCampaign}`),
                          }}
                        />
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
