import { useEffect, useMemo, useRef, useState } from "react";
import { WalletLabel } from "@/components/ui-v2/WalletLabel";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { OperativeMark } from "@/components/ui-v2/OperativeMark";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { AbuseReportShortcut, currentPageUrl } from "@/components/abuse/AbuseReportShortcut";
import { useWarRoom } from "@/hooks/useWarRoom";
import { toast } from "sonner";

function initials(nameOrAddress?: string | null) {
  const s = String(nameOrAddress ?? "").trim();
  if (!s) return "?";
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return s.slice(0, 2).toUpperCase();
}

function shortAddress(addr?: string | null) {
  const s = String(addr ?? "");
  return s.length > 10 ? `${s.slice(0, 6)}...${s.slice(-4)}` : s;
}

function timeAgo(iso: string) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = Math.max(0, Date.now() - t);
  const s = Math.floor(diff / 1000);
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

export function TokenWarRoom({ chainId, campaignAddress, creatorAddress }: { chainId: number; campaignAddress: string; creatorAddress?: string | null; }) {
  const { messages, loading, joining, posting, error, hasSession, isConnected, walletAddress, joinRoom, postMessage } = useWarRoom({ chainId, campaignAddress, creatorAddress });
  const [body, setBody] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);
  const nearBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (nearBottom.current) {
      el.scrollTop = el.scrollHeight;
      setShowJump(false);
    } else {
      setShowJump(true);
    }
  }, [messages.length]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const isNear = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    nearBottom.current = isNear;
    if (isNear) setShowJump(false);
  };

  const activeWalletLabel = useMemo(() => (walletAddress ? shortAddress(walletAddress) : "Disconnected"), [walletAddress]);

  const handleJoin = async () => {
    try {
      await joinRoom();
      toast.success("War Room session ready.");
    } catch (e: any) {
      toast.error(e?.message || "Failed to join War Room");
    }
  };

  const handleSend = async () => {
    try {
      await postMessage(body);
      setBody("");
    } catch (e: any) {
      toast.error(e?.message || "Failed to send message");
    }
  };

  return (
    <div className="h-[440px] w-full rounded-xl border border-border/40 bg-card/15 p-3 flex flex-col min-h-0">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-foreground">War Room</p>
          <p className="text-[11px] text-muted-foreground">Campaign chat · polling fallback is active when realtime is unavailable</p>
        </div>
        <div className="text-right text-[11px] text-muted-foreground">
          <div>{hasSession ? "Signed in" : "Read only"}</div>
          <div>{activeWalletLabel}</div>
        </div>
      </div>

      <div ref={listRef} onScroll={onScroll} className="relative flex-1 min-h-0 overflow-y-auto pr-1 space-y-2">
        {loading ? (
          <div className="py-6 text-center text-xs text-muted-foreground">Loading War Room…</div>
        ) : messages.length === 0 ? (
          <div className="py-6 text-center text-xs text-muted-foreground">No war room messages yet. Be the first to break the silence.</div>
        ) : (
          messages.map((m) => {
            const display = (m.displayName || "").trim() || shortAddress(m.walletAddress);
            const isMine = walletAddress && m.walletAddress.toLowerCase() === walletAddress.toLowerCase();
            return (
              <div key={`${m.id}:${m.clientNonce || ""}`} className={`flex items-start gap-3 rounded-xl border p-2.5 ${isMine ? "border-accent/35 bg-accent/5" : "border-border/35 bg-card/20"}`}>
                <Avatar className="h-8 w-8">
                  {m.avatarUrl ? <AvatarImage src={m.avatarUrl} /> : null}
                  <AvatarFallback className="bg-transparent p-0"><OperativeMark fill /></AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-[11px]">
                    <WalletLabel className="font-semibold text-foreground truncate" wallet={m.walletAddress} displayName={m.displayName} />
                    {m.role === "creator" ? <span className="rounded-full border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent">Creator</span> : null}
                    {isMine ? <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-400">You</span> : null}
                    <span className="text-muted-foreground">{timeAgo(m.createdAt)}</span>
                    {m.pending ? <span className="text-muted-foreground">sending…</span> : null}
                    {m.failed ? <span className="text-destructive">failed</span> : null}
                  </div>
                  <p className="mt-1 whitespace-pre-wrap break-words text-[12px] text-foreground/90">{m.message}</p>
                  {isMine ? null : (
                    <div className="mt-2">
                      <AbuseReportShortcut
                        prefill={{
                          entityType: "campaign",
                          reportedWallet: m.walletAddress,
                          reportedCampaignAddress: campaignAddress,
                          reportedUrl: currentPageUrl(`/token/${campaignAddress}`),
                        }}
                      />
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}

        {showJump ? (
          <button
            onClick={() => {
              const el = listRef.current;
              if (!el) return;
              el.scrollTop = el.scrollHeight;
              nearBottom.current = true;
              setShowJump(false);
            }}
            className="absolute bottom-2 right-2 rounded-full border border-accent/30 bg-background/90 px-3 py-1 text-[11px] text-foreground shadow"
          >
            Jump to latest
          </button>
        ) : null}
      </div>

      <div className="mt-3 rounded-xl border border-border/35 bg-card/20 p-3">
        {!isConnected ? (
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs text-foreground">Connect your wallet to join the War Room.</p>
              <p className="text-[11px] text-muted-foreground">Reading works without a wallet. Posting requires a one-time signature per room session.</p>
            </div>
            <Button size="sm" variant="secondary" onClick={() => window.dispatchEvent(new CustomEvent("memewarzone:openWalletModal"))}>Connect wallet</Button>
          </div>
        ) : !hasSession ? (
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs text-foreground">Sign once to join this War Room.</p>
              <p className="text-[11px] text-muted-foreground">You only sign the room session. Messages themselves do not require new signatures.</p>
            </div>
            <Button size="sm" onClick={handleJoin} disabled={joining}>{joining ? "Signing…" : "Sign to join"}</Button>
          </div>
        ) : (
          <>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={400}
              className="min-h-[78px] resize-none"
              placeholder="Send a message to the War Room…"
              disabled={posting}
            />
            <div className="mt-2 flex items-center justify-between gap-3">
              <span className="text-[11px] text-muted-foreground">{body.trim().length}/400</span>
              <Button size="sm" onClick={handleSend} disabled={posting || !body.trim()}>{posting ? "Sending…" : "Send"}</Button>
            </div>
          </>
        )}
        {error ? <p className="mt-2 text-[11px] text-destructive">{error}</p> : null}
      </div>
    </div>
  );
}
