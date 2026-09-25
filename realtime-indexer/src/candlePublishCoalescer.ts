/**
 * Candle realtime updates, coalesced per token channel.
 *
 * Every trade touches ~10 timeframes and a history rebuild touches hundreds of buckets; each used to
 * go out as its own Ably message. Ably allows 50 messages/s per channel, so a busy launch hit
 * "Rate limit exceeded ... permitted rate = 50" on its token channel (2026-09-25) and live candles
 * were dropped. Candles are state, not events: only the latest value of a bucket matters, and a
 * client that missed an old bucket reloads it over REST. So updates are collected for one window and,
 * per (channel, event, timeframe), only the newest buckets are sent -- the current one plus the one
 * before it, so a bucket that just closed still gets its final value. Trades and stats are not
 * routed through here: every trade is still delivered.
 */

export type CandleUpdate = {
  channel: string;
  event: string;
  timeframe: string;
  bucketMs: number;
  data: unknown;
};

export const DEFAULT_KEEP_PER_TIMEFRAME = 2;

/** Pure selection: latest update per bucket, newest `keep` buckets per (channel, event, timeframe). */
export function selectCandleUpdates(
  updates: CandleUpdate[],
  keep = DEFAULT_KEEP_PER_TIMEFRAME,
): Map<string, CandleUpdate[]> {
  const latestPerBucket = new Map<string, CandleUpdate>();
  for (const update of updates) {
    // Later updates of the same bucket replace earlier ones.
    latestPerBucket.set(`${update.channel}|${update.event}|${update.timeframe}|${update.bucketMs}`, update);
  }
  const perGroup = new Map<string, CandleUpdate[]>();
  for (const update of latestPerBucket.values()) {
    const key = `${update.channel}|${update.event}|${update.timeframe}`;
    const list = perGroup.get(key) ?? [];
    list.push(update);
    perGroup.set(key, list);
  }
  const perChannel = new Map<string, CandleUpdate[]>();
  for (const list of perGroup.values()) {
    list.sort((a, b) => a.bucketMs - b.bucketMs);
    for (const update of list.slice(-Math.max(1, keep))) {
      const out = perChannel.get(update.channel) ?? [];
      out.push(update);
      perChannel.set(update.channel, out);
    }
  }
  return perChannel;
}

export function createCandleCoalescer(input: {
  publish: (channel: string, messages: Array<{ name: string; data: unknown }>) => Promise<void>;
  flushMs?: number;
  keepPerTimeframe?: number;
  onError?: (channel: string, error: unknown) => void;
}) {
  let pending: CandleUpdate[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flushMs = Math.max(100, Math.min(10_000, Number(input.flushMs ?? 1_000)));

  async function flush(): Promise<number> {
    timer = null;
    const batch = pending;
    pending = [];
    if (!batch.length) return 0;
    const perChannel = selectCandleUpdates(batch, input.keepPerTimeframe);
    let sent = 0;
    await Promise.all(
      [...perChannel.entries()].map(async ([channel, list]) => {
        try {
          await input.publish(channel, list.map((u) => ({ name: u.event, data: u.data })));
          sent += list.length;
        } catch (error) {
          input.onError?.(channel, error);
        }
      }),
    );
    return sent;
  }

  function queue(update: CandleUpdate): void {
    pending.push(update);
    if (!timer) {
      timer = setTimeout(() => void flush(), flushMs);
      (timer as any).unref?.();
    }
  }

  return { queue, flush, pendingCount: () => pending.length };
}
