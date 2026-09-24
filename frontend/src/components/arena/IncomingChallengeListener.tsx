import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ChallengeResponsePopup } from "@/components/arena/ChallengeResponsePopup";
import { BuyInPopup } from "@/components/arena/BuyInPopup";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { useWallet } from "@/contexts/WalletContext";
import { fetchPostGradBattleDetails, fetchPostGradCreatorBattleStatuses } from "@/features/postgrad/apiClient";
import { postGradFlags } from "@/features/postgrad/config";
import { useAblyCreatorChannel } from "@/hooks/useAblyCreatorChannel";
import type { CreatorBattleStatus } from "@/hooks/useArenaBattleFeed";
import { creatorOwnedIdentityKeys } from "@/lib/arena/creatorChallengePresentation.mjs";
import {
  CHALLENGE_POPUP_EVENTS,
  dismissChallenge,
  enqueueChallengePopup,
  isChallengeDismissed,
  isResponderTurn,
  shiftChallengePopup,
} from "@/lib/arena/challengePopupPresentation.mjs";
import { isEvmAddress, isSolanaAddress } from "@/lib/address";
import { getAllowedChainIds, isEvmChainId, isSolanaChainId, SOLANA_CHAIN_ID } from "@/lib/chainConfig";
import type { Battle } from "@/features/postgrad/contracts";

function asBattle(value: unknown): Battle | null {
  const battle = value as Battle | null;
  if (!battle?.id || !battle?.state || !Array.isArray(battle.participants)) return null;
  return battle;
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
  const [buyInBattle, setBuyInBattle] = useState<Battle | null>(null);

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

  const pushEvent = useCallback((event: string, payload: Record<string, unknown>) => {
    const battle = asBattle(payload.battle);
    if (!battle) return;
    const offerCount = Number((battle as { offerCount?: number }).offerCount || 0);
    if (typeof sessionStorage !== "undefined" && isChallengeDismissed(sessionStorage, battle.id, offerCount)) return;
    setQueue((current) =>
      enqueueChallengePopup(current, {
        event,
        battle,
        battleId: battle.id,
        offerCount,
        message: payload.message ?? (battle as { declineMessage?: string }).declineMessage ?? null,
        escrowRequired: payload.escrowRequired === true,
        nativeSymbol: payload.nativeSymbol || battle.nativeSymbol,
      }),
    );
    if (event === CHALLENGE_POPUP_EVENTS.accepted && (payload.escrowRequired === true || battle.state === "matched")) {
      setBuyInBattle(battle);
    }
  }, []);

  const poll = useCallback(async () => {
    if (!postGradFlags.arena || !targets.length) return;
    for (const target of targets) {
      const json = await fetchPostGradCreatorBattleStatuses(target.wallet, target.chainId);
      const items = Array.isArray(json?.items) ? (json.items as CreatorBattleStatus[]) : [];
      const owned = creatorOwnedIdentityKeys(items);
      for (const item of items) {
        if (!item?.battleId) continue;
        if (item.currentState !== "challenged" && item.currentState !== "matched") continue;
        const details = await fetchPostGradBattleDetails(item.battleId);
        const battle = asBattle(details?.battle ?? details);
        if (!battle) continue;
        const offerCount = Number((battle as { offerCount?: number }).offerCount || 0);
        if (typeof sessionStorage !== "undefined" && isChallengeDismissed(sessionStorage, battle.id, offerCount)) continue;
        if (battle.state === "challenged" && isResponderTurn(battle, owned)) {
          pushEvent(CHALLENGE_POPUP_EVENTS.received, { battle });
        } else if (battle.state === "matched") {
          setBuyInBattle((current) => current || battle);
        }
      }
    }
  }, [pushEvent, targets]);

  useEffect(() => {
    if (!postGradFlags.arena) return;
    void poll();
    const onFocus = () => void poll();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [poll]);

  const current = queue[0] || null;
  const currentBattle = asBattle(current?.battle);

  function dismissCurrent() {
    if (currentBattle && typeof sessionStorage !== "undefined") {
      dismissChallenge(sessionStorage, currentBattle.id, Number(current?.offerCount || 0));
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
          onEvent={pushEvent}
        />
      ))}
      <ChallengeResponsePopup
        open={Boolean(currentBattle && current?.event !== CHALLENGE_POPUP_EVENTS.accepted)}
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
        open={Boolean(buyInBattle) && !(currentBattle && String(current?.event) !== CHALLENGE_POPUP_EVENTS.accepted)}
        battle={buyInBattle}
        walletAddress={evmWallet || solanaWallet}
        onOpenChange={(next) => {
          if (!next) setBuyInBattle(null);
        }}
      />
    </>
  );
}
