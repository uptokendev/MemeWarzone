import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../arenaSponsorships.js", import.meta.url), "utf8");

function handlerSection(start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing ${start}`);
  const endIndex = end ? source.indexOf(end, startIndex + start.length) : source.length;
  assert.notEqual(endIndex, -1, `missing ${end}`);
  return source.slice(startIndex, endIndex);
}

test("handleQuote awaits the server read provider before deployment verification", () => {
  const quote = handlerSection("async function handleQuote", "async function handleConfirm");
  const providerLine = "const provider = await getServerReadProvider(Number(event.chain_id));";
  const verificationCall = "deployment = await verifySponsorshipDeployment({";

  assert.ok(quote.includes(providerLine));
  assert.ok(quote.includes(verificationCall));
  assert.ok(quote.indexOf(providerLine) < quote.indexOf(verificationCall));
  assert.match(quote, /verifySponsorshipDeployment\(\{\s*provider,/s);
});

test("handleConfirm awaits the server read provider before receipt verification", () => {
  const confirm = handlerSection("async function handleConfirm", "export default async function handler");
  const providerLine = "const provider = await getServerReadProvider(Number(quote.chain_id));";
  const verificationCall = "proof = await verifySponsorshipPayment({";

  assert.ok(confirm.includes(providerLine));
  assert.ok(confirm.includes(verificationCall));
  assert.ok(confirm.indexOf(providerLine) < confirm.indexOf(verificationCall));
  assert.match(confirm, /verifySponsorshipPayment\(\{\s*provider,/s);
});

test("Event Sponsorship cannot pass an unresolved provider Promise to a contract runner", async () => {
  const calls = source.match(/getServerReadProvider\(/g) || [];
  assert.equal(calls.length, 2, "unexpected Event Sponsorship provider call site count");
  assert.doesNotMatch(source, /provider:\s*getServerReadProvider\(/);
  assert.doesNotMatch(source, /const\s+provider\s*=\s*getServerReadProvider\(/);

  const pendingProvider = Promise.resolve({ call() {}, getTransactionReceipt() {} });
  assert.equal(typeof pendingProvider.call, "undefined");
  assert.equal(typeof pendingProvider.getTransactionReceipt, "undefined");
  const provider = await pendingProvider;
  assert.equal(typeof provider.call, "function");
  assert.equal(typeof provider.getTransactionReceipt, "function");
});

test("quote provider resolution remains behind existing sponsor and wallet auth gates", () => {
  const quote = handlerSection("async function handleQuote", "async function handleConfirm");
  const providerIndex = quote.indexOf("const provider = await getServerReadProvider");

  assert.ok(quote.indexOf("SPONSORSHIP_EVENT_NOT_FOUND") < providerIndex);
  assert.ok(quote.indexOf("SPONSORSHIP_CLOSED") < providerIndex);
  assert.ok(quote.indexOf("SPONSORSHIP_WALLET_REQUIRED") < providerIndex);
  assert.ok(quote.indexOf("SPONSOR_PROFILE_NOT_APPROVED") < providerIndex);
  assert.ok(quote.indexOf("SPONSORSHIP_BELOW_MINIMUM") < providerIndex);
  assert.ok(quote.indexOf("await requireWalletActionAuth({") < providerIndex);
});

test("confirm provider resolution remains behind internal auth and input/quote gates", () => {
  const confirm = handlerSection("async function handleConfirm", "export default async function handler");
  const providerIndex = confirm.indexOf("const provider = await getServerReadProvider");

  assert.ok(confirm.indexOf("await requireInternalAuth(") < providerIndex);
  assert.ok(confirm.indexOf("SPONSORSHIP_CONFIRM_INPUT_REQUIRED") < providerIndex);
  assert.ok(confirm.indexOf("SPONSORSHIP_QUOTE_NOT_FOUND") < providerIndex);
  assert.ok(confirm.indexOf("SPONSORSHIP_TIER_MISSING") < providerIndex);
  assert.ok(confirm.indexOf("SPONSORSHIP_PAYMENT_UNVERIFIED") > providerIndex);
});

test("confirm preserves exact-receipt idempotency before lifecycle state rejection", () => {
  const confirm = handlerSection("async function handleConfirm", "export default async function handler");
  const existingLookup = confirm.indexOf("const existing = (await client.query(");
  const idempotentResponse = confirm.indexOf("idempotent: true");
  const rowLock = confirm.indexOf("for update");
  const stateGate = confirm.indexOf('sponsorship.status !== "pending_payment"');
  const invalidStateCode = confirm.indexOf('code: "SPONSORSHIP_INVALID_STATE"');
  const paymentInsert = confirm.indexOf("insert into public.sponsorship_payments");
  const activation = confirm.indexOf("set status = 'active'");

  for (const index of [existingLookup, idempotentResponse, rowLock, stateGate, invalidStateCode, paymentInsert, activation]) {
    assert.ok(index >= 0, "missing confirm lifecycle/idempotency invariant");
  }

  assert.ok(existingLookup < idempotentResponse);
  assert.ok(idempotentResponse < rowLock, "safe retry must resolve before lifecycle rejection");
  assert.ok(rowLock < stateGate, "state must be checked after FOR UPDATE lock");
  assert.ok(stateGate < paymentInsert, "invalid lifecycle state must fail before payment insertion");
  assert.ok(stateGate < activation, "invalid lifecycle state must fail before activation");
});

test("only pending_payment is confirmable for a new receipt", () => {
  const confirm = handlerSection("async function handleConfirm", "export default async function handler");
  assert.match(confirm, /if \(sponsorship\.status !== "pending_payment"\) \{/);
  assert.match(confirm, /return json\(res, 409, \{[\s\S]*?code: "SPONSORSHIP_INVALID_STATE"[\s\S]*?state: sponsorship\.status/);

  const confirmable = (state) => state === "pending_payment";
  assert.equal(confirmable("pending_payment"), true);
  for (const state of [
    "cancelled_before_payment",
    "inactive",
    "operator_policy_required",
    "completed",
    "active",
    "unknown_anomalous_state",
  ]) {
    assert.equal(confirmable(state), false, `${state} must reject a new confirmation`);
  }
});

test("invalid-state rejection occurs before all 70/20/10 database accounting writes", () => {
  const confirm = handlerSection("async function handleConfirm", "export default async function handler");
  const stateGate = confirm.indexOf('sponsorship.status !== "pending_payment"');
  const paymentInsert = confirm.indexOf("insert into public.sponsorship_payments");
  const sponsorshipUpdate = confirm.indexOf("update public.event_sponsorships");
  const eventPrizeUpdate = confirm.indexOf("update public.sponsorship_events");

  assert.ok(stateGate >= 0);
  assert.ok(stateGate < paymentInsert);
  assert.ok(stateGate < sponsorshipUpdate);
  assert.ok(stateGate < eventPrizeUpdate);
});
