import assert from "node:assert/strict";
import test from "node:test";
import { tokenDetailsPath } from "./tokenDetailsPath.ts";

test("BNB mainnet share URLs omit ?chainId=56", () => {
  assert.equal(
    tokenDetailsPath(
      { tokenAddress: "0xA9d9350DE50B2b413663b3F0B08352A8d92871d5", chainId: 56 },
      { chainId: 56 },
    ),
    "/token/0xa9d9350de50b2b413663b3f0b08352a8d92871d5",
  );
});

test("BNB testnet keeps ?chainId=97", () => {
  assert.equal(
    tokenDetailsPath(
      { tokenAddress: "0xA9d9350DE50B2b413663b3F0B08352A8d92871d5", chainId: 97 },
      { chainId: 97 },
    ),
    "/token/0xa9d9350de50b2b413663b3f0b08352a8d92871d5?chainId=97",
  );
});

test("Solana mint URLs stay query-less", () => {
  assert.equal(
    tokenDetailsPath(
      { tokenAddress: "5Y65pvFoJHFpHDd1tY8Xt3SqQwubcaQXWmGgQKkNi89L", chainId: 101 },
      { chainId: 101 },
    ),
    "/token/5Y65pvFoJHFpHDd1tY8Xt3SqQwubcaQXWmGgQKkNi89L",
  );
});
