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
    <div className="flex h-[440px] min-h-0 w-full flex-col font-mw-body text-mw-text">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="sr-only">War Room</p>
          <p className="sr-only">Live chat for this coin</p>
        </div>
        <div className="text-right font-mw-mono text-xs text-mw-muted">
          <div>{hasSession ? "Signed in" : "Read only"}</div>
          <div>{activeWalletLabel}</div>
        </div>
      </div>

      <div ref={listRef} onScroll={onScroll} className="relative flex-1 min-h-0 overflow-y-auto pr-1 space-y-2">
        {loading ? (
          <div className="py-6 text-center text-sm text-mw-muted">Loading War Room…</div>
        ) : messages.length === 0 ? (
          <div className="py-6 text-center text-sm text-mw-muted">No messages yet.</div>
        ) : (
          messages.map((m) => {
            const display = (m.displayName || "").trim() || shortAddress(m.walletAddress);
            const isMine = walletAddress && m.walletAddress.toLowerCase() === walletAddress.toLowerCase();
            return (
              <div key={`${m.id}:${m.clientNonce || ""}`} className={`flex items-start gap-2.5 rounded-xl border p-2.5 ${isMine ? "border-[#5A3416] bg-mw-accent-fill" : "border-mw-border bg-mw-input"}`}>
                <Avatar className="mw-avatar h-8 w-8">
                  {m.avatarUrl ? <AvatarImage src={m.avatarUrl} /> : null}
                  <AvatarFallback className="bg-transparent p-0"><OperativeMark fill /></AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px]">
                    <WalletLabel className="truncate font-bold text-mw-text" wallet={m.walletAddress} displayName={m.displayName} />
                    {m.role === "creator" ? <span className="inline-flex h-5 items-center rounded-full border border-[#7A3A0C] bg-[#2A1609] px-2 text-[11px] font-semibold text-mw-accent-soft">Creator</span> : null}
                    {isMine ? <span className="inline-flex h-5 items-center rounded-full border border-[#1F5133] bg-[#0F2418] px-2 text-[11px] font-semibold text-[#6EE7A0]">You</span> : null}
                    <span className="text-mw-muted">{timeAgo(m.createdAt)}</span>
                    {m.pending ? <span className="text-mw-muted">sending…</span> : null}
                    {m.failed ? <span className="text-mw-sell">failed</span> : null}
                  </div>
                  <p className="m-0 mt-0.5 whitespace-pre-wrap break-words text-[14px] text-mw-text">{m.message}</p>
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
            className="mw-focus absolute bottom-2 right-2 rounded-full border border-mw-edge bg-mw-raised px-3 py-1 text-xs font-semibold text-mw-text shadow"
          >
            Jump to latest
          </button>
        ) : null}
      </div>

      <div className="mt-3 rounded-xl border border-mw-border bg-mw-input p-3">
        {!isConnected ? (
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="m-0 text-sm font-semibold text-mw-text">Connect your wallet to chat.</p>
              <p className="m-0 text-[13px] text-mw-muted">Reading works without a wallet. Posting needs one signature per session.</p>
            </div>
            <Button size="sm" variant="secondary" className="mw-focus inline-flex min-h-10 items-center justify-center rounded-[10px] border border-mw-edge bg-mw-raised px-4 text-sm font-semibold text-mw-text hover:bg-[#222830]" onClick={() => window.dispatchEvent(new CustomEvent("memewarzone:openWalletModal"))}>Connect wallet</Button>
          </div>
        ) : !hasSession ? (
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="m-0 text-sm font-semibold text-mw-text">Sign once to join this War Room.</p>
              <p className="m-0 text-[13px] text-mw-muted">One signature per session. Messages need no extra signatures.</p>
            </div>
            <Button size="sm" className="mw-focus inline-flex min-h-10 items-center justify-center rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-sm font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50" onClick={handleJoin} disabled={joining}>{joining ? "Signing…" : "Sign to join"}</Button>
          </div>
        ) : (
          <>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={400}
              className="min-h-[78px] resize-none rounded-[10px] border-mw-edge bg-mw-surface text-[15px] text-mw-text placeholder:text-[#5C6670]"
              placeholder="Send a message to the War Room…"
              disabled={posting}
            />
            <div className="mt-2 flex items-center justify-between gap-3">
              <span className="font-mw-mono text-xs text-mw-muted">{body.trim().length}/400</span>
              <Button size="sm" className="mw-focus inline-flex min-h-10 items-center justify-center rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-sm font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50" onClick={handleSend} disabled={posting || !body.trim()}>{posting ? "Sending…" : "Send"}</Button>
            </div>
          </>
        )}
        {error ? <p className="mt-2 text-sm text-mw-sell">{error}</p> : null}
      </div>
    </div>
  );
}
