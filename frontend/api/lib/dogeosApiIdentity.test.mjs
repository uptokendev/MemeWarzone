// DogeOS Chikyu testnet (6281971) chain identity across the API (plan t14, spec §3).
// Every lookup that lists 46630 gets 6281971 too, with DOGE as native symbol, and no lookup
// falls back to a BSC RPC, a BNB symbol or a Robinhood/ETH branch. Existing chains keep their
// exact current answers (the before/after tables below pin them).
import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { readFileSync } from "node:fs";
import { ethers } from "ethers";

process.env.DATABASE_URL ||= "postgres://user:pass@127.0.0.1:1/none";
// server/db.js reuses globalThis.__memewarzone_pool when it is already set (its "Reuse pool across
// invocations" hook), so route modules import with this stub and never open a database connection.
globalThis.__memewarzone_pool ||= { query: async () => ({ rows: [], rowCount: 0 }) };

const DOGEOS = 6281971;
const DOGEOS_PUBLIC_RPC = "https://rpc.testnet.dogeos.com";

const { isDogeosChainId, isRobinhoodChainId, isBnbChainId, nativeSymbolFor } = await import("./chainNative.js");
const { defaultEvmChainId } = await import("./defaultEvmChain.js");
const { getRpcUrls, getServerReadProvider, resetServerReadProviders } = await import("./getServerReadProvider.js");
const { chainOfRpcUrl } = await import("./rpcUsage.js");
const { rpcUrl: progressRpcUrl, withEvmBondingProgress } = await import("./evmCampaignProgress.js");
const notificationContract = await import("./notificationContract.js");
const { scanCoinNotifications } = await import("./notificationProducers.js");
const { verifyEvmRewardClaim } = await import("./rewardClaimVerification.js");
const { EVM_LAUNCH_OPTION_CHAIN_IDS, wantsEvmLaunchOptions } = await import("./draftEvmLaunchOptions.js");
const { evmCampaignStateHandler } = await import("../evmCampaignState.js");
const { default: rewardsHandler } = await import("../rewards.js");
const generic = await import("../dev-fix/reward-claim-intent-generic.js");
const closeout = await import("../dev-fix/reward-claim-closeout-router.js");
const lpFees = await import("../dashboard/lp-fees.js");

const RPC_ENV_KEYS = [
  "DOGEOS_RPC_HTTP_6281971",
  "EVM_RPC_HTTP_6281971",
  "VITE_PUBLIC_RPC_6281971",
  "ROBINHOOD_RPC_HTTP_6281971",
  "BSC_RPC_HTTP_6281971",
  "BSC_RPC_HTTP",
  "BSC_RPC_HTTP_56",
  "BSC_RPC_HTTP_97",
  "VITE_BSC_MAINNET_RPC",
  "VITE_BSC_TESTNET_RPC",
  "BSC_MAINNET_RPC",
  "BSC_MAINNET_RPC_URL",
  "BSC_TESTNET_RPC",
  "BSC_TESTNET_RPC_URL",
  "BSC_TESTNET_RPC_HTTP",
  "ROBINHOOD_RPC_HTTP_4663",
  "ROBINHOOD_RPC_HTTP_46630",
  "ROBINHOOD_MAINNET_RPC_URL",
  "ROBINHOOD_MAINNET_RPC",
  "ROBINHOOD_TESTNET_RPC_URL",
  "ROBINHOOD_TESTNET_RPC",
  "VITE_PUBLIC_RPC_56",
  "VITE_PUBLIC_RPC_97",
  "VITE_PUBLIC_RPC_4663",
  "VITE_PUBLIC_RPC_46630",
  "DEFAULT_EVM_CHAIN_ID",
  "VITE_DEFAULT_CHAIN_ID",
  "REWARD_DISTRIBUTOR_ADDRESS",
  "VITE_REWARD_DISTRIBUTOR_ADDRESS",
  "REWARD_DISTRIBUTOR_ADDRESS_6281971",
  "LP_LOCKER_ADDRESS",
  "VITE_LP_LOCKER_ADDRESS",
  "LP_LOCKER_ADDRESS_6281971",
  "LP_LOCKER_ADDRESS_46630",
  "DASHBOARD_OPS_KEY",
  "OPS_READ_KEY",
];

/** Runs fn with exactly these RPC-related env vars set (all others in RPC_ENV_KEYS cleared). */
async function withEnv(vars, fn) {
  const saved = new Map(RPC_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of RPC_ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(vars)) process.env[key] = value;
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Every BSC RPC env a fallthrough could pick up, each set to a recognisable URL. */
const BSC_SENTINELS = {
  BSC_RPC_HTTP: "https://bsc-sentinel-generic.example",
  BSC_RPC_HTTP_56: "https://bsc-sentinel-56.example",
  BSC_RPC_HTTP_97: "https://bsc-sentinel-97.example",
  VITE_BSC_MAINNET_RPC: "https://bsc-sentinel-vite-mainnet.example",
  VITE_BSC_TESTNET_RPC: "https://bsc-sentinel-vite-testnet.example",
  BSC_TESTNET_RPC_HTTP: "https://bsc-sentinel-testnet-http.example",
};

const selector = (signature) => ethers.id(signature).slice(0, 10);
const coder = ethers.AbiCoder.defaultAbiCoder();
const uint = (value) => coder.encode(["uint256"], [value]);
const addr = (value) => coder.encode(["address"], [value]);

/** Minimal JSON-RPC node: answers eth_call by selector, records every call. */
async function startRpc(chainId, { calls: callMap = {}, balance = 0n } = {}) {
  const calls = [];
  const answer = (msg) => {
    calls.push(msg);
    switch (msg.method) {
      case "eth_chainId":
        return { result: ethers.toQuantity(chainId) };
      case "net_version":
        return { result: String(chainId) };
      case "eth_blockNumber":
        return { result: "0x10" };
      case "eth_getBalance":
        return { result: ethers.toQuantity(balance) };
      case "eth_getTransactionByHash":
      case "eth_getTransactionReceipt":
        return { result: null };
      case "eth_call": {
        const data = String(msg.params?.[0]?.data || msg.params?.[0]?.input || "");
        const hit = callMap[data.slice(0, 10)];
        if (hit !== undefined) return { result: hit };
        return { error: { code: 3, message: "execution reverted", data: "0x" } };
      }
      default:
        return { error: { code: -32601, message: `method ${msg.method} not found` } };
    }
  };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const body = JSON.parse(raw);
      const one = (msg) => ({ jsonrpc: "2.0", id: msg.id, ...answer(msg) });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    methods: () => calls.map((c) => c.method),
    callSelectors: () => calls.filter((c) => c.method === "eth_call").map((c) => String(c.params[0].data).slice(0, 10)),
    close: () => {
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

function nodeRes() {
  const out = { statusCode: 0, headers: {}, body: null };
  out.setHeader = (key, value) => {
    out.headers[String(key).toLowerCase()] = value;
  };
  out.end = (text) => {
    out.body = text ? JSON.parse(text) : null;
  };
  return out;
}

function expressRes() {
  const out = { statusCode: 0, headers: {}, body: null };
  out.setHeader = (key, value) => {
    out.headers[String(key).toLowerCase()] = value;
  };
  out.status = (code) => {
    out.statusCode = code;
    return out;
  };
  out.json = (payload) => {
    out.body = payload;
    return out;
  };
  return out;
}

const source = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");

// ---------------------------------------------------------------- chainNative / defaultEvmChain

test("chainNative: 6281971 is DogeOS with DOGE, never Robinhood or BNB", () => {
  assert.equal(isDogeosChainId(DOGEOS), true);
  assert.equal(isDogeosChainId("6281971"), true);
  assert.equal(isDogeosChainId(46630), false);
  assert.equal(isDogeosChainId(97), false);
  assert.equal(nativeSymbolFor(DOGEOS), "DOGE");
  assert.equal(isRobinhoodChainId(DOGEOS), false, "6281971 must never join isRobinhoodChainId");
  assert.equal(isBnbChainId(DOGEOS), false);
});

test("chainNative: existing chains unchanged (before/after table)", () => {
  const table = [
    [56, "BNB", false, true],
    [97, "BNB", false, true],
    [101, "SOL", false, false],
    [4663, "ETH", true, false],
    [46630, "ETH", true, false],
  ];
  for (const [id, symbol, robinhood, bnb] of table) {
    assert.equal(nativeSymbolFor(id), symbol, `symbol ${id}`);
    assert.equal(isRobinhoodChainId(id), robinhood, `robinhood ${id}`);
    assert.equal(isBnbChainId(id), bnb, `bnb ${id}`);
    assert.equal(isDogeosChainId(id), false, `dogeos ${id}`);
  }
  assert.throws(() => nativeSymbolFor(102), /Legacy Solana/);
  assert.throws(() => nativeSymbolFor(1), /Unsupported current application chain/);
});

test("defaultEvmChainId accepts 6281971; existing answers unchanged", async () => {
  const table = [
    [String(DOGEOS), DOGEOS],
    ["56", 56],
    ["97", 97],
    ["4663", 4663],
    ["46630", 46630],
    ["31337", 56],
    ["1", 56],
  ];
  for (const [value, expected] of table) {
    await withEnv({ DEFAULT_EVM_CHAIN_ID: value }, () => assert.equal(defaultEvmChainId(), expected, `DEFAULT_EVM_CHAIN_ID=${value}`));
  }
  await withEnv({}, () => assert.equal(defaultEvmChainId(), 56));
});

// ---------------------------------------------------------------- server read provider

test("getRpcUrls(6281971): DogeOS env first, DogeOS public RPC last, never a BSC URL", async () => {
  await withEnv(
    {
      ...BSC_SENTINELS,
      DOGEOS_RPC_HTTP_6281971: "https://dogeos-managed.example,https://dogeos-managed-2.example",
      EVM_RPC_HTTP_6281971: "https://dogeos-evm.example",
      VITE_PUBLIC_RPC_6281971: "https://dogeos-vite.example",
    },
    () => {
      const urls = getRpcUrls(DOGEOS);
      assert.deepEqual(urls, [
        "https://dogeos-managed.example",
        "https://dogeos-managed-2.example",
        "https://dogeos-evm.example",
        "https://dogeos-vite.example",
        DOGEOS_PUBLIC_RPC,
      ]);
      for (const url of urls) assert.doesNotMatch(url, /bsc|binance/i, `BSC URL leaked into 6281971: ${url}`);
    },
  );
  await withEnv(BSC_SENTINELS, () => assert.deepEqual(getRpcUrls(DOGEOS), [DOGEOS_PUBLIC_RPC]));
});

test("getRpcUrls: existing chains unchanged (before/after table)", async () => {
  await withEnv(
    {
      ...BSC_SENTINELS,
      ROBINHOOD_RPC_HTTP_46630: "https://rh-46630.example",
      ROBINHOOD_TESTNET_RPC_URL: "https://rh-testnet-url.example",
      ROBINHOOD_RPC_HTTP_4663: "https://rh-4663.example",
      ROBINHOOD_MAINNET_RPC_URL: "https://rh-mainnet-url.example",
    },
    () => {
      assert.deepEqual(getRpcUrls(56), [
        "https://bsc-sentinel-56.example",
        "https://bsc-sentinel-vite-mainnet.example",
        "https://bsc-sentinel-generic.example",
        "https://bsc-dataseed.binance.org",
        "https://bsc-dataseed1.binance.org",
        "https://bsc-dataseed2.binance.org",
      ]);
      assert.deepEqual(getRpcUrls(97), [
        "https://bsc-sentinel-97.example",
        "https://bsc-sentinel-vite-testnet.example",
        "https://bsc-sentinel-generic.example",
        "https://data-seed-prebsc-1-s1.binance.org:8545",
        "https://data-seed-prebsc-2-s1.binance.org:8545",
        "https://bsc-testnet.bnbchain.org",
      ]);
      assert.deepEqual(getRpcUrls(4663), ["https://rh-4663.example", "https://rh-mainnet-url.example", "https://rpc.mainnet.chain.robinhood.com"]);
      assert.deepEqual(getRpcUrls(46630), ["https://rh-46630.example", "https://rh-testnet-url.example", "https://rpc.testnet.chain.robinhood.com"]);
      // An unknown chain still gets the legacy generic BSC env (unchanged behaviour, not DogeOS).
      assert.deepEqual(getRpcUrls(12345), ["https://bsc-sentinel-generic.example"]);
    },
  );
});

test("getServerReadProvider(6281971) names the network dogeos-testnet", async () => {
  const rpc = await startRpc(DOGEOS);
  try {
    await withEnv({ DOGEOS_RPC_HTTP_6281971: rpc.url }, async () => {
      resetServerReadProviders();
      const provider = await getServerReadProvider(DOGEOS);
      const network = await provider.getNetwork();
      assert.equal(Number(network.chainId), DOGEOS);
      assert.equal(network.name, "dogeos-testnet");
      provider.destroy();
    });
  } finally {
    resetServerReadProviders();
    await rpc.close();
  }
});

// ---------------------------------------------------------------- rpc usage

test("rpcUsage.chainOfRpcUrl maps the DogeOS RPC to 6281971; existing chains unchanged", async () => {
  await withEnv({}, () => {
    assert.equal(chainOfRpcUrl(DOGEOS_PUBLIC_RPC), DOGEOS);
    assert.equal(chainOfRpcUrl(`${DOGEOS_PUBLIC_RPC}/some/path`), DOGEOS, "matched by host");
    assert.equal(chainOfRpcUrl("https://rpc.testnet.chain.robinhood.com"), 46630);
    assert.equal(chainOfRpcUrl("https://rpc.mainnet.chain.robinhood.com"), 4663);
    assert.equal(chainOfRpcUrl("https://bsc-dataseed.binance.org"), 56);
    assert.equal(chainOfRpcUrl("https://bsc-testnet.bnbchain.org"), 97);
    assert.equal(chainOfRpcUrl("https://unknown.example"), null);
  });
  const custom = (id) => (id === DOGEOS ? ["https://custom-dogeos.example"] : []);
  assert.equal(chainOfRpcUrl("https://custom-dogeos.example", custom), DOGEOS);
});

// ---------------------------------------------------------------- campaign progress

test("evmCampaignProgress RPC: 6281971 reads DogeOS env or the DogeOS public RPC, never BSC", async () => {
  await withEnv(BSC_SENTINELS, () => assert.equal(progressRpcUrl(DOGEOS), DOGEOS_PUBLIC_RPC));
  await withEnv({ ...BSC_SENTINELS, DOGEOS_RPC_HTTP_6281971: "https://a.example,https://b.example" }, () => {
    assert.equal(progressRpcUrl(DOGEOS), "https://a.example");
  });
  await withEnv({ ...BSC_SENTINELS, EVM_RPC_HTTP_6281971: "https://evm.example" }, () => {
    assert.equal(progressRpcUrl(DOGEOS), "https://evm.example");
  });
  // Before/after: existing chains.
  await withEnv(BSC_SENTINELS, () => {
    assert.equal(progressRpcUrl(56), "https://bsc-sentinel-56.example");
    assert.equal(progressRpcUrl(97), "https://bsc-sentinel-97.example");
    assert.equal(progressRpcUrl(46630), "https://rpc.testnet.chain.robinhood.com");
    assert.equal(progressRpcUrl(4663), "https://rpc.mainnet.chain.robinhood.com");
    assert.equal(progressRpcUrl(12345), "");
  });
});

test("withEvmBondingProgress: 6281971 uses USD-target semantics like 46630 (no native target read)", async () => {
  const callMap = {
    [selector("sold()")]: uint(25n),
    [selector("curveSupply()")]: uint(100n),
    [selector("graduationNativeTarget()")]: uint(1000n),
  };
  const dogeRpc = await startRpc(DOGEOS, { calls: callMap, balance: 900n });
  const bnbRpc = await startRpc(97, { calls: callMap, balance: 900n });
  try {
    await withEnv({ DOGEOS_RPC_HTTP_6281971: dogeRpc.url, BSC_RPC_HTTP_97: bnbRpc.url }, async () => {
      const items = [
        { chainId: DOGEOS, campaignAddress: "0x" + "d".repeat(40), isDexTrading: false, progressPct: 7 },
        { chainId: 97, campaignAddress: "0x" + "b".repeat(40), isDexTrading: false, progressPct: 7 },
      ];
      await withEvmBondingProgress(items);
      assert.equal(items[0].progressPct, 25, "DogeOS progress = sold / curveSupply");
      assert.ok(!dogeRpc.callSelectors().includes(selector("graduationNativeTarget()")), "DogeOS graduationTarget is USD: no native target read");
      assert.ok(!dogeRpc.callSelectors().includes(selector("graduationTarget()")));
      // Before/after: BNB still uses its native target (900 / 1000 = 90 %).
      assert.equal(items[1].progressPct, 90);
      assert.ok(bnbRpc.callSelectors().includes(selector("graduationNativeTarget()")));
    });
  } finally {
    await dogeRpc.close();
    await bnbRpc.close();
  }
});

// ---------------------------------------------------------------- notifications

test("notificationContract: 6281971 is its own dogeos family, staging, DOGE", () => {
  const { getChainById, normalizeChain, getNativeSymbol, resolveChainEnvironment, buildNotificationEnvelope, CHAIN_LABELS, NOTIFICATION_CHAINS } = notificationContract;
  assert.equal(getChainById(DOGEOS), "dogeos");
  assert.equal(normalizeChain(DOGEOS), "dogeos");
  assert.equal(normalizeChain("6281971"), "dogeos");
  assert.equal(normalizeChain("dogeos"), "dogeos");
  assert.equal(normalizeChain("dogeos-testnet"), "dogeos");
  assert.equal(getNativeSymbol("dogeos"), "DOGE");
  assert.equal(resolveChainEnvironment({ chainId: DOGEOS }), "staging");
  assert.ok(CHAIN_LABELS.includes("dogeos"));
  assert.ok(NOTIFICATION_CHAINS.includes("dogeos"));
  const envelope = buildNotificationEnvelope({ eventType: "campaign.created", chainId: DOGEOS, dedupKey: "k" });
  assert.equal(envelope.chain, "dogeos");
  assert.equal(envelope.environment, "staging");
});

test("notificationContract: existing chains unchanged (before/after table)", () => {
  const { normalizeChain, getNativeSymbol, resolveChainEnvironment } = notificationContract;
  const table = [
    [56, "bnb", "production", "BNB"],
    [97, "bnb", "staging", "BNB"],
    [101, "solana", "production", "SOL"],
    [102, "solana", "staging", "SOL"],
    [4663, "robinhood", "production", "ETH"],
    [46630, "robinhood", "staging", "ETH"],
  ];
  for (const [id, family, environment, symbol] of table) {
    assert.equal(normalizeChain(id), family, `family ${id}`);
    assert.equal(resolveChainEnvironment({ chainId: id }), environment, `env ${id}`);
    assert.equal(getNativeSymbol(family), symbol, `symbol ${id}`);
  }
  assert.equal(normalizeChain(1), null, "unknown chain fails closed");
});

test("notificationProducers: a DogeOS coin launch names DogeOS testnet", async () => {
  const sent = [];
  const pool = {
    query: async (text) => {
      if (/coalesce\(created_at_chain, created_at\)/.test(text)) {
        return {
          rows: [
            { chain_id: DOGEOS, campaign_address: "0xc1", token_address: "0xt1", creator_address: "0x" + "a".repeat(40), name: "Doge", symbol: "WOW" },
            { chain_id: 46630, campaign_address: "0xc2", token_address: "0xt2", creator_address: "0x" + "a".repeat(40), name: "Rh", symbol: "RH" },
          ],
        };
      }
      return { rows: [] };
    },
  };
  const notify = async (_pool, payload) => {
    sent.push(payload);
    return { inserted: true };
  };
  await scanCoinNotifications(pool, { notify, priceOf: async () => 1 });
  assert.equal(sent[0].body, "Your coin launched on DogeOS testnet. Trading is open.");
  assert.equal(sent[1].body, "Your coin launched on Robinhood testnet. Trading is open.");
});

// ---------------------------------------------------------------- reward claims

test("rewardClaimVerification: 6281971 is a reward chain, read through DogeOS RPC only", async () => {
  const args = {
    chainId: DOGEOS,
    txHash: "0x" + "1".repeat(64),
    walletAddress: "0x" + "a".repeat(40),
    distributorAddress: "0x" + "b".repeat(40),
    batchId: "0x" + "2".repeat(64),
    amount: "1",
  };
  // No DogeOS RPC env: refuses for a missing RPC (not an unsupported chain) and never borrows BSC.
  await withEnv(BSC_SENTINELS, async () => {
    await assert.rejects(verifyEvmRewardClaim(args), (error) => error.code === "CLAIM_RPC_UNAVAILABLE" && /chain 6281971/.test(error.message));
  });
  const rpc = await startRpc(DOGEOS);
  try {
    await withEnv({ ...BSC_SENTINELS, DOGEOS_RPC_HTTP_6281971: rpc.url }, async () => {
      await verifyEvmRewardClaim(args).catch(() => null);
      assert.ok(rpc.methods().includes("eth_getTransactionByHash"), "the claim tx is looked up on the DogeOS RPC");
    });
  } finally {
    await rpc.close();
  }
  // Before/after: an unsupported chain is still refused as such.
  await assert.rejects(verifyEvmRewardClaim({ ...args, chainId: 1 }), (error) => error.code === "UNSUPPORTED_CLAIM_CHAIN");
});

test("reward claim config (generic): 6281971 claims in DOGE with its own distributor; existing chains unchanged", async () => {
  const distributor = "0x" + "c".repeat(40);
  await withEnv({ REWARD_DISTRIBUTOR_ADDRESS_6281971: distributor }, async () => {
    const res = expressRes();
    await generic.rewardClaimConfig({ method: "GET", query: { chainId: String(DOGEOS) } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.config.tokenSymbol, "DOGE");
    assert.equal(res.body.config.enabled, true);
    assert.equal(res.body.config.distributorAddress, distributor);
    assert.ok(res.body.supportedChains.includes(DOGEOS));
    for (const [id, symbol] of [[56, "BNB"], [97, "BNB"], [4663, "ETH"], [46630, "ETH"], [101, "SOL"]]) {
      const r = expressRes();
      await generic.rewardClaimConfig({ method: "GET", query: { chainId: String(id) } }, r);
      assert.equal(r.body.config.tokenSymbol, symbol, `symbol ${id}`);
    }
  });
  assert.equal(generic.explorerTxBase(DOGEOS), "https://dogeos-testnet.l2scan.co/tx/");
  assert.equal(generic.explorerTxBase(46630), "https://explorer.testnet.chain.robinhood.com/tx/");
  assert.equal(generic.explorerTxBase(97), "https://testnet.bscscan.com/tx/");
});

test("reward claim config (generic): 6281971 never borrows the unsuffixed (BNB) distributor; others unchanged", async () => {
  const globalDistributor = "0x" + "9".repeat(40);
  const viteDistributor = "0x" + "8".repeat(40);
  for (const vars of [{ REWARD_DISTRIBUTOR_ADDRESS: globalDistributor }, { VITE_REWARD_DISTRIBUTOR_ADDRESS: viteDistributor }]) {
    await withEnv(vars, async () => {
      const res = expressRes();
      await generic.rewardClaimConfig({ method: "GET", query: { chainId: String(DOGEOS) } }, res);
      assert.equal(res.body.config.enabled, false);
      assert.equal(res.body.config.reason, "MISSING_DISTRIBUTOR_ADDRESS");
      assert.equal(res.body.config.distributorAddress, "");
      assert.equal(res.body.config.mode, "disabled");
      // Before/after: the unsuffixed global still applies to 56, 97 and 46630 exactly as today.
      const expected = vars.REWARD_DISTRIBUTOR_ADDRESS || vars.VITE_REWARD_DISTRIBUTOR_ADDRESS;
      for (const id of [56, 97, 46630]) {
        const r = expressRes();
        await generic.rewardClaimConfig({ method: "GET", query: { chainId: String(id) } }, r);
        assert.equal(r.body.config.enabled, true, `enabled ${id}`);
        assert.equal(r.body.config.distributorAddress, expected, `distributor ${id}`);
      }
    });
  }
});

test("reward claim config (closeout router): 6281971 passes through and is listed", async () => {
  const distributor = "0x" + "c".repeat(40);
  await withEnv({ REWARD_DISTRIBUTOR_ADDRESS_6281971: distributor }, async () => {
    const res = nodeRes();
    await closeout.rewardClaimConfig({ method: "GET", query: { chainId: String(DOGEOS) } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.config.tokenSymbol, "DOGE");
    const legacy = nodeRes();
    await closeout.rewardClaimConfig({ method: "GET", query: { chainId: "102" } }, legacy);
    assert.equal(legacy.statusCode, 400);
    assert.deepEqual(legacy.body.supportedChains, [56, 97, 4663, 46630, DOGEOS, 101]);
  });
  const text = source("../dev-fix/reward-claim-closeout-router.js");
  assert.match(text, /const EVM_CHAINS = new Set\(\[56, 97, 4663, 46630, 6281971\]\);/);
  assert.doesNotMatch(text, /supportedChains: \[56, 97, 4663, 46630, 101\]/, "every supportedChains list carries 6281971");
});

test("rewards reconcile accepts 6281971 as an EVM reward chain", async () => {
  const wallet = "0x" + "a".repeat(40);
  const res = nodeRes();
  await rewardsHandler({ method: "POST", body: { action: "reconcile-evm-claims", chainId: DOGEOS, walletAddress: wallet, rewardLedgerIds: [] } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.reconciledCount, 0);
  const refused = nodeRes();
  await rewardsHandler({ method: "POST", body: { action: "reconcile-evm-claims", chainId: 1, walletAddress: wallet, rewardLedgerIds: [] } }, refused);
  assert.equal(refused.statusCode, 400);
});

// ---------------------------------------------------------------- drafts, campaign state, feed SQL

test("draft EVM launch options include 6281971; existing chains unchanged", () => {
  for (const id of [56, 97, 4663, 46630, 31337, DOGEOS]) assert.ok(EVM_LAUNCH_OPTION_CHAIN_IDS.has(id), `chain ${id}`);
  assert.equal(EVM_LAUNCH_OPTION_CHAIN_IDS.has(101), false);
  assert.equal(wantsEvmLaunchOptions({ feeChoice: 1 }, DOGEOS), true);
});

test("evmCampaignState accepts 6281971; unknown chains still refused", async () => {
  const campaign = "0x" + "e".repeat(40);
  const deps = { getProvider: async () => ({}), readState: async () => ({ supported: true }) };
  const res = nodeRes();
  await evmCampaignStateHandler({ method: "GET", url: `/api/evm/campaign-state?chainId=${DOGEOS}&campaign=${campaign}` }, res, deps);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.chainId, DOGEOS);
  const refused = nodeRes();
  await evmCampaignStateHandler({ method: "GET", url: `/api/evm/campaign-state?chainId=1&campaign=${campaign}` }, refused, deps);
  assert.equal(refused.statusCode, 400);
  assert.match(refused.body.error, /6281971/);
});

test("campaigns-base EVM fee and gen-6 supply SQL include 6281971", () => {
  const text = source("../campaigns-base.js");
  assert.match(text, /when t\.chain_id in \(56, 97, 4663, 46630, 6281971\) and t\.fee_raw is not null/);
  assert.match(text, /when c\.chain_id in \(56, 97, 4663, 46630, 6281971\) and coalesce\(c\.factory_generation, 0\) >= 6/);
});

test("recruiter payouts keep 6281971 testnet rows out of payouts (both exclusions)", () => {
  const text = source("../dev-fix/recruiter-payouts.js");
  const matches = text.match(/coalesce\(chain_id, 0\) not in \(97, 102, 46630, 6281971\)/g) || [];
  assert.equal(matches.length, 2);
  assert.doesNotMatch(text, /not in \(97, 102, 46630\)/);
});

// ---------------------------------------------------------------- LP fees

test("lp-fees: 6281971 is testnet-open like 97/46630", async () => {
  for (const id of [97, 46630, DOGEOS]) {
    const auth = await lpFees.authorize({ url: `/api/dashboard/lp-fees?chainId=${id}`, headers: {} }, expressRes());
    assert.deepEqual(auth, { mode: "testnet-open" }, `chain ${id}`);
  }
});

test("lp-fees: 6281971 reads the V3 locker in DOGE and never borrows the BNB generic locker", async () => {
  const locker = "0x" + "1".repeat(40);
  const v3Factory = "0x" + "2".repeat(40);
  const router = "0x" + "3".repeat(40);
  const callMap = {
    [selector("v3Factory()")]: addr(v3Factory),
    [selector("treasuryRouter()")]: addr(router),
  };
  // Only the unsuffixed (BNB) locker set: DogeOS must not use it.
  await withEnv({ LP_LOCKER_ADDRESS: locker }, async () => {
    const { status, body } = await lpFees.lpFeesPayload({ chainId: String(DOGEOS) }, { mode: "testnet-open" });
    assert.equal(status, 200);
    assert.equal(body.lockerAddress, null);
  });
  const dogeRpc = await startRpc(DOGEOS, { calls: callMap });
  const rhRpc = await startRpc(46630, { calls: callMap });
  try {
    await withEnv(
      {
        LP_LOCKER_ADDRESS_6281971: locker,
        LP_LOCKER_ADDRESS_46630: locker,
        DOGEOS_RPC_HTTP_6281971: dogeRpc.url,
        ROBINHOOD_RPC_HTTP_46630: rhRpc.url,
      },
      async () => {
        resetServerReadProviders();
        const doge = await lpFees.lpFeesPayload({ chainId: String(DOGEOS) }, { mode: "testnet-open" });
        assert.equal(doge.status, 200, JSON.stringify(doge.body));
        assert.equal(doge.body.dex, "robinhood_v3");
        assert.equal(doge.body.nativeSymbol, "DOGE");
        assert.equal(doge.body.v3Factory, v3Factory);
        assert.ok(dogeRpc.callSelectors().includes(selector("v3Factory()")), "V3 locker ABI used");
        assert.ok(!dogeRpc.callSelectors().includes(selector("topazFactory()")));
        // Before/after: Robinhood testnet unchanged.
        const rh = await lpFees.lpFeesPayload({ chainId: "46630" }, { mode: "testnet-open" });
        assert.equal(rh.body.dex, "robinhood_v3");
        assert.equal(rh.body.nativeSymbol, "ETH");
      },
    );
  } finally {
    resetServerReadProviders();
    await dogeRpc.close();
    await rhRpc.close();
  }
});
