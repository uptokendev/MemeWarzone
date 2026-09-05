import type { Express } from "express";
import { resolveMarketIdentityOrPassthrough } from "./marketIdentity.js";
import { computeRobinhoodBeatTheMarket } from "./robinhoodBeatTheMarketService.js";

const ROBINHOOD_CHAIN_IDS = new Set([4663, 46630]);

function enabled(): boolean {
  return /^(1|true|yes|on)$/i.test(String(process.env.ROBINHOOD_BEAT_THE_MARKET || "").trim());
}

function chainIdFrom(value: unknown): number {
  const chainId = Number(value);
  return Number.isInteger(chainId) && ROBINHOOD_CHAIN_IDS.has(chainId) ? chainId : 0;
}

export function registerRobinhoodBeatTheMarketRoutes(app: Express): void {
  app.get("/api/token/:campaign/beat-the-market", async (req, res, next) => {
    const chainId = chainIdFrom(req.query.chainId);
    if (!chainId) return next();
    if (!enabled()) return res.status(404).json({ error: "Beat the Market is not enabled." });

    try {
      const identity = await resolveMarketIdentityOrPassthrough(chainId, String(req.params.campaign || ""));
      const campaignAddress = String(identity?.campaignAddress || "").trim();
      if (!campaignAddress) return res.status(400).json({ error: "Invalid Robinhood campaign." });

      const result = await computeRobinhoodBeatTheMarket({
        chainId,
        campaignAddress,
        window: String(req.query.window || "24h"),
        persist: true,
      });
      if (!result.metric.healthy) {
        return res.status(200).json({
          chainId,
          campaignAddress,
          window: result.window,
          formulaVersion: result.metric.formulaVersion,
          healthy: false,
          error: result.metric.error,
        });
      }

      return res.json({
        ...result,
        formulaVersion: result.metric.formulaVersion,
        healthy: true,
      });
    } catch (error: any) {
      console.error("[robinhood-beat-market] metric failed", {
        chainId,
        campaign: req.params.campaign,
        error: error?.message || String(error),
      });
      return res.status(500).json({ error: "Beat the Market metric temporarily unavailable." });
    }
  });
}

export const robinhoodBeatTheMarketApiInternals = {
  enabled,
  chainIdFrom,
};
