# Grok brief 2, EVM generation (BNB 56): two review findings on PR #478

PR #478 is merged into `build/evm-launch-staging` (e2540407). The review found two things to fix before
mainnet. Same rules as brief 1 (`docs/evm-launch/grok-bnb-brief.md`): own clone, branch
`grok/evm-bnb-followup` from `origin/build/evm-launch-staging`, one PR into `build/evm-launch-staging`,
never merge, no mainnet or testnet transactions, run every test yourself and paste the output, audit
block per changed function, no Claude trailer on your commits, plain sentences without em dashes.

## M1 (medium): the quote route admin can undo the sandwich bound

`BnbQuoteGraduationAdapter.configureQuoteRoute` (`:212-229`) lets the immutable `admin` (an EOA) overwrite
a live route at any time, with any `oracleFeed` and up to 10000 bps for `maxOracleDeviationBps` and
`maxGraduationPriceDeviationBps`.

Failure scenario: the admin key leaks. The attacker points the USDT route at a feed they control with
100% deviation, then in one bundle pushes the WBNB/USDT pool, calls `graduate()` on a Pending USDT coin
and back-runs. They take most of the pool's 78%.

Fix:
- Hard caps as constants: `maxOracleDeviationBps <= 500`, `maxGraduationPriceDeviationBps <= 500`,
  `maxPriceImpactBps <= 500`, `maxSwapSlippageBps <= 500`. Refuse anything above.
- The oracle feed of a quote token is fixed the first time the route is configured. Later calls may
  tighten limits or disable the route (the E12 native fallback then takes over after 7 days), never
  change the feed or loosen a limit.
- Fix the AUDIT note at `:83` ("no admin path over funds") so it states exactly what the admin can do.
- Tests: every refusal; a loosening attempt reverts; tightening and disabling work; a Pending coin
  whose route was disabled graduates through the native fallback after 7 days (reuse
  `test/evmgen-bnb-core-integration.fork.spec.ts`).

## L1 (low): a quote pool opens below the curve price

The target is `quoteAcquired / Mt`, so the acquisition swap's fee and impact push the start price below
the curve price: 59 bps below in USD on the fork. That breaks spec C7 §7 invariant 2 ("start price >=
target") on quote paths.

Fix: size the MEME side from the quote actually acquired at the curve price in USD (the campaign passes
`curvePriceWad` and `nativeUsdWad`; the route's feed prices the quote), so the pool opens at the curve
price, not below it. `memeUsed` may then be below `memeTarget` on quote paths; the core already allows
that there, and returns and burns the rest. Keep the donation absorption and the `memeMax` cap. Update the
unit and fork tests to assert start price >= curve price (USD) within rounding.

## Also

- Add `BnbNativeGraduationAdapter` to `config/verification/mainnet-contracts.json` as a placeholder entry
  with its constructor arguments documented, so the verification script picks it up at deploy.

## Hand-in

Same checklist as brief 1, plus the full `npx hardhat test` (baseline on staging: 921 passing, 0 failing)
and `BNB_FORK=1 npx hardhat test test/evmgen-bnb-core-integration.fork.spec.ts --network hardhat`.
