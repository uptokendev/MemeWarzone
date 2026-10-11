// Imported first by main.ts: @solana/web3.js captures globalThis.fetch when it is
// first imported, so the Solana request counter has to wrap fetch before that.
// main.ts, tokenSidePreload.ts and wtrPreload.ts import this first (the preloads
// run before main.ts and already pull in the Solana indexer).
import { hookSolanaFetchCounter } from "./rpcUsage.js";

hookSolanaFetchCounter();
