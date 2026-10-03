import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAblyWarRoomChannel } from "@/hooks/useAblyWarRoomChannel";
import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { getActiveWalletKind } from "@/lib/activeWalletChain";
import { isSolanaAddress } from "@/lib/address";
import { signSolanaMessage } from "@/lib/solanaWallet";
import { useFeedSession } from "@/hooks/useFeedSession";
import {
  buildChatSessionMessage,
  fetchWarRoomHistory,
  joinWarRoom,
  joinWarRoomWithFeedSession,
  sendWarRoomMessage,
  type ChatMessage,
  type ChatSession,
  getNonce,
} from "@/lib/chatApi";

const FALLBACK_POLL_MS = 8000;
const RECONCILE_POLL_MS = 30000;

function normalizeViewer(value?: string | null) {
  const raw = String(value ?? "").trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(raw)) return raw.toLowerCase();
  if (isSolanaAddress(raw)) return raw;
  return "";
}

function sessionStorageKey(chainId: number, campaignAddress: string, walletAddress: string) {
  const walletKey = /^0x[a-fA-F0-9]{40}$/i.test(walletAddress) ? walletAddress.toLowerCase() : walletAddress;
  return `mwz:warroom:session:${chainId}:${campaignAddress.toLowerCase()}:${walletKey}`;
}

function readStoredSession(chainId: number, campaignAddress: string, walletAddress: string): ChatSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(sessionStorageKey(chainId, campaignAddress, walletAddress));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.sessionToken || !parsed?.profile?.walletAddress) return null;
    if (normalizeViewer(parsed.profile.walletAddress) !== normalizeViewer(walletAddress)) return null;
    if (!parsed.expiresAt || Date.now() > new Date(parsed.expiresAt).getTime()) return null;
    return parsed as ChatSession;
  } catch {
    return null;
  }
}

function writeStoredSession(chainId: number, campaignAddress: string, walletAddress: string, session: ChatSession | null) {
  if (typeof window === "undefined") return;
  const key = sessionStorageKey(chainId, campaignAddress, walletAddress);
  if (!session) {
    window.localStorage.removeItem(key);
    return;
  }
  window.localStorage.setItem(key, JSON.stringify(session));
}

function mergeMessages(prev: ChatMessage[], incoming: ChatMessage[]) {
  const map = new Map<string, ChatMessage>();
  for (const item of [...prev, ...incoming]) {
    const key = item.id ? `id:${item.id}` : item.clientNonce ? `nonce:${item.clientNonce}` : `${item.walletAddress}:${item.createdAt}:${item.message}`;
    const existing = map.get(key);
    map.set(key, { ...(existing || {}), ...item, pending: item.pending ?? existing?.pending, failed: item.failed ?? existing?.failed });
  }
  return Array.from(map.values()).sort((a, b) => a.id - b.id || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

export function useWarRoom(args: { chainId: number; campaignAddress: string; creatorAddress?: string | null; }) {
  const wallet = useWallet();
  const { solanaAccount, isSolanaConnected } = useSolanaWallet();
  const roomAddress = useMemo(() => normalizeViewer(args.campaignAddress), [args.campaignAddress]);
  const walletAddress = useMemo(() => {
    const evm = normalizeViewer(wallet.account);
    const solana = isSolanaConnected ? normalizeViewer(solanaAccount) : "";
    const kind = getActiveWalletKind();
    if (kind === "solana" && solana) return solana;
    if (kind === "bnb" && evm) return evm;
    return solana || evm;
  }, [isSolanaConnected, solanaAccount, wallet.account]);
  const isSolanaViewer = isSolanaAddress(walletAddress);
  const feedSession = useFeedSession();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<ChatSession | null>(null);
  const pollRef = useRef<number | null>(null);
const ably = useAblyWarRoomChannel({
  enabled: Boolean(roomAddress),
  chainId: args.chainId,
  campaignAddress: roomAddress,
});
  const refreshHistory = useCallback(async () => {
    if (!roomAddress) return;
    try {
      const data = await fetchWarRoomHistory({ chainId: args.chainId, campaignAddress: roomAddress, limit: 50 });
      setMessages((prev) => mergeMessages(prev, data.items));
      setError(null);
    } catch (e: any) {
      setError(e?.message || "Failed to load War Room");
    } finally {
      setLoading(false);
    }
  }, [args.chainId, roomAddress]);
useEffect(() => {
  if (!ably.channel) return;

  const onMessage = (msg: any) => {
    const item = msg?.data;
    if (!item) return;

    setMessages((prev) => mergeMessages(prev, [item]));
    setError(null);
  };

  try {
    ably.channel.subscribe("message:new", onMessage);
  } catch {
    return;
  }

  return () => {
    try {
      ably.channel.unsubscribe("message:new", onMessage);
    } catch {
      // ignore
    }
  };
}, [ably.channel]);
  useEffect(() => {
    setMessages([]);
    setLoading(true);
    void refreshHistory();
  }, [refreshHistory]);

  useEffect(() => {
    if (!walletAddress || !roomAddress) {
      setSession(null);
      return;
    }
    setSession(readStoredSession(args.chainId, roomAddress, walletAddress));
  }, [args.chainId, roomAddress, walletAddress]);

  useEffect(() => {
  if (pollRef.current) {
    window.clearInterval(pollRef.current);
    pollRef.current = null;
  }

  if (!roomAddress) return;

  const pollMs = ably.isConnected ? RECONCILE_POLL_MS : FALLBACK_POLL_MS;

  pollRef.current = window.setInterval(() => {
    void refreshHistory();
  }, pollMs);

  return () => {
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };
}, [refreshHistory, roomAddress, ably.isConnected]);

  const ensureSession = useCallback(async () => {
    if (!walletAddress) {
      throw new Error("Connect your wallet first");
    }
    if (!isSolanaViewer) {
      if (!wallet.isConnected || !wallet.signer) throw new Error("Connect your wallet first");
      const signerAddress = normalizeViewer(await wallet.signer.getAddress());
      if (signerAddress !== walletAddress) {
        throw new Error("Active signer does not match the selected wallet account");
      }
    }

    const existing = readStoredSession(args.chainId, roomAddress, walletAddress);
    if (existing) {
      setSession(existing);
      return existing;
    }

    setJoining(true);
    try {
      // One wallet signature per 30 days (founder, 2026-10-03): when the feed session's wallet is this
      // viewer, the room is joined on that session with no signature of its own.
      const solanaRoom = Number(args.chainId) === 101 || Number(args.chainId) === 102;
      if (normalizeViewer(feedSession.account) === walletAddress && solanaRoom === isSolanaViewer) {
        const viaFeed = await feedSession.withSession((token) =>
          joinWarRoomWithFeedSession({
            chainId: args.chainId,
            campaignAddress: roomAddress,
            creatorAddress: args.creatorAddress ?? undefined,
            token,
          }),
        );
        writeStoredSession(args.chainId, roomAddress, walletAddress, viaFeed);
        setSession(viaFeed);
        setError(null);
        return viaFeed;
      }
      const nonce = await getNonce(args.chainId, walletAddress);
      const msg = buildChatSessionMessage({
        chainId: args.chainId,
        address: walletAddress,
        campaignAddress: roomAddress,
        nonce,
      });
      const signature = isSolanaViewer
        ? (await signSolanaMessage(msg, walletAddress)).signature
        : await wallet.signer!.signMessage(msg);
      const nextSession = await joinWarRoom({
        chainId: args.chainId,
        campaignAddress: roomAddress,
        address: walletAddress,
        nonce,
        signature,
        creatorAddress: args.creatorAddress ?? undefined,
      });
      writeStoredSession(args.chainId, roomAddress, walletAddress, nextSession);
      setSession(nextSession);
      setError(null);
      return nextSession;
    } finally {
      setJoining(false);
    }
  }, [args.chainId, args.creatorAddress, feedSession, isSolanaViewer, roomAddress, wallet.isConnected, wallet.signer, walletAddress]);

  const postMessage = useCallback(async (text: string) => {
    const trimmed = String(text ?? "").trim();
    if (!trimmed) return;
    if (!walletAddress) {
      window.dispatchEvent(new CustomEvent("memewarzone:openWalletModal"));
      return;
    }

    const activeSession = await ensureSession();
    const clientNonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const optimistic: ChatMessage = {
      id: Number.MAX_SAFE_INTEGER - Math.floor(Math.random() * 100000),
      chainId: args.chainId,
      campaignAddress: roomAddress,
      walletAddress,
      displayName: activeSession.profile.displayName ?? null,
      avatarUrl: activeSession.profile.avatarUrl ?? null,
      role: activeSession.profile.role ?? "trader",
      message: trimmed,
      clientNonce,
      createdAt: new Date().toISOString(),
      pending: true,
      failed: false,
    };

    setMessages((prev) => mergeMessages(prev, [optimistic]));
    setPosting(true);
    try {
      const result = await sendWarRoomMessage({
        chainId: args.chainId,
        campaignAddress: roomAddress,
        message: trimmed,
        clientNonce,
        sessionToken: activeSession.sessionToken,
      });
      setMessages((prev) => mergeMessages(prev.filter((m) => m.clientNonce !== clientNonce), [{ ...result.item, pending: false, failed: false }]));
      setError(null);
    } catch (e: any) {
      const msg = e?.message || "Failed to send message";
      if (/session/i.test(msg)) {
        writeStoredSession(args.chainId, roomAddress, walletAddress, null);
        setSession(null);
      }
      setMessages((prev) => prev.map((m) => (m.clientNonce === clientNonce ? { ...m, pending: false, failed: true } : m)));
      setError(msg);
      throw e;
    } finally {
      setPosting(false);
    }
  }, [args.chainId, ensureSession, roomAddress, walletAddress]);

  return {
    messages,
    loading,
    joining,
    posting,
    error,
    isConnected: Boolean(walletAddress),
    walletAddress,
    hasSession: Boolean(session),
    joinRoom: ensureSession,
    postMessage,
    reload: refreshHistory,
  };
}
