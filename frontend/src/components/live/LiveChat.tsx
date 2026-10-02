// frontend/src/components/live/LiveChat.tsx
import { WalletLabel } from "@/components/ui-v2/WalletLabel";
import { useEffect, useRef } from "react";
import { Shield } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  isModerator,
  parseModeratorEnv,
  shortWallet,
  type LiveChatMessage,
} from "@/lib/liveChat";

const MODERATORS = parseModeratorEnv(import.meta.env.VITE_LIVE_CHAT_MODERATORS as string | undefined);

type Props = {
  messages: LiveChatMessage[];
  mutedWallets: Map<string, number | null>;
};

export const LiveChat = ({ messages, mutedWallets }: Props) => {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // autoscroll to bottom on new message, unless user has scrolled up
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <div
      ref={scrollRef}
      className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto pr-1 font-mono text-sm"
    >
      {messages.length === 0 && (
        <div className="text-xs uppercase tracking-widest text-muted-foreground">
          Comms channel open. Be the first to transmit.
        </div>
      )}
      {messages
        .filter((m) => {
          const until = mutedWallets.get(m.wallet.toLowerCase());
          if (until === undefined) return true;
          if (until === null) return false;       // perma — hide
          return until <= Date.now();              // temp expired? show again
        })
        .map((m) => {
        const isMod = isModerator(m.wallet, MODERATORS);
        const name = m.handle ?? null;
        return (
          <div key={m.id} className="leading-snug">
            {isMod && (
              <>
                <Shield
                  className="mr-1 inline-block h-3.5 w-3.5 align-text-bottom text-amber-400"
                  aria-hidden
                />
                <span className="sr-only">Moderator. </span>
                <span className="mr-1 font-semibold uppercase tracking-wider text-amber-400">
                  [MOD]
                </span>
              </>
            )}
            {!isMod && m.squadCallsign && (
              <span className="mr-1 font-semibold uppercase tracking-wider text-cyan-400">
                [{m.squadCallsign}]
              </span>
            )}
            <span className={cn("font-semibold", isMod ? "text-amber-400" : "text-foreground/90")}>
              <WalletLabel wallet={m.wallet} displayName={name} />
            </span>
            <span className="text-muted-foreground">: </span>
            <span className="text-foreground/95">{m.text}</span>
          </div>
        );
      })}
    </div>
  );
};
