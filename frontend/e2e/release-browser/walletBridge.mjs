/**
 * Real wallets for the release browser test. The page gets an EIP-1193 provider and a Phantom-like
 * Solana provider; every request is answered in Node, where the throwaway keys live. Keys never enter
 * the page. Every send is guarded: EVM only on 46630 / 97 (chain id read from the RPC, not trusted
 * from the page), Solana only when the RPC reports the devnet genesis hash.
 */
import { ethers } from "ethers";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";

export const TEST_EVM_CHAINS = new Set([46630, 97]);
export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export function makeEvmBackend({ privateKey, rpcByChain, initialChainId, log = () => {} }) {
  const providers = new Map();
  const verified = new Map();
  let chainId = Number(initialChainId);
  const wallet = new ethers.Wallet(privateKey);

  async function provider(id) {
    if (!TEST_EVM_CHAINS.has(Number(id))) throw Object.assign(new Error(`chain ${id} refused: test chains only`), { code: 4902 });
    if (!providers.has(id)) {
      const p = new ethers.JsonRpcProvider(rpcByChain[id], undefined, { staticNetwork: true, batchMaxCount: 1 });
      providers.set(id, p);
    }
    const p = providers.get(id);
    if (!verified.get(id)) {
      const reported = Number(await p.send("eth_chainId", []));
      if (reported !== Number(id) || !TEST_EVM_CHAINS.has(reported)) throw new Error(`RPC for ${id} reports chain ${reported}: refused`);
      verified.set(id, true);
    }
    return p;
  }

  const sent = [];
  async function handle(method, params = []) {
    switch (method) {
      case "eth_requestAccounts":
      case "eth_accounts":
        return [wallet.address];
      case "eth_chainId":
        return ethers.toQuantity(chainId);
      case "net_version":
        return String(chainId);
      case "wallet_switchEthereumChain": {
        const next = Number(params?.[0]?.chainId);
        if (!TEST_EVM_CHAINS.has(next)) throw Object.assign(new Error(`Unrecognized chain ${next} (test wallet: 46630 / 97 only)`), { code: 4902 });
        await provider(next);
        chainId = next;
        return { __chainChanged: ethers.toQuantity(next) };
      }
      case "wallet_addEthereumChain":
        return null;
      case "wallet_getPermissions":
      case "wallet_requestPermissions":
        return [{ parentCapability: "eth_accounts" }];
      case "personal_sign": {
        const [a, b] = params;
        const data = ethers.isAddress(a) && !ethers.isAddress(b) ? b : a;
        const bytes = ethers.isHexString(data) ? ethers.getBytes(data) : ethers.toUtf8Bytes(String(data));
        return wallet.signMessage(bytes);
      }
      case "eth_signTypedData_v4": {
        const typed = typeof params[1] === "string" ? JSON.parse(params[1]) : params[1];
        const domainChain = Number(typed?.domain?.chainId ?? chainId);
        if (!TEST_EVM_CHAINS.has(domainChain)) throw new Error(`typed data for chain ${domainChain} refused`);
        const types = { ...typed.types };
        delete types.EIP712Domain;
        return wallet.signTypedData(typed.domain, types, typed.message);
      }
      case "eth_sendTransaction": {
        const p = await provider(chainId);
        const reported = Number(await p.send("eth_chainId", []));
        if (reported !== chainId || !TEST_EVM_CHAINS.has(reported)) throw new Error(`send refused: RPC chain ${reported}`);
        const tx = params[0] || {};
        const signer = wallet.connect(p);
        const req = { to: tx.to, data: tx.data || tx.input, value: tx.value ? BigInt(tx.value) : 0n, chainId: BigInt(chainId) };
        if (tx.gas || tx.gasLimit) req.gasLimit = BigInt(tx.gas || tx.gasLimit);
        const res = await signer.sendTransaction(req);
        sent.push({ chainId, hash: res.hash, to: tx.to, value: String(req.value) });
        log(`[evm-wallet] ${wallet.address} sent ${res.hash} on ${chainId}`);
        return res.hash;
      }
      default: {
        const p = await provider(chainId);
        return p.send(method, params || []);
      }
    }
  }
  return { address: wallet.address, handle, sent, get chainId() { return chainId; } };
}

export async function installEvmWallet(page, backend) {
  await page.exposeFunction("__mwzEvmRpc", async (method, paramsJson) => {
    try {
      const result = await backend.handle(method, paramsJson ? JSON.parse(paramsJson) : []);
      return JSON.stringify({ ok: true, result: result === undefined ? null : result });
    } catch (error) {
      return JSON.stringify({ ok: false, code: error?.code ?? 4001, message: String(error?.shortMessage || error?.message || error), data: error?.data ?? error?.info?.error?.data });
    }
  });
  await page.addInitScript(({ address, chainHex }) => {
    const listeners = new Map();
    const emit = (name, payload) => (listeners.get(name) || []).slice().forEach((fn) => { try { fn(payload); } catch {} });
    let currentChain = chainHex;
    const provider = {
      isMetaMask: true,
      _isMwzReleaseTest: true,
      selectedAddress: address,
      get chainId() { return currentChain; },
      isConnected: () => true,
      async request({ method, params }) {
        const raw = await window.__mwzEvmRpc(method, JSON.stringify(params ?? [], (_k, v) => (typeof v === "bigint" ? "0x" + v.toString(16) : v)));
        const out = JSON.parse(raw);
        if (!out.ok) {
          const err = new Error(out.message);
          err.code = out.code;
          if (out.data) err.data = out.data;
          throw err;
        }
        if (out.result && out.result.__chainChanged) {
          currentChain = out.result.__chainChanged;
          setTimeout(() => emit("chainChanged", currentChain), 0);
          return null;
        }
        if (method === "eth_requestAccounts") setTimeout(() => { emit("connect", { chainId: currentChain }); emit("accountsChanged", [address]); }, 0);
        return out.result;
      },
      send(methodOrPayload, params) {
        if (typeof methodOrPayload === "string") return this.request({ method: methodOrPayload, params });
        return this.request(methodOrPayload);
      },
      enable() { return this.request({ method: "eth_requestAccounts" }); },
      on(name, fn) { listeners.set(name, [...(listeners.get(name) || []), fn]); return provider; },
      removeListener(name, fn) { listeners.set(name, (listeners.get(name) || []).filter((f) => f !== fn)); return provider; },
      off(name, fn) { return provider.removeListener(name, fn); },
    };
    window.ethereum = provider;
    const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
      detail: Object.freeze({ info: { uuid: "mwz-release-test-metamask", name: "MetaMask", icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>", rdns: "io.metamask" }, provider }),
    }));
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
  }, { address: backend.address, chainHex: "0x" + Number(backend.chainId).toString(16) });
}

export async function makeSolanaBackend({ secretKey, rpcUrl, log = () => {} }) {
  const keypair = Keypair.fromSecretKey(Uint8Array.from(secretKey));
  const connection = new Connection(rpcUrl, "confirmed");
  const genesis = await connection.getGenesisHash();
  if (genesis !== DEVNET_GENESIS) throw new Error(`Solana RPC genesis ${genesis} is not devnet: refused`);
  const sent = [];
  return {
    address: keypair.publicKey.toBase58(),
    connection,
    sent,
    sign(messageB64) {
      const msg = Buffer.from(messageB64, "base64");
      return Buffer.from(ed25519.sign(msg, keypair.secretKey.slice(0, 32))).toString("base64");
    },
    async sendRaw(txB64) {
      if ((await connection.getGenesisHash()) !== DEVNET_GENESIS) throw new Error("send refused: not devnet");
      const sig = await connection.sendRawTransaction(Buffer.from(txB64, "base64"), { skipPreflight: false });
      sent.push(sig);
      log(`[sol-wallet] ${keypair.publicKey.toBase58()} sent ${sig}`);
      return sig;
    },
  };
}

export async function installSolanaWallet(page, backend) {
  await page.exposeFunction("__mwzSolSign", (b64) => backend.sign(b64));
  await page.exposeFunction("__mwzSolSendRaw", (b64) => backend.sendRaw(b64));
  await page.addInitScript(({ address }) => {
    const ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    const b58decode = (s) => {
      let bytes = [0];
      for (const c of s) {
        let carry = ALPHA.indexOf(c);
        if (carry < 0) throw new Error("bad base58");
        for (let j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 0xff; carry >>= 8; }
        while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
      }
      for (const c of s) { if (c === "1") bytes.push(0); else break; }
      return Uint8Array.from(bytes.reverse());
    };
    const toB64 = (u8) => { let s = ""; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };
    const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const pkBytes = b58decode(address);
    const publicKey = {
      toBase58: () => address,
      toString: () => address,
      toJSON: () => address,
      toBytes: () => pkBytes.slice(),
      toBuffer: () => pkBytes.slice(),
      equals: (o) => String(o?.toBase58?.() ?? o) === address,
    };
    const listeners = new Map();
    const emit = (n, p) => (listeners.get(n) || []).forEach((f) => { try { f(p); } catch {} });
    const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
    async function signTx(tx) {
      if ("version" in tx && tx.message && typeof tx.message.serialize === "function") {
        const msg = tx.message.serialize();
        const sig = fromB64(await window.__mwzSolSign(toB64(msg)));
        const keys = tx.message.staticAccountKeys;
        const idx = keys.findIndex((k) => eq(Array.from(k.toBytes()), Array.from(pkBytes)));
        if (idx < 0 || idx >= tx.message.header.numRequiredSignatures) throw new Error("test wallet is not a signer of this transaction");
        tx.signatures[idx] = sig;
        return tx;
      }
      const msg = tx.serializeMessage();
      const sig = fromB64(await window.__mwzSolSign(toB64(msg)));
      const entry = tx.signatures.find((s) => s.publicKey.toBase58() === address);
      if (!entry) throw new Error("test wallet is not a signer of this transaction");
      tx.addSignature(entry.publicKey, sig);
      return tx;
    }
    const serialize = (tx) => ("version" in tx ? tx.serialize() : tx.serialize({ requireAllSignatures: false, verifySignatures: false }));
    const solana = {
      isPhantom: true,
      isConnected: false,
      publicKey: null,
      _isMwzReleaseTest: true,
      async connect() { solana.isConnected = true; solana.publicKey = publicKey; setTimeout(() => emit("connect", publicKey), 0); return { publicKey }; },
      async disconnect() { solana.isConnected = false; solana.publicKey = null; emit("disconnect"); },
      signTransaction: signTx,
      async signAllTransactions(txs) { const out = []; for (const t of txs) out.push(await signTx(t)); return out; },
      async signAndSendTransaction(tx) { await signTx(tx); const signature = await window.__mwzSolSendRaw(toB64(serialize(tx))); return { signature, publicKey }; },
      async signMessage(message) { const u8 = message instanceof Uint8Array ? message : new TextEncoder().encode(String(message)); const signature = fromB64(await window.__mwzSolSign(toB64(u8))); return { signature, publicKey }; },
      on(n, f) { listeners.set(n, [...(listeners.get(n) || []), f]); },
      off(n, f) { listeners.set(n, (listeners.get(n) || []).filter((x) => x !== f)); },
      removeListener(n, f) { solana.off(n, f); },
      request: async ({ method }) => { if (method === "connect") return solana.connect(); throw new Error(`unsupported ${method}`); },
    };
    window.phantom = { solana };
    window.solana = solana;
  }, { address: backend.address });
}
