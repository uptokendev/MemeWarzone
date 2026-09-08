import Ably from "ably";
import { ENV } from "./env.js";

const disabledChannel = {
  publish: async () => undefined,
};

const disabledAblyRest = {
  channels: {
    get: () => disabledChannel,
  },
  auth: {
    createTokenRequest: async () => {
      throw new Error("Ably is disabled in isolated local runtime");
    },
  },
};

export const ablyRest: any = ENV.ABLY_DISABLED
  ? disabledAblyRest
  : new Ably.Rest({ key: ENV.ABLY_API_KEY });

function channelAddress(chainId: number, value: string) {
  const raw = String(value || "").trim();
  return chainId === 101 ? raw : raw.toLowerCase();
}

export function tokenChannel(chainId: number, campaignAddress: string) {
  return `token:${chainId}:${channelAddress(chainId, campaignAddress)}`;
}

export function warroomChannel(chainId: number, campaignAddress: string) {
  return `warroom:${chainId}:${channelAddress(chainId, campaignAddress)}`;
}

export function leagueChannel(chainId: number) {
  return `league:${chainId}`;
}

export async function publishTrade(chainId: number, campaign: string, msg: any) {
  const ch = ablyRest.channels.get(tokenChannel(chainId, campaign));
  await ch.publish("trade", msg);
}

export async function publishCandle(chainId: number, campaign: string, msg: any) {
  const ch = ablyRest.channels.get(tokenChannel(chainId, campaign));
  await ch.publish("candle_upsert", msg);
}

export async function publishStats(chainId: number, campaign: string, msg: any) {
  const ch = ablyRest.channels.get(tokenChannel(chainId, campaign));
  await ch.publish("stats_patch", msg);
}

export async function publishLeague(chainId: number, event: string, msg: any) {
  const ch = ablyRest.channels.get(leagueChannel(chainId));
  await ch.publish(event, msg);
}

export async function publishUserRankUpdated(
  chainId: number,
  msg: {
    address: string;
    oldRank: string | null;
    newRank: string;
    rankPoints?: number | string | null;
    updatedAt?: string | null;
  }
) {
  await publishLeague(chainId, "user_rank_updated", {
    address: String(msg.address || "").trim().toLowerCase(),
    oldRank: msg.oldRank ?? null,
    newRank: msg.newRank,
    rankPoints: msg.rankPoints ?? null,
    updatedAt: msg.updatedAt ?? new Date().toISOString(),
  });
}
