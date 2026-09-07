const WSOL_MINT = "So11111111111111111111111111111111111111112";
const ORCA_WHIRLPOOL_PROGRAM = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";

function bpsDifference(actual, reference) {
  if (reference <= 0n) throw new RangeError("reference must be positive");
  const diff = actual > reference ? actual - reference : reference - actual;
  return Number((diff * 10_000n) / reference);
}

function expectedRawFromSpot(inputLamports, spotQuotePerSol, quoteDecimals) {
  if (!Number.isFinite(spotQuotePerSol) || spotQuotePerSol <= 0) throw new Error("Orca pool spot price is invalid");
  const scale = 10 ** quoteDecimals;
  const humanSol = Number(inputLamports) / 1_000_000_000;
  const raw = Math.floor(humanSol * spotQuotePerSol * scale);
  if (!Number.isSafeInteger(raw) || raw <= 0) throw new Error("Orca spot output is outside safe integer range");
  return BigInt(raw);
}

export async function quoteOrcaWhirlpoolDevnet({ rpcUrl, route, amountLamports }) {
  if (String(route.cluster || "").toLowerCase() !== "devnet") throw new Error("Orca certification adapter requires devnet policy");
  if (String(route.acquisitionProgram || "") !== ORCA_WHIRLPOOL_PROGRAM) throw new Error("Orca acquisition program does not match the verified Whirlpool deployment");
  if (String(route.inputMint || "") !== WSOL_MINT) throw new Error("Orca certification route input mint must be WSOL");
  if (!route.orcaPool) throw new Error("Orca certification route pool is missing");

  const [{ fetchSplashPool, swapInstructions, WhirlpoolDeployment }, kit] = await Promise.all([
    import("@orca-so/whirlpools"),
    import("@solana/kit"),
  ]);
  const { address, createSolanaRpc, devnet, generateKeyPairSigner } = kit;
  const rpc = createSolanaRpc(devnet(rpcUrl));
  const outputMint = String(route.outputMint || route.quoteMint || "");
  const pool = await fetchSplashPool(rpc, address(WSOL_MINT), address(outputMint), WhirlpoolDeployment.devnet);
  if (!pool.initialized) throw new Error("Configured Orca certification pool is not initialized");
  if (String(pool.address) !== String(route.orcaPool)) throw new Error("Configured Orca pool does not match canonical WSOL/quote Splash Pool");
  if (String(pool.tokenMintA) !== WSOL_MINT || String(pool.tokenMintB) !== outputMint) throw new Error("Configured Orca pool mint binding mismatch");
  if (BigInt(pool.liquidity || 0) <= 0n) throw new Error("Configured Orca certification pool has zero liquidity");

  const signer = await generateKeyPairSigner();
  const slippageToleranceBps = Number(route.maxSlippageBps || 0);
  const built = await swapInstructions(
    rpc,
    { inputAmount: BigInt(amountLamports), mint: address(WSOL_MINT) },
    address(String(route.orcaPool)),
    { signer, slippageToleranceBps, whirlpoolDeployment: WhirlpoolDeployment.devnet },
  );
  const outAmount = BigInt(built.quote.tokenEstOut || 0);
  const minOut = BigInt(built.quote.tokenMinOut || 0);
  if (outAmount <= 0n || minOut <= 0n || minOut > outAmount) throw new Error("Orca acquisition quote returned invalid output bounds");

  const quoteDecimals = Number(route.decimals || 0);
  const spotExpected = expectedRawFromSpot(BigInt(amountLamports), Number(pool.price), quoteDecimals);
  const impactBps = outAmount >= spotExpected ? 0 : bpsDifference(outAmount, spotExpected);

  return {
    adapter: "ORCA_WHIRLPOOL_DEVNET",
    pool: String(pool.address),
    programId: ORCA_WHIRLPOOL_PROGRAM,
    inputMint: WSOL_MINT,
    outputMint,
    inputAmount: BigInt(amountLamports),
    outAmount,
    minOut,
    impactBps,
    slippageBps: slippageToleranceBps,
    poolLiquidity: BigInt(pool.liquidity || 0),
    poolSpotQuotePerSol: Number(pool.price),
  };
}
