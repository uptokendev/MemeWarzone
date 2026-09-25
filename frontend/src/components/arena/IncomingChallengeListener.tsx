import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ChallengeResponsePopup } from "@/components/arena/ChallengeResponsePopup";
import { BuyInPopup } from "@/components/arena/BuyInPopup";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { useWallet } from "@/contexts/WalletContext";
import { fetchArenaChallengeInbox } from "@/features/postgrad/apiClient";
import { postGradFlags } from "@/features/postgrad/config";
import { useAblyCreatorChannel } from "@/hooks/useAblyCreatorChannel";
import {
  CHALLENGE_POPUP_EVENTS,
  challengePopupKey,
  isActionableChallengeEvent,
  isChallengeSeen,
  isInformationalChallengeEvent,
  markChallengeSeen,
  pruneChallengePopups,
  routeChallengeEvent,
  shiftChallengePopup,
  upsertChallengePopup,
} from "@/lib/arena/challengePopupPresentation.mjs";
import { isEvmAddress, isSolanaAddress } from "@/lib/address";
import { getAllowedChainIds, isEvmChainId, isSolanaChainId, SOLANA_CHAIN_ID } from "@/lib/chainConfig";
import type { Battle } from "@/features/postgrad/contracts";

/**
 * Challenge popups for the connected owner, delivered two ways:
 *  - realtime: the API publishes every challenge / counter / accept / decline to
 *    arena:creator:{chain}:{wallet} (instant, but lost if the owner was away or the socket was down);
 *  - the inbox: GET /api/arena/battles/inbox re-derives the same popups from the battle rows, read on
 *    page load, on return to the tab, when the network comes back, and every POLL_MS while visible.
 * Either path alone shows the popup; both together cannot show it twice (one entry per battle).
 * An unanswered challenge comes back on every page load until it is answered or expires; an outcome
 * (accepted / declined) is shown once per browser.
 */
const POLL_MS = 20_000;

/** The fields the API sends on every battle that the shared Battle contract does not declare. */
type ChallengeBattle = Battle & { id: string; chainId?: number; nativeSymbol?: string; offerCount?: number };

type Delivery = {
  event: string;
  battle: ChallengeBattle;
  offerCount: number;
  message?: unknown;
  escrowRequired?: boolean;
  nativeSymbol?: unknown;
};

function asBattle(value: unknown): ChallengeBattle | null {
  const battle = value as ChallengeBattle | null;
  if (!battle?.id || !battle?.state || !Array.isArray(battle.participants)) return null;
  return battle;
}

function localStore(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function CreatorChannelBridge({
  chainId,
  wallet,
  onEvent,
}: {
  chainId: number;
  wallet: string;
  onEvent: (event: string, payload: Record<string, unknown>) => void;
}) {
  const { channel } = useAblyCreatorChannel({ enabled: true, chainId, wallet });
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!channel) return;
    const handler = (message: { name?: string; data?: Record<string, unknown> }) => {
      const name = String(message?.name || message?.data?.type || "");
      if (!Object.values(CHALLENGE_POPUP_EVENTS).includes(name as (typeof CHALLENGE_POPUP_EVENTS)[keyof typeof CHALLENGE_POPUP_EVENTS])) return;
      onEventRef.current(name, (message?.data && typeof message.data === "object" ? message.data : {}) as Record<string, unknown>);
    };
    channel.subscribe(handler);
    return () => {
      try {
        channel.unsubscribe(handler);
      } catch {
        // ignore
      }
    };
  }, [channel]);

  return null;
}

export function IncomingChallengeListener() {
  const evm = useWallet();
  const { solanaAccount, isSolanaConnected } = useSolanaWallet();
  const evmWallet = evm.isConnected && isEvmAddress(evm.account) ? String(evm.account) : "";
  const solanaWallet = isSolanaConnected && isSolanaAddress(solanaAccount) ? String(solanaAccount) : "";
  const [queue, setQueue] = useState<Array<Record<string, unknown>>>([]);
  const [buyInBattle, setBuyInBattle] = useState<ChallengeBattle | null>(null);

  // Popups closed in this page's lifetime (battleId:event:offerCount) and buy-ins closed, so the
  // poll does not reopen them every POLL_MS. Memory only: a reload shows an open challenge again.
  const closedRef = useRef(new Set<string>());
  const buyInClosedRef = useRef(new Set<string>());
  const currentIdRef = useRef("");
  const pollingRef = useRef(false);
  const pollAgainRef = useRef(false);

  const targets = useMemo(() => {
    const next: Array<{ chainId: number; wallet: string }> = [];
    const allowed = getAllowedChainIds();
    if (evmWallet) {
      for (const chainId of allowed) {
        if (isEvmChainId(chainId)) next.push({ chainId, wallet: evmWallet });
      }
    }
    if (solanaWallet && allowed.includes(SOLANA_CHAIN_ID)) next.push({ chainId: SOLANA_CHAIN_ID, wallet: solanaWallet });
    return next;
  }, [evmWallet, solanaWallet]);

  const deliver = useCallback((item: Delivery) => {
    const { event, battle } = item;
    const route = routeChallengeEvent(event, battle, { escrowRequired: item.escrowRequired === true });
    if (route === "ignore") return;
    if (route === "buy_in") {
      if (buyInClosedRef.current.has(battle.id)) return;
      setBuyInBattle((current) => (current && current.id !== battle.id ? current : battle));
      return;
    }
    const offerCount = Number(item.offerCount || 0) || 0;
    if (closedRef.current.has(challengePopupKey(battle.id, event, offerCount))) return;
    if (isInformationalChallengeEvent(event) && isChallengeSeen(localStore(), battle.id, event, offerCount)) return;
    setQueue((current) =>
      upsertChallengePopup(current, {
        event,
        battle,
        battleId: battle.id,
        offerCount,
        message: item.message ?? null,
        escrowRequired: item.escrowRequired === true,
        nativeSymbol: item.nativeSymbol || battle.nativeSymbol,
      }),
    );
  }, []);

  const onRealtimeEvent = useCallback((event: string, payload: Record<string, unknown>) => {
    const battle = asBattle(payload.battle);
    if (!battle) return;
    deliver({
      event,
      battle,
      offerCount: Number(battle.offerCount || 0),
      message: payload.message ?? null,
      escrowRequired: payload.escrowRequired === true,
      nativeSymbol: payload.nativeSymbol || battle.nativeSymbol,
    });
  }, [deliver]);

  const poll = useCallback(async () => {
    if (!postGradFlags.arena || !targets.length) return;
    if (pollingRef.current) {
      pollAgainRef.current = true;
      return;
    }
    pollingRef.current = true;
    try {
      do {
        pollAgainRef.current = false;
        for (const target of targets) {
          const startedAt = Date.now();
          const json = await fetchArenaChallengeInbox(target.wallet, target.chainId).catch(() => null);
          // Only a successful read may prune: a failed one says nothing about what is pending.
          if (!json || json.ok === false || !Array.isArray(json.items)) continue;
          const pending = new Set<string>();
          for (const item of json.items) {
            const battle = asBattle(item?.battle);
            if (!battle) continue;
            if (isActionableChallengeEvent(item.event)) pending.add(battle.id);
            deliver({
              event: String(item.event || ""),
              battle,
              offerCount: Number(item.offerCount || 0),
              message: item.message ?? null,
              escrowRequired: item.escrowRequired === true,
              nativeSymbol: item.nativeSymbol || battle.nativeSymbol,
            });
          }
          setQueue((current) =>
            pruneChallengePopups(current, {
              chainId: target.chainId,
              pendingBattleIds: pending,
              keepBattleId: currentIdRef.current,
              startedAt,
            }),
          );
        }
      } while (pollAgainRef.current);
    } finally {
      pollingRef.current = false;
    }
  }, [deliver, targets]);

  useEffect(() => {
    if (!postGradFlags.arena) return;
    void poll();
    const onFocus = () => void poll();
    const onVisible = () => {
      if (document.visibilityState === "visible") void poll();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void poll();
    }, POLL_MS);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [poll]);

  const current = queue[0] || null;
  const currentBattle = asBattle(current?.battle);
  currentIdRef.current = currentBattle?.id || "";

  function dismissCurrent() {
    if (current && currentBattle) {
      const event = String(current.event || "");
      const offerCount = Number(current.offerCount || 0);
      closedRef.current.add(challengePopupKey(currentBattle.id, event, offerCount));
      if (isInformationalChallengeEvent(event)) markChallengeSeen(localStore(), currentBattle.id, event, offerCount);
      // An accept inside the popup already showed this battle's buy-in; do not open it twice.
      buyInClosedRef.current.add(currentBattle.id);
      setBuyInBattle((open) => (open?.id === currentBattle.id ? null : open));
    }
    setQueue((q) => shiftChallengePopup(q).queue);
  }

  if (!postGradFlags.arena) return null;

  return (
    <>
      {targets.map((target) => (
        <CreatorChannelBridge
          key={`${target.chainId}:${target.wallet}`}
          chainId={target.chainId}
          wallet={target.wallet}
          onEvent={onRealtimeEvent}
        />
      ))}
      <ChallengeResponsePopup
        open={Boolean(currentBattle)}
        eventName={String(current?.event || CHALLENGE_POPUP_EVENTS.received)}
        battle={currentBattle}
        message={typeof current?.message === "string" ? current.message : null}
        escrowRequired={current?.escrowRequired === true}
        walletAddress={isSolanaChainId(currentBattle?.chainId) ? solanaWallet : evmWallet || solanaWallet}
        chainId={currentBattle?.chainId}
        onClose={dismissCurrent}
        onChanged={() => void poll()}
      />
      <BuyInPopup
        open={Boolean(buyInBattle) && !currentBattle}
        battle={buyInBattle}
        walletAddress={isSolanaChainId(buyInBattle?.chainId) ? solanaWallet : evmWallet || solanaWallet}
        onOpenChange={(next) => {
          if (!next && buyInBattle) {
            buyInClosedRef.current.add(buyInBattle.id);
            setBuyInBattle(null);
          }
        }}
      />
    </>
  );
}
