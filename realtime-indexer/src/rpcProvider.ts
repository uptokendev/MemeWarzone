import { ethers, FetchRequest, Network } from "ethers";
import { countRpcRequest, hookEthersRpcCounter } from "./rpcUsage.js";

// Count every JSON-RPC request this process sends (by chain and method; never the URL).
hookEthersRpcCounter();

/**
 * Shared JSON-RPC helpers for BSC indexers.
 *
 * CRITICAL (ethers v6):
 *   new JsonRpcProvider(url, undefined, { staticNetwork: true })
 * does NOT pin the network. `#network` stays null, so `_start()` loops forever:
 *   "JsonRpcProvider failed to detect network and cannot start up; retry in 1s"
 *
 * Always pass an explicit Network (or chainId) AND set staticNetwork to that
 * Network object (not the boolean true alone with a missing network arg).
 */

export function parseRpcList(value: string | undefined | null): string[] {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function networkFor(chainId: number): Network {
  const id = Number(chainId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`Invalid chainId for static JSON-RPC provider: ${chainId}`);
  }
  const network = Network.from(id);
  if (id === 56) network.name = "bnb";
  else if (id === 97) network.name = "bnbt";
  return network;
}

/**
 * Build a provider that never auto-detects the network.
 * A dead RPC will fail individual calls; it will NOT spin detect-network retries.
 */
export function createStaticJsonRpcProvider(
  rpcUrl: string,
  chainId: number,
  options?: { timeoutMs?: number },
): ethers.JsonRpcProvider {
  const url = String(rpcUrl || "").trim();
  if (!url) throw new Error("RPC URL is empty");

  const envDefault = Number(process.env.RPC_REQUEST_TIMEOUT_MS || 30_000);
  const timeoutMs = Math.max(5_000, Number(options?.timeoutMs ?? envDefault));
  const network = networkFor(chainId);

  const request = new FetchRequest(url);
  request.timeout = timeoutMs;
  try {
    request.setHeader("content-type", "application/json");
    request.setHeader("accept", "application/json");
  } catch {
    // ignore
  }

  // Use Network object for BOTH the network arg and staticNetwork option.
  // Boolean `staticNetwork: true` only pins when network arg is non-null; the
  // Network form always assigns #network in ethers v6.
  const provider = new ethers.JsonRpcProvider(request, network, {
    staticNetwork: network,
    batchMaxCount: 1,
    batchStallTime: 0,
  });

  // Fail closed if a future ethers change leaves network unpinned.
  try {
    // _network throws NETWORK_ERROR when #network is still null.
    void (provider as any)._network;
  } catch {
    provider.destroy();
    throw new Error(
      `Failed to pin static network for chain ${chainId} (ethers would enter detect-network retry loop)`,
    );
  }

  return provider;
}

export type RpcProbeResult = {
  url: string;
  ok: boolean;
  chainId?: number;
  headBlock?: number;
  error?: string;
  durationMs: number;
};

/** Cheap JSON-RPC call with AbortSignal (no ethers). Used by /api/indexer/status. */
export async function rawRpcCall(
  rpcUrl: string,
  method: string,
  params: unknown[] = [],
  timeoutMs = 5_000,
  chainId: number | null = null,
): Promise<unknown> {
  countRpcRequest(chainId ?? "unknown", method);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, timeoutMs));
  try {
    const resp = await fetch(rpcUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      if (/origin not allowed/i.test(text)) {
        throw new Error("Origin not allowed (RPC key allowlist rejects this client)");
      }
      throw new Error(`HTTP ${resp.status}${text ? `: ${text.slice(0, 160)}` : ""}`);
    }
    const body: any = await resp.json();
    if (body?.error) {
      const msg = body.error?.message || JSON.stringify(body.error);
      if (/origin not allowed/i.test(String(msg))) {
        throw new Error("Origin not allowed (RPC key allowlist rejects this client)");
      }
      throw new Error(msg);
    }
    return body?.result ?? null;
  } finally {
    clearTimeout(timer);
  }
}

export async function probeRpcUrl(
  rpcUrl: string,
  expectedChainId: number,
  timeoutMs = 5_000,
): Promise<RpcProbeResult> {
  const started = Date.now();
  try {
    const [chainHex, blockHex] = await Promise.all([
      rawRpcCall(rpcUrl, "eth_chainId", [], timeoutMs, expectedChainId),
      rawRpcCall(rpcUrl, "eth_blockNumber", [], timeoutMs, expectedChainId),
    ]);
    const chainId =
      typeof chainHex === "string" && chainHex.startsWith("0x") ? parseInt(chainHex, 16) : NaN;
    const headBlock =
      typeof blockHex === "string" && blockHex.startsWith("0x") ? parseInt(blockHex, 16) : NaN;
    if (!Number.isFinite(chainId) || chainId !== expectedChainId) {
      return {
        url: rpcUrl,
        ok: false,
        chainId: Number.isFinite(chainId) ? chainId : undefined,
        error: `chainId mismatch (got ${chainId}, expected ${expectedChainId})`,
        durationMs: Date.now() - started,
      };
    }
    if (!Number.isFinite(headBlock)) {
      return {
        url: rpcUrl,
        ok: false,
        chainId,
        error: "invalid eth_blockNumber",
        durationMs: Date.now() - started,
      };
    }
    return {
      url: rpcUrl,
      ok: true,
      chainId,
      headBlock,
      durationMs: Date.now() - started,
    };
  } catch (error: any) {
    return {
      url: rpcUrl,
      ok: false,
      error: error?.name === "AbortError" ? "timeout" : error?.message || String(error),
      durationMs: Date.now() - started,
    };
  }
}

/**
 * Pick the first working RPC from a CSV/list and return a static provider.
 * Throws only after all candidates fail.
 */
export async function createWorkingProvider(
  rpcUrls: string[],
  chainId: number,
  options?: { timeoutMs?: number; label?: string },
): Promise<{ provider: ethers.JsonRpcProvider; url: string; headBlock: number }> {
  const urls = rpcUrls.map((u) => String(u || "").trim()).filter(Boolean);
  if (!urls.length) {
    throw new Error(`No RPC URLs configured${options?.label ? ` for ${options.label}` : ""}`);
  }

  const errors: string[] = [];
  for (const url of urls) {
    const probe = await probeRpcUrl(url, chainId, options?.timeoutMs ?? 8_000);
    if (!probe.ok || probe.headBlock == null) {
      errors.push(`${maskRpcUrl(url)}: ${probe.error || "probe failed"}`);
      continue;
    }
    const provider = createStaticJsonRpcProvider(url, chainId, {
      timeoutMs: options?.timeoutMs ?? 12_000,
    });
    return { provider, url, headBlock: probe.headBlock };
  }

  throw new Error(
    `All RPC endpoints failed${options?.label ? ` (${options.label})` : ""}: ${errors.join(" | ")}`,
  );
}

/**
 * Redact API keys from RPC URLs in logs and status output: scheme and host
 * only. Providers put the key in the path (Chainstack: one path segment,
 * Infura/Alchemy: /v3/<key>, BlockPI: /v1/rpc/<key>) or in the query, so
 * neither is ever shown.
 */
export function maskRpcUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const hidden = (parsed.pathname && parsed.pathname !== "/") || parsed.search || parsed.username || parsed.password;
    return `${parsed.protocol}//${parsed.host}${hidden ? "/…" : ""}`;
  } catch {
    return "rpc";
  }
}
