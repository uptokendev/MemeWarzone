export type SolanaIngestSignatureResult = {
  fetched: boolean;
  decodedEvents: number;
  tradeEvents: number;
  persistedTradeEvents: number;
  failedEvents: number;
  retryableFailure: boolean;
};

export function emptyIngestResult(overrides: Partial<SolanaIngestSignatureResult> = {}): SolanaIngestSignatureResult {
  return {
    fetched: false,
    decodedEvents: 0,
    tradeEvents: 0,
    persistedTradeEvents: 0,
    failedEvents: 0,
    retryableFailure: true,
    ...overrides,
  };
}

export function isSolanaTradeEventKind(kind: string): boolean {
  return kind === "TokensBought" || kind === "TokensSold";
}

/** A fetched tx is durable only when no BUY/SELL persistence failure remains. */
export function shouldMarkPdaSignatureProcessed(result: SolanaIngestSignatureResult): boolean {
  return result.fetched === true && result.retryableFailure !== true;
}

export function campaignHistoryComplete(input: {
  reachedCreationSlot: boolean;
  ingestCapped: boolean;
  retryableFailures: number;
  unprocessedInWindow: number;
}): boolean {
  return (
    input.reachedCreationSlot === true &&
    input.ingestCapped !== true &&
    Number(input.retryableFailures || 0) === 0 &&
    Number(input.unprocessedInWindow || 0) === 0
  );
}

export async function persistDecodedAnchorEvents(input: {
  events: Array<{ kind: string }>;
  persistEvent: (event: { kind: string }, index: number) => Promise<void>;
}): Promise<Pick<
  SolanaIngestSignatureResult,
  "decodedEvents" | "tradeEvents" | "persistedTradeEvents" | "failedEvents" | "retryableFailure"
>> {
  let tradeEvents = 0;
  let persistedTradeEvents = 0;
  let failedEvents = 0;
  let retryableFailure = false;
  for (let index = 0; index < input.events.length; index += 1) {
    const event = input.events[index];
    const isTrade = isSolanaTradeEventKind(String(event.kind || ""));
    if (isTrade) tradeEvents += 1;
    try {
      await input.persistEvent(event, index);
      if (isTrade) persistedTradeEvents += 1;
    } catch {
      failedEvents += 1;
      if (isTrade) retryableFailure = true;
    }
  }
  return {
    decodedEvents: input.events.length,
    tradeEvents,
    persistedTradeEvents,
    failedEvents,
    retryableFailure,
  };
}
