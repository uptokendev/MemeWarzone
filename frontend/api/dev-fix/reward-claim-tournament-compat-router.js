import {
  rewardClaimConfig,
  rewardClaimIntent as tournamentRewardClaimIntent,
  rewardClaimRecord,
} from "./reward-claim-tournament-router.js";

export { rewardClaimConfig, rewardClaimRecord };

export async function rewardClaimIntent(req, res) {
  const originalStatus = res.status.bind(res);
  const originalJson = res.json.bind(res);
  let statusCode = 200;
  const proxy = Object.create(res);
  proxy.status = (code) => { statusCode = code; return proxy; };
  proxy.json = (payload) => {
    const calls = payload?.claimIntent?.calls;
    if (Array.isArray(calls)) {
      payload = {
        ...payload,
        claimIntent: {
          ...payload.claimIntent,
          calls: calls.map((call) => call?.kind === "solana_tournament" && call?.mode === "solana_tournament"
            ? { ...call, mode: "solana_airdrop" }
            : call),
        },
      };
    }
    return originalStatus(statusCode).json(payload);
  };
  return tournamentRewardClaimIntent(req, proxy);
}
