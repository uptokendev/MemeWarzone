// frontend/src/pages/Live.tsx
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { ConnectWalletButton } from "@/components/ConnectWalletButton";
import { useWallet } from "@/contexts/WalletContext";
import { fetchWalletAttributionState } from "@/lib/recruiterApi";
import { fetchUserProfile } from "@/lib/profileApi";
import { useLaunchpad } from "@/lib/launchpadClient";
import { LivestreamPlayer } from "@/components/live/LivestreamPlayer";
import { LiveChat } from "@/components/live/LiveChat";
import { LiveChatInput } from "@/components/live/LiveChatInput";
import { ViewerCount } from "@/components/live/ViewerCount";
import { useLiveChannel } from "@/hooks/useLiveChannel";
import type { LiveChatMessage } from "@/lib/liveChat";
import NotFound from "./NotFound";

const PLAYBACK_ID = String(import.meta.env.VITE_MUX_PLAYBACK_ID || "").trim();
const CHAT_CHANNEL = String(import.meta.env.VITE_LIVE_CHAT_CHANNEL || "live:launch-party").trim();
const PAGE_ENABLED = String(import.meta.env.VITE_LIVE_PAGE_ENABLED || "true").trim() === "true";
// Visual chat preview is strictly development-only, even if a production env flag is set by mistake.
const PREVIEW_MODE = import.meta.env.DEV && String(import.meta.env.VITE_LIVE_CHAT_PREVIEW || "").trim() === "1";

const PREVIEW_MESSAGES: LiveChatMessage[] = [
  {
    id: "preview-1",
    wallet: "0x1234567890abcdef1234567890abcdef12345678",
    handle: null,
    squadCallsign: null,
    text: "gm",
    ts: Date.now() - 60_000,
  },
  {
    id: "preview-2",
    wallet: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    handle: "degen",
    squadCallsign: null,
    text: "anon checking in",
    ts: Date.now() - 45_000,
  },
  {
    id: "preview-3",
    wallet: "0xc0ffee00c0ffee00c0ffee00c0ffee00c0ffee00",
    handle: "squadmate",
    squadCallsign: "BASED-007",
    text: "lfg launch party 🚀",
    ts: Date.now() - 30_000,
  },
  {
    id: "preview-4",
    wallet: "0x587F58AC69bE91b575DE459A6f69958b8a4d1c77",
    handle: "sven",
    squadCallsign: "MWZ-001",
    text: "keep it civil, soldiers",
    ts: Date.now() - 15_000,
  },
];

const Live = () => {
  const wallet = useWallet();
  const account = wallet.account || "";
  const { activeChainId } = useLaunchpad();
  const ready = PAGE_ENABLED && wallet.isConnected && account.length > 0;

  const { data: attribution } = useQuery({
    queryKey: ["wallet-attribution", account.toLowerCase()],
    queryFn: () => fetchWalletAttributionState(account),
    staleTime: Infinity,
    enabled: ready,
  });
  const { data: profile } = useQuery({
    queryKey: ["user-profile-live", activeChainId, account.toLowerCase()],
    queryFn: () => fetchUserProfile(activeChainId, account),
    staleTime: Infinity,
    enabled: ready,
  });
  const squadCallsign = attribution?.recruiterCode ?? null;
  const handle = profile?.displayName ?? attribution?.recruiterDisplayName ?? null;

  const { messages, publish, presenceCount, connected, mutedWallets, getMuteExpiry } = useLiveChannel({
    channelName: CHAT_CHANNEL,
    clientId: account,
    enabled: ready,
  });

  const ownMutedUntil = getMuteExpiry(account);

  if (!PAGE_ENABLED) return <NotFound />;

  if (!wallet.isConnected || !account) {
    return (
      <div className="mx-auto w-full max-w-3xl py-10">
        <Card className="flex flex-col items-center gap-4 border-border/60 bg-card/65 p-6 text-center md:flex-row md:justify-between md:text-left">
          <div>
            <div className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
              Restricted Channel
            </div>
            <div className="mt-1 font-retro text-2xl md:text-4xl">
              Connect to watch the launch party
            </div>
            <div className="mt-2 text-sm text-muted-foreground">
              The stream is gated to wallet-connected soldiers.
            </div>
          </div>
          <ConnectWalletButton />
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1480px] px-1 py-4 md:px-2">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[1fr_360px]">
        <div className="flex flex-col gap-3">
          <LivestreamPlayer playbackId={PLAYBACK_ID} />
          <div className="flex items-center justify-between">
            <ViewerCount count={presenceCount} />
          </div>
        </div>
        <Card className="flex h-[480px] flex-col gap-3 border-border/60 bg-card/65 p-3 md:h-[640px]">
          <div className="flex items-center justify-between">
            <div className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
              Comms Channel
            </div>
            {PREVIEW_MODE && (
              <div className="font-mono text-[10px] uppercase tracking-widest text-amber-400">
                preview
              </div>
            )}
          </div>
          <div className="min-h-0 flex-1">
            <LiveChat
              messages={PREVIEW_MODE ? PREVIEW_MESSAGES : messages}
              mutedWallets={mutedWallets}
            />
          </div>
          <LiveChatInput
            wallet={account}
            handle={handle}
            squadCallsign={squadCallsign}
            disabled={!connected}
            mutedUntil={ownMutedUntil}
            onSend={publish}
          />
        </Card>
      </div>
    </div>
  );
};

export default Live;
