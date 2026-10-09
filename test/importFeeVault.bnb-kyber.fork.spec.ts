/**
 * CO-IMP rev 2 CI2 proof on a local anvil fork of BNB 56: a REAL KyberSwap route (PancakeSwap pools only), quoted and
 * built by frontend/api/importSwap.js's own handlers (importSwapQuote / importSwapBuild, the API the app calls) with the
 * fee terms set the CI2 way in-process (IMPORT_FEE_VAULT_56 = IMPORT_SWAP_FEE_RECEIVER_56 = an ImportFeeVault deployed
 * on this fork by scripts/deploy-import-fee-vault.ts, its IF1 batch executed as the impersonated Safe; importSwapFeeBps(56)
 * then gives 100 bps by itself, no IMPORT_SWAP_FEE_BPS override). The built
 * transaction is sent from a throwaway funded wallet. Proven to the wei:
 *   buy:  ONE vault Deposit, from = Kyber router 0x6131B5fa, amount = amountIn * 100 / 10_000 (fee in BNB on the input)
 *   sell: ONE vault Deposit, from = Kyber router, amount = gross * 100 / 10_000 where gross = what the wallet got + fee
 *         (fee in BNB on the output)
 *   assertBscRouteTerms accepts the 100 bps / vault terms and refuses the old 50 bps / ProtocolRevenueVault ones.
 * Then the vault's operator sweeps the protocol half to the real ProtocolRevenueVault with payout().
 * Read-only HTTP calls to the Kyber API; nothing is sent to BNB Chain.
 *
 *   anvil --fork-url https://bsc.drpc.org --chain-id 56 --port 8645 --accounts 0 --no-rate-limit
 *   npx hardhat test test/importFeeVault.bnb-kyber.fork.spec.ts --network bscForkRehearsal
 * IMPORT_FEE_KYBER_TOKEN overrides the coin (default TST 0x86Bb94Dd, a four.meme coin that trades on PancakeSwap v2).
 */
import { expect } from "chai";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ethers, network } from "hardhat";
import { assertLocalFork } from "../scripts/lib/forkRehearsal";
import { deployVaultOnFork, freshWallet, gasCost, vaultDeposits } from "./helpers/importFeeVaultFork";

const KYBER_ROUTER = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";
const PROTOCOL_REVENUE_VAULT_56 = "0xc2d4E6f846446f3921a34A34e007295dbc19Bc4c";
const TOKEN = ethers.getAddress(process.env.IMPORT_FEE_KYBER_TOKEN || "0x86Bb94DdD16Efc8bc58e6b056e8df71D9e666429");
const BPS = 100n;
const esmImport = new Function("s", "return import(s)") as (s: string) => Promise<any>;

/** Calls an API handler the way server.mjs does (req.body already parsed), returns the JSON it wrote. */
async function callHandler(handler: any, body: unknown) {
  let status = 0;
  let payload = "";
  const res = { statusCode: 0, setHeader() {}, end(s: string) { payload = s; status = this.statusCode; } } as any;
  await handler({ method: "POST", body }, res);
  const out = JSON.parse(payload);
  if (status !== 200 || !out.ok) throw new Error(`handler ${status}: ${payload}`);
  return out;
}

const d = network.name === "bscForkRehearsal" ? describe : describe.skip;

d("CI2: Kyber BNB import swaps pay exactly 1% to ImportFeeVault (BSC fork, real route)", function () {
  this.timeout(900_000);
  let vault: any;
  let vaultAddress: string;
  let operator: string;
  let api: any;
  const results: Record<string, string> = {};

  before(async function () {
    const fork = await assertLocalFork(56);
    console.log(`      fork of 56 at block ${fork.forkBlock} (${fork.forkUrl})`);
    ({ vault, vaultAddress, operator } = await deployVaultOnFork(56));
    // CI2 env, set before importSwap.js reads it at module load.
    // The switch: the vault AND the Kyber fee receiver set to it. The legacy IMPORT_SWAP_FEE_BPS stays at its default.
    delete process.env.IMPORT_SWAP_FEE_BPS;
    process.env.IMPORT_FEE_VAULT_56 = vaultAddress;
    process.env.IMPORT_SWAP_FEE_RECEIVER_56 = vaultAddress;
    api = await esmImport(pathToFileURL(path.resolve(__dirname, "..", "frontend", "api", "importSwap.js")).href);
    expect(api.IMPORT_SWAP_FEE_BPS).to.equal(50); // legacy rate untouched
    expect(api.importSwapFeeBps(56)).to.equal(Number(BPS));
  });

  after(() => {
    for (const [k, v] of Object.entries(results)) console.log(`      ${k}: ${v}`);
  });

  let wallet: any;
  const erc20 = (signer?: any) => new ethers.Contract(TOKEN, ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function symbol() view returns (string)"], signer ?? ethers.provider);

  it("buy: one Deposit from the Kyber router of exactly 1% of the BNB in", async function () {
    wallet = await freshWallet("2");
    const amountRaw = ethers.parseEther("0.1");
    const quote = await callHandler(api.importSwapQuote, { chainId: 56, side: "buy", token: TOKEN, amountRaw: amountRaw.toString() });
    expect(quote.feeBps).to.equal(100);
    expect(quote.creatorShareBps).to.equal(50);
    expect(quote.quote.extraFee).to.deep.include({ feeAmount: "100", chargeFeeBy: "currency_in", isInBps: true });
    expect(String(quote.quote.extraFee.feeReceiver).toLowerCase()).to.equal(vaultAddress.toLowerCase());
    // The API's own guard, with the CI2 terms passed explicitly and from the env defaults.
    api.assertBscRouteTerms(quote.quote, { token: TOKEN.toLowerCase(), side: "buy", feeBps: 100, feeReceiver: vaultAddress.toLowerCase() });
    api.assertBscRouteTerms(quote.quote, { token: TOKEN.toLowerCase(), side: "buy" });
    expect(() => api.assertBscRouteTerms(quote.quote, { token: TOKEN.toLowerCase(), side: "buy", feeBps: 50, feeReceiver: PROTOCOL_REVENUE_VAULT_56.toLowerCase() })).to.throw(/platform fee/);
    const built = await callHandler(api.importSwapBuild, { chainId: 56, side: "buy", token: TOKEN, wallet: wallet.address, quote: quote.quote, slippageBps: 300 });
    expect(built.to.toLowerCase()).to.equal(KYBER_ROUTER.toLowerCase());
    expect(BigInt(built.value)).to.equal(amountRaw);

    const t0 = await erc20().balanceOf(wallet.address);
    const b0 = await ethers.provider.getBalance(wallet.address);
    const v0 = await ethers.provider.getBalance(vaultAddress);
    const rc = await (await wallet.sendTransaction({ to: built.to, data: built.data, value: BigInt(built.value) })).wait();
    expect(rc.status).to.equal(1);
    const deposits = vaultDeposits(vault, rc);
    const fee = (amountRaw * BPS) / 10_000n;
    expect(deposits.length).to.equal(1);
    expect(deposits[0].from.toLowerCase()).to.equal(KYBER_ROUTER.toLowerCase());
    expect(deposits[0].amount).to.equal(fee);
    expect((await ethers.provider.getBalance(vaultAddress)) - v0).to.equal(fee);
    expect(b0 - (await ethers.provider.getBalance(wallet.address))).to.equal(amountRaw + gasCost(rc));
    const got = (await erc20().balanceOf(wallet.address)) - t0;
    expect(got > 0n).to.equal(true);
    results.buy = `in ${amountRaw} wei, vault Deposit ${deposits[0].amount} wei from ${deposits[0].from}, tokens ${got} (quoted ${quote.amountOut}), route ${quote.route.join(">")}, gas ${rc.gasUsed}`;
  });

  it("sell: one Deposit from the Kyber router of exactly 1% of the gross BNB out", async function () {
    const amountIn = (await erc20().balanceOf(wallet.address)) / 2n;
    expect(amountIn > 0n).to.equal(true);
    const quote = await callHandler(api.importSwapQuote, { chainId: 56, side: "sell", token: TOKEN, amountRaw: amountIn.toString() });
    expect(quote.quote.extraFee).to.deep.include({ feeAmount: "100", chargeFeeBy: "currency_out", isInBps: true });
    api.assertBscRouteTerms(quote.quote, { token: TOKEN.toLowerCase(), side: "sell", feeBps: 100, feeReceiver: vaultAddress.toLowerCase() });
    expect(() => api.assertBscRouteTerms(quote.quote, { token: TOKEN.toLowerCase(), side: "sell", feeBps: 50, feeReceiver: vaultAddress.toLowerCase() })).to.throw(/platform fee/);
    const built = await callHandler(api.importSwapBuild, { chainId: 56, side: "sell", token: TOKEN, wallet: wallet.address, quote: quote.quote, slippageBps: 300 });
    expect(BigInt(built.value)).to.equal(0n);
    const ap = await (await erc20(wallet).approve(built.spender, amountIn)).wait();
    expect(ap.status).to.equal(1);

    const t0 = await erc20().balanceOf(wallet.address);
    const b0 = await ethers.provider.getBalance(wallet.address);
    const v0 = await ethers.provider.getBalance(vaultAddress);
    const rc = await (await wallet.sendTransaction({ to: built.to, data: built.data, value: 0n })).wait();
    expect(rc.status).to.equal(1);
    expect(t0 - (await erc20().balanceOf(wallet.address))).to.equal(amountIn);
    const received = (await ethers.provider.getBalance(wallet.address)) - b0 + gasCost(rc);
    const deposits = vaultDeposits(vault, rc);
    expect(deposits.length).to.equal(1);
    expect(deposits[0].from.toLowerCase()).to.equal(KYBER_ROUTER.toLowerCase());
    const fee = deposits[0].amount;
    const gross = received + fee;
    expect(fee).to.equal((gross * BPS) / 10_000n);
    expect((await ethers.provider.getBalance(vaultAddress)) - v0).to.equal(fee);
    results.sell = `tokens ${amountIn}, gross ${gross} wei, vault Deposit ${fee} wei from ${deposits[0].from} (= gross*100/10000), wallet got ${received} wei (quoted ${quote.amountOut}), route ${quote.route.join(">")}, gas ${rc.gasUsed}`;
  });

  it("operator sweeps to the real ProtocolRevenueVault with payout()", async function () {
    const bal = await ethers.provider.getBalance(vaultAddress);
    const half = bal / 2n;
    await ethers.provider.send("anvil_impersonateAccount", [operator]);
    await ethers.provider.send("anvil_setBalance", [operator, ethers.toQuantity(ethers.parseEther("1"))]);
    const op = await ethers.getSigner(operator);
    const prv = await ethers.getContractAt("ProtocolRevenueVault", PROTOCOL_REVENUE_VAULT_56);
    const rc = await (await vault.connect(op).payout(PROTOCOL_REVENUE_VAULT_56, half)).wait();
    const prvDeposits = vaultDeposits(prv, rc);
    expect(prvDeposits.length).to.equal(1);
    expect(prvDeposits[0].from.toLowerCase()).to.equal(vaultAddress.toLowerCase());
    expect(prvDeposits[0].amount).to.equal(half);
    expect(await ethers.provider.getBalance(vaultAddress)).to.equal(bal - half);
    results.sweep = `payout(ProtocolRevenueVault, ${half}) -> its Deposit(from = vault, ${half})`;
  });
});
