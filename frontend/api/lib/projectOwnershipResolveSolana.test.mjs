import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";
import { resolveProjectOwnershipSolana } from "./projectOwnershipResolveSolana.js";

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const MINT = new PublicKey("So11111111111111111111111111111111111111112");
const AUTHORITY = new PublicKey("Vote111111111111111111111111111111111111111");
const OTHER_WALLET = new PublicKey("Stake11111111111111111111111111111111111111");

function mintAccount({ mintAuthority = AUTHORITY.toBase58(), decimals = 9, supply = "1234567890" } = {}) {
  return {
    owner: TOKEN_PROGRAM,
    data: {
      parsed: {
        type: "mint",
        info: {
          decimals,
          supply,
          mintAuthority,
        },
      },
    },
  };
}

function readOnlyConnection(value) {
  return {
    calls: 0,
    async getParsedAccountInfo() {
      this.calls += 1;
      return { value };
    },
    async sendTransaction() {
      throw new Error("financial/program transaction call forbidden");
    },
    async sendRawTransaction() {
      throw new Error("financial/program transaction call forbidden");
    },
    async requestAirdrop() {
      throw new Error("financial call forbidden");
    },
    async getBalance() {
      throw new Error("financial call forbidden");
    },
  };
}

test("valid mint resolves authoritative decimals, supply and mint authority", async () => {
  const connection = readOnlyConnection(mintAccount());
  const result = await resolveProjectOwnershipSolana({
    mint: MINT.toBase58(),
    connectedWallet: OTHER_WALLET.toBase58(),
    connection,
  });

  assert.equal(result.validMint, true);
  assert.equal(result.decimals, 9);
  assert.equal(result.totalSupply, "1234567890");
  assert.equal(result.mintAuthority, AUTHORITY.toBase58());
  assert.equal(connection.calls, 1);
});

test("invalid mint fails safely without RPC or transaction construction", async () => {
  const connection = readOnlyConnection(mintAccount());
  const result = await resolveProjectOwnershipSolana({
    mint: "not-a-solana-mint",
    connectedWallet: AUTHORITY.toBase58(),
    connection,
  });

  assert.equal(result.validMint, false);
  assert.equal(result.verified, false);
  assert.equal(result.reason, "invalid_address");
  assert.equal(connection.calls, 0);
});

test("connected wallet equal to mintAuthority verifies", async () => {
  const result = await resolveProjectOwnershipSolana({
    mint: MINT.toBase58(),
    connectedWallet: AUTHORITY.toBase58(),
    connection: readOnlyConnection(mintAccount()),
  });

  assert.equal(result.automaticVerificationAvailable, true);
  assert.equal(result.verified, true);
  assert.equal(result.reason, "mint_authority_match");
});

test("wrong connected wallet does not verify", async () => {
  const result = await resolveProjectOwnershipSolana({
    mint: MINT.toBase58(),
    connectedWallet: OTHER_WALLET.toBase58(),
    connection: readOnlyConnection(mintAccount()),
  });

  assert.equal(result.automaticVerificationAvailable, true);
  assert.equal(result.verified, false);
  assert.equal(result.reason, "mint_authority_mismatch");
});

test("null mintAuthority keeps mint valid but makes automatic verification unavailable", async () => {
  const result = await resolveProjectOwnershipSolana({
    mint: MINT.toBase58(),
    connectedWallet: AUTHORITY.toBase58(),
    connection: readOnlyConnection(mintAccount({ mintAuthority: null })),
  });

  assert.equal(result.validMint, true);
  assert.equal(result.mintAuthority, null);
  assert.equal(result.automaticVerificationAvailable, false);
  assert.equal(result.verified, false);
  assert.equal(result.reason, "mint_authority_unavailable");
});

test("revoked mint authority does not auto-verify", async () => {
  const result = await resolveProjectOwnershipSolana({
    mint: MINT.toBase58(),
    connectedWallet: AUTHORITY.toBase58(),
    connection: readOnlyConnection(mintAccount({ mintAuthority: null })),
  });

  assert.equal(result.validMint, true);
  assert.equal(result.automaticVerificationAvailable, false);
  assert.equal(result.verified, false);
});

test("resolver does not fabricate name/symbol or return Arena classification", async () => {
  const result = await resolveProjectOwnershipSolana({
    mint: MINT.toBase58(),
    connectedWallet: AUTHORITY.toBase58(),
    connection: readOnlyConnection(mintAccount()),
  });

  assert.equal(Object.hasOwn(result, "name"), false);
  assert.equal(Object.hasOwn(result, "symbol"), false);
  assert.equal(Object.hasOwn(result, "arenaStatus"), false);
  assert.equal(Object.hasOwn(result, "arenaEligible"), false);
  assert.equal(Object.hasOwn(result, "classification"), false);
});

test("resolver performs only the mint read and no financial/program call", async () => {
  const connection = readOnlyConnection(mintAccount());
  const result = await resolveProjectOwnershipSolana({
    mint: MINT.toBase58(),
    connectedWallet: AUTHORITY.toBase58(),
    connection,
  });

  assert.equal(result.validMint, true);
  assert.equal(result.verified, true);
  assert.equal(connection.calls, 1);
});
