import { warzoneTokenInitials } from "./warzoneChrome.mjs";
import { DATA_DELAY_LABEL, presentBattleWallModule } from "./battleWallPresentation.mjs";
import { presentBattleShare } from "./battleSharePresentation.mjs";

// Rendered by api/lib/hudShareCardSvg.mjs battleHudShareCardSvg (same HUD canvas as the token card).
export const BATTLE_SHARE_CARD_WIDTH = 1002;
export const BATTLE_SHARE_CARD_HEIGHT = 531;

function shareChainLabel(chainId) {
  const id = Number(chainId || 0);
  if (id === 101 || id === 102) return "SOL";
  if (id === 56 || id === 97) return "BNB";
  if (id === 4663 || id === 46630) return "ROBINHOOD";
  return "";
}

export function presentBattleShareCard(battle, metrics, options = {}) {
  const share = presentBattleShare(battle, metrics, options);
  const presented = presentBattleWallModule(battle, metrics, options);
  const delayed = share.dataDelayed === true;
  const upcoming = share.state === "upcoming";
  const scoreCaption = delayed || upcoming ? null : share.scoreCaption;
  const leftImage = String(options.leftImageDataUrl || battle?.participants?.[0]?.imageUrl || "").trim() || null;
  const rightImage = String(options.rightImageDataUrl || battle?.participants?.[1]?.imageUrl || "").trim() || null;
  const brandLogo = String(options.brandLogoDataUrl || "").trim() || null;
  const stateLabel =
    delayed ? DATA_DELAY_LABEL : share.state === "finished" ? "FINISHED" : share.state === "upcoming" ? "DEPLOYING" : "LIVE";

  const participants = Array.isArray(battle?.participants) ? battle.participants : [];
  const scored = !delayed && !upcoming && share.leftPointsLabel && share.rightPointsLabel;
  const scoreWord = share.scoreKind === "vote" ? "VOTES" : "PTS";
  const title = delayed
    ? "BATTLE LIVE"
    : share.state === "finished"
      ? "BATTLE OVER"
      : share.state === "upcoming"
        ? "BATTLE SOON"
        : "BATTLE LIVE";

  return {
    title,
    chainLabel: shareChainLabel(battle?.chainId ?? battle?.chain_id),
    leaderIndex: scored || share.winnerLabel ? share.leaderIndex ?? null : null,
    left: {
      ticker: share.leftTicker,
      name: String(participants[0]?.tokenName || "").trim(),
      image: leftImage,
      scoreLabel: scored ? `${share.leftPointsLabel} ${scoreWord}` : null,
    },
    right: {
      ticker: share.rightTicker,
      name: String(participants[1]?.tokenName || "").trim(),
      image: rightImage,
      scoreLabel: scored ? `${share.rightPointsLabel} ${scoreWord}` : null,
    },
    width: BATTLE_SHARE_CARD_WIDTH,
    height: BATTLE_SHARE_CARD_HEIGHT,
    battleId: share.battleId,
    canonicalPath: share.canonicalPath,
    canonicalUrl: share.canonicalUrl,
    shareTitle: share.shareTitle,
    shareText: share.shareText,
    leftTicker: share.leftTicker,
    rightTicker: share.rightTicker,
    leftInitials: warzoneTokenInitials(share.leftTicker, battle?.participants?.[0]?.tokenName),
    rightInitials: warzoneTokenInitials(share.rightTicker, battle?.participants?.[1]?.tokenName),
    leftImage,
    rightImage,
    brandLogo,
    state: share.state,
    stateLabel,
    scoreKind: share.scoreKind,
    scoreCaption,
    leftPointsLabel: delayed || upcoming ? null : share.leftPointsLabel,
    rightPointsLabel: delayed || upcoming ? null : share.rightPointsLabel,
    dataDelayed: delayed,
    winnerLabel: share.winnerLabel,
    brand: "MEMEWARZONE",
    urlLabel: String(share.canonicalUrl || share.canonicalPath || "").replace(/^https?:\/\//, ""),
    leftArtBleed: Boolean(leftImage),
    rightArtBleed: Boolean(rightImage),
    presentedTab: presented.tab,
  };
}

export function battleShareCardImagePath(battleId) {
  const id = String(battleId || "").trim();
  if (!id) return "/api/battle-share-card";
  return `/api/battle-share-card?battleId=${encodeURIComponent(id)}`;
}
