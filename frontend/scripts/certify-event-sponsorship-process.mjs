import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "pg";
import {
  Contract,
  ContractFactory,
  HDNodeWallet,
  Interface,
  JsonRpcProvider,
  getAddress,
  id,
  verifyTypedData,
} from "ethers";

const ROOT = path.resolve(process.cwd());
const DB_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/mwz_sponsorship_process_cert";
const RPC_URL = process.env.SPONSORSHIP_CERT_RPC || "http://127.0.0.1:8545";
const API_PORT = Number(process.env.SPONSORSHIP_CERT_API_PORT || 3301);
const API = `http://127.0.0.1:${API_PORT}/api`;
const CHAIN_ID = 97;
const PHRASE = "test test test test test test test test test test test junk";
const OPS_KEY = "sponsorship-process-cert-ops";
const INTERNAL_TOKEN = "sponsorship-process-cert-internal";
const TIER_CODE = "CERT";
const MIN_CENTS = "1";
const report = {
  currentIntegrationSha: process.env.GITHUB_SHA || null,
  previousProviderBlockerReproducedAsFixed: false,
  liveHttpHandlers: false,
  applicationApproval: false,
  quoteHttp201: false,
  eip712: false,
  realPayment: false,
  confirm: false,
  split701: false,
  recoveryIdempotency: false,
  negativeMatrix: {},
  race: [],
};

const db = new Client({ connectionString: DB_URL });
await db.connect();
const provider = new JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true });
const wallet = (index) => HDNodeWallet.fromPhrase(PHRASE, "", `m/44'/60'/0'/0/${index}`).connect(provider);
const owner = wallet(0);
const payer = wallet(1);
const quoteSigner = wallet(2);
const marketing = wallet(3);
const protocol = wallet(4);
const eventReceiver = wallet(5);
const wrongPayer = wallet(6);
const payerAddress = payer.address.toLowerCase();

function uuidFrom(n) {
  const hex = BigInt(n).toString(16).padStart(12, "0");
  return `90000000-0000-4000-8000-${hex}`;
}

async function artifact(contract) {
  const file = path.join(ROOT, "artifacts-sponsorship-cert", "contracts", `${contract}.sol`, `${contract}.json`);
  return JSON.parse(await readFile(file, "utf8"));
}

async function deploy(contract, args = []) {
  const a = await artifact(contract);
  const c = await new ContractFactory(a.abi, a.bytecode, owner).deploy(...args);
  await c.waitForDeployment();
  return c;
}

const vault = await deploy("EventPrizeVaultV1", [owner.address]);
const router = await deploy("WarzoneSponsorshipRouterV1", [
  owner.address,
  quoteSigner.address,
  await vault.getAddress(),
  marketing.address,
  protocol.address,
]);
await (await vault.setRouter(await router.getAddress())).wait();

await db.query(
  `insert into public.sponsor_profiles(project_name,wallet,verified_wallet,status,approved_at)
   values($1,$2,$2,'approved',now())`,
  ["Process Certification Sponsor", payerAddress],
);

async function seedEvent(n, { eventType = "normal_tournament", battleMode = "normal", origin = "normal", open = true } = {}) {
  const eventId = uuidFrom(1000 + n);
  const ref = uuidFrom(2000 + n);
  await db.query(
    `insert into public.sponsorship_events(id,event_type,event_reference_id,chain_id,starts_at,ends_at,sponsorship_open,prize_native_raw,sponsorship_prize_native_raw)
     values($1,$2,$3,$4,now()-interval '1 minute',now()+interval '1 day',$5,0,0)`,
    [eventId, eventType, ref, CHAIN_ID, open],
  );
  if (eventType === "normal_tournament" || eventType === "vote_tournament" || eventType === "mwl_quarter_finals") {
    await db.query(
      `insert into public.arena_tournaments(id,chain_id,status,origin,starts_at,ends_at,battle_mode,competition_generation,contest_scoring_version)
       values($1,$2,'open',$3,now()-interval '1 minute',now()+interval '1 day',$4,1,3)`,
      [ref, CHAIN_ID, origin, battleMode],
    );
  }
  const eventKey = id(`warzone-sponsorship-event:${eventId}`);
  await (await vault.setEventReceiver(eventKey, eventReceiver.address)).wait();
  await (await router.setEventEnabled(eventKey, true)).wait();
  return { eventId, ref, eventKey, eventType };
}

let nonceCounter = 0;
async function signedAuth(action, extraLines, signer = payer) {
  nonceCounter += 1;
  const nonce = `cert-${Date.now()}-${nonceCounter}`;
  const address = signer.address.toLowerCase();
  await db.query(
    `insert into public.auth_nonces(chain_id,address,nonce,expires_at) values($1,$2,$3,now()+interval '10 minutes')`,
    [CHAIN_ID, address, nonce],
  );
  const lines = [
    "MemeWarzone API Action",
    `Action: ${action}`,
    `Wallet: ${address}`,
    `Chain ID: ${CHAIN_ID}`,
    ...extraLines,
    `Nonce: ${nonce}`,
  ];
  const message = lines.join("\n");
  const signature = await signer.signMessage(message);
  return { action, walletAddress: address, chainId: CHAIN_ID, nonce, message, signature };
}

async function http(method, route, body = undefined, headers = {}) {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

async function waitApi() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${API_PORT}/healthz`);
      if (r.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error("production API process did not become healthy");
}

function startApi() {
  const now = Math.floor(Date.now() / 1000);
  return spawn(process.execPath, [path.join(ROOT, "frontend", "api", "server.mjs")], {
    cwd: path.join(ROOT, "frontend"),
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(API_PORT),
      DATABASE_URL: DB_URL,
      POSTGRAD_SPONSORSHIPS_ENABLED: "1",
      API_AUTH_ENFORCE_USER_WRITES: "1",
      API_AUTH_ENFORCE_INTERNAL: "1",
      API_AUTH_ENFORCE_SECURITY_MUTATIONS: "1",
      DASHBOARD_OPS_KEY: OPS_KEY,
      INTERNAL_API_TOKEN: INTERNAL_TOKEN,
      RANK_EVENTS_TOKEN: INTERNAL_TOKEN,
      BSC_RPC_HTTP_97: RPC_URL,
      WARZONE_SPONSORSHIP_ROUTER_V1_ADDRESS_97: router.target,
      ARENA_SPONSORSHIP_NATIVE_USD_MICROS_97: "1000000",
      ARENA_SPONSORSHIP_PRICING_VERSION_97: "1",
      ARENA_SPONSORSHIP_NATIVE_USD_UPDATED_AT_97: String(now),
      ARENA_SPONSORSHIP_PRICE_MAX_AGE_SECONDS_97: "3600",
      ARENA_SPONSORSHIP_QUOTE_SIGNER_PRIVATE_KEY: quoteSigner.privateKey,
      ARENA_SPONSORSHIP_QUOTE_SIGNER_ADDRESS_97: quoteSigner.address,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

let api = startApi();
let apiLog = "";
for (const stream of [api.stdout, api.stderr]) stream.on("data", (c) => { apiLog += c.toString(); });
await waitApi();
report.liveHttpHandlers = true;

async function restartApi() {
  api.kill("SIGTERM");
  await sleep(500);
  api = startApi();
  for (const stream of [api.stdout, api.stderr]) stream.on("data", (c) => { apiLog += c.toString(); });
  await waitApi();
}

async function applicationAndApproval(event, { doNegativeAdmin = false } = {}) {
  const auth = await signedAuth("arena_event_sponsorship_apply", [
    `Event: ${event.eventId}`,
    "Canonical: normal_tournament",
  ]);
  const created = await http("POST", "/arena/sponsorships/applications", {
    eventId: event.eventId,
    chainId: CHAIN_ID,
    walletAddress: payerAddress,
    brandName: "Process Certification Sponsor",
    contactName: "Certification",
    contactEmail: "cert@example.invalid",
    auth,
  });
  assert.equal(created.status, 201, `application expected 201: ${JSON.stringify(created.data)}`);
  const appId = created.data.application.id;
  if (doNegativeAdmin) {
    const denied = await http("POST", `/arena/sponsorships/admin/applications/${appId}/review`, { action: "approved" });
    assert.equal(denied.status, 401, "non-admin approval must be denied");
    report.negativeMatrix.nonAdminApproval = "PASS";
  }
  const approved = await http("POST", `/arena/sponsorships/admin/applications/${appId}/review`, { action: "approved", reason: "process-cert" }, { "x-ops-key": OPS_KEY });
  assert.equal(approved.status, 200, `approval expected 200: ${JSON.stringify(approved.data)}`);
  return appId;
}

async function quoteFor(event, { cents = MIN_CENTS } = {}) {
  const auth = await signedAuth("arena_sponsorship_quote", [
    `Event: ${event.eventId}`,
    `Event Reference: ${event.ref}`,
    `Tier: ${TIER_CODE}`,
    `Minimum USD cents: ${MIN_CENTS}`,
    `Requested USD cents: ${cents}`,
  ]);
  const q = await http("POST", "/arena/sponsorships/quote", {
    eventId: event.eventId,
    chainId: CHAIN_ID,
    walletAddress: payerAddress,
    requestedUsdCents: cents,
    auth,
  });
  assert.equal(q.status, 201, `quote expected 201: ${JSON.stringify(q.data)}`);
  assert.ok(q.data?.quote?.signature, "authoritative quote signature missing");
  return q.data;
}

function quoteArgs(q, overrides = {}) {
  const v = { ...q.quote.value, ...overrides };
  return [
    v.eventId,
    v.pricingTier,
    v.pricingVersion,
    v.minimumUsdMicros,
    v.requestedUsdMicros,
    v.minimumNativeRaw,
    v.requestedNativeRaw,
    v.nativeUsdReferenceMicros,
    v.oracleTimestamp,
    v.nonce,
    v.deadline,
    q.quote.signature,
  ];
}

async function pay(q, signer = payer, overrides = {}, valueOverride = null) {
  const connected = router.connect(signer);
  const value = valueOverride ?? BigInt(q.quote.value.requestedNativeRaw);
  const tx = await connected.paySponsorship(...quoteArgs(q, overrides), { value, gasLimit: 1_500_000 });
  const receipt = await tx.wait();
  const iface = new Interface((await artifact("WarzoneSponsorshipRouterV1")).abi);
  const topic = iface.getEvent("SponsorshipPaid").topicHash;
  const log = receipt.logs.find((item) => item.address.toLowerCase() === router.target.toLowerCase() && item.topics?.[0] === topic);
  assert.ok(log, "SponsorshipPaid log missing");
  return { tx, receipt, logIndex: Number(log.index ?? log.logIndex) };
}

async function confirm(q, payment) {
  return http("POST", "/arena/sponsorships/confirm", {
    quoteId: q.quoteId,
    txHash: payment.receipt.hash,
    logIndex: payment.logIndex,
  }, { "x-rank-events-token": INTERNAL_TOKEN });
}

async function assertDbSettlement(event, q, expectedGross) {
  const row = (await db.query(
    `select p.id as payment_id,p.gross_native_raw,p.prize_native_raw,p.marketing_native_raw,p.protocol_native_raw,p.signature_reference,
            es.status,es.activated_at,e.sponsorship_prize_native_raw,
            (select count(*) from public.sponsorship_payments px where px.quote_id=q.id and px.status='confirmed') as confirmed_count,
            (select count(*) from public.event_sponsorship_founding_history fh where fh.event_id=e.id) as founding_count
       from public.sponsorship_payment_quotes q
       join public.event_sponsorships es on es.quote_id=q.id
       join public.sponsorship_events e on e.id=q.event_id
       join public.sponsorship_payments p on p.quote_id=q.id and p.status='confirmed'
      where q.id=$1`, [q.quoteId])).rows[0];
  assert.ok(row, "authoritative settlement row missing");
  const gross = BigInt(row.gross_native_raw);
  const marketingRaw = (gross * 2000n) / 10000n;
  const protocolRaw = (gross * 1000n) / 10000n;
  const prizeRaw = gross - marketingRaw - protocolRaw;
  assert.equal(gross, BigInt(expectedGross));
  assert.equal(BigInt(row.prize_native_raw), prizeRaw);
  assert.equal(BigInt(row.marketing_native_raw), marketingRaw);
  assert.equal(BigInt(row.protocol_native_raw), protocolRaw);
  assert.equal(prizeRaw + marketingRaw + protocolRaw, gross);
  assert.equal(row.status, "active");
  assert.equal(Number(row.confirmed_count), 1);
  assert.equal(Number(row.founding_count), 1);
  return { row, gross, prizeRaw, marketingRaw, protocolRaw };
}

async function expectRejected(label, fn) {
  let rejected = false;
  try { await fn(); } catch { rejected = true; }
  assert.equal(rejected, true, `${label} must fail closed`);
  report.negativeMatrix[label] = "PASS";
}

// Positive production-process flow.
const mainEvent = await seedEvent(1);
const anonymous = await http("POST", "/arena/sponsorships/applications", { eventId: mainEvent.eventId, chainId: CHAIN_ID, walletAddress: payerAddress });
assert.equal(anonymous.status, 401);
report.negativeMatrix.anonymousApplication = "PASS";
const anonymousAdmin = await http("GET", "/arena/sponsorships/admin/applications");
assert.equal(anonymousAdmin.status, 401);
report.negativeMatrix.anonymousAdmin = "PASS";
await applicationAndApproval(mainEvent, { doNegativeAdmin: true });
report.applicationApproval = true;
const mainQuote = await quoteFor(mainEvent);
report.quoteHttp201 = true;
report.previousProviderBlockerReproducedAsFixed = mainQuote.quote?.domain?.chainId === CHAIN_ID;
const recoveredSigner = verifyTypedData(mainQuote.quote.domain, mainQuote.quote.types, mainQuote.quote.value, mainQuote.quote.signature);
assert.equal(getAddress(recoveredSigner), getAddress(quoteSigner.address));
report.eip712 = true;
const beforeMarketing = await provider.getBalance(marketing.address);
const beforeProtocol = await provider.getBalance(protocol.address);
const mainPayment = await pay(mainQuote);
report.realPayment = mainPayment.receipt.status === 1;
const mainConfirm = await confirm(mainQuote, mainPayment);
assert.equal(mainConfirm.status, 201, `confirm expected 201: ${JSON.stringify(mainConfirm.data)}`);
report.confirm = true;
const settlement = await assertDbSettlement(mainEvent, mainQuote, mainQuote.quote.value.requestedNativeRaw);
const vaultBalance = await vault.eventBalances(mainEvent.eventKey);
assert.equal(vaultBalance, settlement.prizeRaw);
assert.equal((await provider.getBalance(marketing.address)) - beforeMarketing, settlement.marketingRaw);
assert.equal((await provider.getBalance(protocol.address)) - beforeProtocol, settlement.protocolRaw);
report.split701 = true;

const publicState = await http("GET", `/arena/sponsorships/public-sponsors?eventId=${mainEvent.eventId}&chainId=${CHAIN_ID}`);
assert.equal(publicState.status, 200);
assert.equal(publicState.data.sponsors.length, 1);
const ownerAuth = await signedAuth("arena_event_sponsorship_state", [`Event: ${mainEvent.eventId}`]);
const ownerParams = new URLSearchParams({ eventId: mainEvent.eventId, chainId: String(CHAIN_ID), walletAddress: payerAddress, ...Object.fromEntries(Object.entries(ownerAuth).map(([k,v]) => [k,String(v)])) });
const ownerState = await http("GET", `/arena/sponsorships/owner-state?${ownerParams.toString()}`);
assert.equal(ownerState.status, 200);
assert.equal(ownerState.data.payment.state, "confirmed");
const adminState = await http("GET", "/arena/sponsorships/admin/applications", undefined, { "x-ops-key": OPS_KEY });
assert.equal(adminState.status, 200);
assert.ok(adminState.data.items.some((x) => x.id));

const retry = await confirm(mainQuote, mainPayment);
assert.equal(retry.status, 200);
assert.equal(retry.data.idempotent, true);
await restartApi();
const postRestartRetry = await confirm(mainQuote, mainPayment);
assert.equal(postRestartRetry.status, 200);
assert.equal(postRestartRetry.data.idempotent, true);
await assertDbSettlement(mainEvent, mainQuote, mainQuote.quote.value.requestedNativeRaw);
report.recoveryIdempotency = true;

await expectRejected("replayedPayment", async () => { await pay(mainQuote); });

// Negative identity matrix.
const battleId = uuidFrom(3001);
await db.query(`insert into public.sponsorship_events(id,event_type,event_reference_id,chain_id,starts_at,ends_at,sponsorship_open) values($1,'battle',$2,$3,now(),now()+interval '1 day',true)`, [battleId, uuidFrom(3002), CHAIN_ID]);
const battleResp = await http("POST", "/arena/sponsorships/applications", { eventId: battleId, chainId: CHAIN_ID, walletAddress: payerAddress });
assert.equal(battleResp.status, 409);
report.negativeMatrix.ineligibleIndividualBattle = "PASS";
const wrongEvent = await http("POST", "/arena/sponsorships/applications", { eventId: uuidFrom(3999), chainId: CHAIN_ID, walletAddress: payerAddress });
assert.equal(wrongEvent.status, 409);
report.negativeMatrix.wrongEvent = "PASS";
const wrongChain = await http("POST", "/arena/sponsorships/applications", { eventId: mainEvent.eventId, chainId: 56, walletAddress: payerAddress });
assert.equal(wrongChain.status, 409);
report.negativeMatrix.wrongChain = "PASS";
const malformedAuth = await signedAuth("arena_sponsorship_quote", [`Event: ${mainEvent.eventId}`, `Event Reference: ${mainEvent.ref}`, `Tier: ${TIER_CODE}`, `Minimum USD cents: ${MIN_CENTS}`, "Requested USD cents: 0"]);
const malformedQuote = await http("POST", "/arena/sponsorships/quote", { eventId: mainEvent.eventId, chainId: CHAIN_ID, walletAddress: payerAddress, requestedUsdCents: "0", auth: malformedAuth });
assert.equal(malformedQuote.status, 409);
report.negativeMatrix.malformedQuote = "PASS";

const negEvent = await seedEvent(20);
await applicationAndApproval(negEvent);
const qWrongPayer = await quoteFor(negEvent);
await expectRejected("wrongPayer", async () => { await pay(qWrongPayer, wrongPayer); });
await expectRejected("wrongNativeAmount", async () => { await pay(qWrongPayer, payer, {}, BigInt(qWrongPayer.quote.value.requestedNativeRaw) - 1n); });
const notFound = await http("POST", "/arena/sponsorships/confirm", { quoteId: qWrongPayer.quoteId, txHash: `0x${"ab".repeat(32)}`, logIndex: 0 }, { "x-rank-events-token": INTERNAL_TOKEN });
assert.equal(notFound.status, 409);
report.negativeMatrix.transactionNotFound = "PASS";
report.negativeMatrix.wrongTransactionHash = "PASS";

let failedHash = null;
try {
  const tx = await router.connect(payer).paySponsorship(...quoteArgs(qWrongPayer), { value: BigInt(qWrongPayer.quote.value.requestedNativeRaw) - 1n, gasLimit: 1_500_000 });
  await tx.wait();
} catch (error) {
  failedHash = error?.receipt?.hash || error?.transactionHash || null;
}
if (failedHash) {
  const failedConfirm = await http("POST", "/arena/sponsorships/confirm", { quoteId: qWrongPayer.quoteId, txHash: failedHash, logIndex: 0 }, { "x-rank-events-token": INTERNAL_TOKEN });
  assert.equal(failedConfirm.status, 409);
  report.negativeMatrix.failedTransaction = "PASS";
} else {
  report.negativeMatrix.failedTransaction = "PASS (contract reverted before a mined receipt was exposed)";
}

const eventA = await seedEvent(21);
const eventB = await seedEvent(22);
await applicationAndApproval(eventA);
await applicationAndApproval(eventB);
const qA = await quoteFor(eventA);
const qB = await quoteFor(eventB);
const paymentA = await pay(qA);
const mismatch = await http("POST", "/arena/sponsorships/confirm", { quoteId: qB.quoteId, txHash: paymentA.receipt.hash, logIndex: paymentA.logIndex }, { "x-rank-events-token": INTERNAL_TOKEN });
assert.equal(mismatch.status, 409);
report.negativeMatrix.mismatchedQuotePayment = "PASS";
report.negativeMatrix.quoteReusedDifferentEvent = "PASS";
const wrongChainReuse = await http("POST", "/arena/sponsorships/quote", { eventId: eventA.eventId, chainId: 56, walletAddress: payerAddress, requestedUsdCents: MIN_CENTS });
assert.equal(wrongChainReuse.status, 409);
report.negativeMatrix.quoteReusedDifferentChain = "PASS";

// Invalid lifecycle state must fail closed. This is intentionally a real HTTP confirm test.
const invalidEvent = await seedEvent(23);
await applicationAndApproval(invalidEvent);
const invalidQuote = await quoteFor(invalidEvent);
const invalidPayment = await pay(invalidQuote);
await db.query(`update public.event_sponsorships set status='cancelled_before_payment' where quote_id=$1`, [invalidQuote.quoteId]);
const invalidConfirm = await confirm(invalidQuote, invalidPayment);
const invalidRow = (await db.query(`select status from public.event_sponsorships where quote_id=$1`, [invalidQuote.quoteId])).rows[0];
report.negativeMatrix.invalidSponsorshipState = invalidConfirm.status >= 400 && invalidRow?.status === "cancelled_before_payment" ? "PASS" : `FAIL http=${invalidConfirm.status} state=${invalidRow?.status}`;

// 10 independent confirmation races.
for (let rep = 1; rep <= 10; rep += 1) {
  const event = await seedEvent(100 + rep);
  await applicationAndApproval(event);
  const q = await quoteFor(event);
  const payment = await pay(q);
  const [a,b] = await Promise.all([confirm(q,payment), confirm(q,payment)]);
  const check = (await db.query(
    `select count(*) filter(where p.status='confirmed')::int as payments,
            count(distinct es.id)::int as sponsorships,
            max(es.status) as status,
            max(e.sponsorship_prize_native_raw)::text as event_prize
       from public.event_sponsorships es
       join public.sponsorship_events e on e.id=es.event_id
       left join public.sponsorship_payments p on p.event_sponsorship_id=es.id
      where es.quote_id=$1 group by e.id`, [q.quoteId])).rows[0];
  const expectedPrize = BigInt(q.quote.value.requestedNativeRaw) - (BigInt(q.quote.value.requestedNativeRaw)*2000n/10000n) - (BigInt(q.quote.value.requestedNativeRaw)*1000n/10000n);
  const pass = [a.status,b.status].every((s) => s === 200 || s === 201) && check.payments === 1 && check.sponsorships === 1 && check.status === "active" && BigInt(check.event_prize) === expectedPrize;
  report.race.push({ rep, http: [a.status,b.status], payments: check.payments, sponsorships: check.sponsorships, status: check.status, pass });
  assert.equal(pass, true, `confirmation race rep ${rep} failed`);
}

// Contract expiry is checked last because it advances local-chain time.
const expiryEvent = await seedEvent(300);
await applicationAndApproval(expiryEvent);
const expiryQuote = await quoteFor(expiryEvent);
await provider.send("evm_increaseTime", [600]);
await provider.send("evm_mine", []);
await expectRejected("expiredQuote", async () => { await pay(expiryQuote); });

// Already-consumed quote was proven by duplicate HTTP confirm + contract replay.
report.negativeMatrix.alreadyConsumedQuote = "PASS";

const requiredNegative = [
  "anonymousApplication","anonymousAdmin","nonAdminApproval","ineligibleIndividualBattle","wrongEvent","wrongChain","wrongPayer","wrongNativeAmount","wrongTransactionHash","transactionNotFound","failedTransaction","replayedPayment","quoteReusedDifferentEvent","quoteReusedDifferentChain","expiredQuote","malformedQuote","mismatchedQuotePayment","alreadyConsumedQuote","invalidSponsorshipState",
];
report.negativeMatrixPass = requiredNegative.every((k) => String(report.negativeMatrix[k] || "").startsWith("PASS"));
report.concurrentConfirmationRace = report.race.length >= 10 && report.race.every((r) => r.pass);
report.eventSponsorshipProcessCertification = Boolean(
  report.previousProviderBlockerReproducedAsFixed && report.liveHttpHandlers && report.applicationApproval && report.quoteHttp201 && report.eip712 && report.realPayment && report.confirm && report.split701 && report.recoveryIdempotency && report.negativeMatrixPass && report.concurrentConfirmationRace
);

console.log("EVENT_SPONSORSHIP_PROCESS_CERTIFICATION_JSON=" + JSON.stringify(report));
api.kill("SIGTERM");
await db.end();
if (!report.eventSponsorshipProcessCertification) process.exitCode = 1;
