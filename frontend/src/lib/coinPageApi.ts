/**
 * Coin page data (UI redesign phase 1b): owner, coin page fields, posts written as the coin and
 * auto updates. Talks only to the new /api/coin-page routes.
 */
import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/apiBase";
import { appendAuthToSearchParams, signWalletAction, type WalletActionAuthPayload } from "@/lib/walletActionAuth";
import { signSolanaMessage } from "@/lib/solanaWallet";
import { isSolanaChainId } from "@/lib/chainConfig";
import { useWallet } from "@/contexts/WalletContext";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";

export type CoinPageProfile = {
  bannerUrl: string | null;
  /** Vertical focus of the banner in percent (0 top, 50 centre, 100 bottom); null = centre. */
  bannerPositionY: number | null;
  bio: string | null;
  founderNote: string | null;
  websiteUrl: string | null;
  xUrl: string | null;
  telegramUrl: string | null;
  discordUrl: string | null;
  tags: string[];
  pinnedPostId: string | null;
  shareUpdatesToFeed: boolean;
  showAutoUpdates: boolean;
  sectionImages: Record<string, string>;
  updatedAt: string | null;
};

export type CoinPost = { id: string; kind: "post"; at: string; body: string; mediaUrl: string | null; shareToFeed: boolean };
export type CoinAutoUpdate = { id: string; kind: "launch" | "graduation" | "battle"; at: string; text: string; battleId?: string; won?: boolean };

export type CoinPageData = {
  owner: { wallet: string; origin: "launched" | "imported"; token: string } | null;
  profile: CoinPageProfile;
  posts: CoinPost[];
  autoUpdates: CoinAutoUpdate[];
  /** The Story's own text as stored (POST /api/story/profile replaces both fields on save). */
  storyText: { shortStory: string | null; sections: Record<string, string> };
};

export type CoinProfileInput = Partial<{
  bannerUrl: string;
  bannerPositionY: number | null;
  bio: string;
  founderNote: string;
  websiteUrl: string;
  xUrl: string;
  telegramUrl: string;
  discordUrl: string;
  tags: string[] | string;
  pinnedPostId: string | null;
  shareUpdatesToFeed: boolean;
  showAutoUpdates: boolean;
  sectionImages: Record<string, string>;
}>;

type FeedSessionRunner = <T>(fn: (token: string) => Promise<T>) => Promise<T>;

export const coinPageKey = (chainId: number, token: string) => ["coin-page", Number(chainId), String(token || "")];

async function readJsonOrThrow(res: Response) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(String(data?.error || `Request failed (${res.status})`)), { code: data?.code, status: res.status });
  return data;
}

export async function fetchCoinPage(chainId: number, token: string): Promise<CoinPageData> {
  const qs = new URLSearchParams({ chainId: String(chainId), token: String(token) });
  return readJsonOrThrow(await apiFetch(`/api/coin-page?${qs.toString()}`));
}

/** Shared by the banner, the Edit button, the links and the Posts tab: one request per coin. */
export function useCoinPage(chainId: number | null | undefined, token: string | null | undefined) {
  const id = Number(chainId || 0);
  const t = String(token || "");
  return useQuery({
    queryKey: coinPageKey(id, t),
    queryFn: () => fetchCoinPage(id, t),
    enabled: Boolean(id && t),
    staleTime: 30_000,
    // A 404 means the route is not deployed: no retries, and no new attempt each time a tab mounts.
    retry: (count, error: any) => error?.status !== 404 && count < 1,
    retryOnMount: false,
  });
}

/** The connected wallet for this coin's chain, whether it owns the coin page, and a signer for it. */
export function useCoinOwnerSigner(chainId: number, ownerWallet: string | null | undefined) {
  const wallet = useWallet();
  const { solanaAccount, isSolanaConnected } = useSolanaWallet();
  const solana = isSolanaChainId(chainId);
  const viewer = solana ? (isSolanaConnected ? String(solanaAccount || "") : "") : String(wallet.account || "");
  const isOwner = Boolean(
    viewer && ownerWallet && (solana ? viewer === ownerWallet : viewer.toLowerCase() === String(ownerWallet).toLowerCase()),
  );

  const sign = useCallback(
    async (action: string, extraLines: string[]): Promise<WalletActionAuthPayload> => {
      if (!viewer) throw new Error("Connect the coin owner's wallet first.");
      if (solana) {
        return signWalletAction({
          action,
          walletAddress: viewer,
          chainId,
          extraLines,
          walletType: "solana",
          signMessage: async (message) => (await signSolanaMessage(message, viewer)).signature,
        });
      }
      return signWalletAction({ action, walletAddress: viewer, chainId, extraLines, signer: wallet.signer as any });
    },
    [viewer, solana, chainId, wallet.signer],
  );

  return useMemo(() => ({ viewer, isOwner, sign }), [viewer, isOwner, sign]);
}

export function useCoinPageMutations(chainId: number, token: string, ownerToken: string | null | undefined) {
  const client = useQueryClient();
  const key = coinPageKey(chainId, token);
  const signedToken = String(ownerToken || token);
  const refresh = useCallback(() => client.invalidateQueries({ queryKey: key }), [client, key]);

  const saveProfile = useCallback(
    async (sign: (a: string, l: string[]) => Promise<WalletActionAuthPayload>, profile: CoinProfileInput) => {
      const auth = await sign("coin_page_profile_update", [`Token: ${signedToken}`]);
      const data = await readJsonOrThrow(
        await apiFetch("/api/coin-page/profile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chainId, token: signedToken, profile, auth }),
        }),
      );
      await refresh();
      return data.profile as CoinPageProfile;
    },
    [chainId, signedToken, refresh],
  );

  // `session` is the owner's feed session (one signature per 30 days, founder 2026-10-03). When given,
  // creator updates, their image and deleting them need no signature of their own.
  const createPost = useCallback(
    async (sign: (a: string, l: string[]) => Promise<WalletActionAuthPayload>, post: { body: string; mediaUrl?: string | null; shareToFeed?: boolean }, session?: FeedSessionRunner) => {
      if (session) {
        const data = await session(async (token) =>
          readJsonOrThrow(
            await apiFetch("/api/coin-page/posts", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
              body: JSON.stringify({ chainId, token: signedToken, post }),
            }),
          ),
        );
        await refresh();
        return data.post as CoinPost;
      }
      const auth = await sign("coin_post_create", [`Token: ${signedToken}`]);
      const data = await readJsonOrThrow(
        await apiFetch("/api/coin-page/posts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chainId, token: signedToken, post, auth }),
        }),
      );
      await refresh();
      return data.post as CoinPost;
    },
    [chainId, signedToken, refresh],
  );

  const deletePost = useCallback(
    async (sign: (a: string, l: string[]) => Promise<WalletActionAuthPayload>, postId: string, session?: FeedSessionRunner) => {
      if (session) {
        await session(async (token) =>
          readJsonOrThrow(
            await apiFetch(`/api/coin-page/posts/${encodeURIComponent(postId)}/delete`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
              body: JSON.stringify({ chainId, token: signedToken }),
            }),
          ),
        );
        await refresh();
        return;
      }
      const auth = await sign("coin_post_delete", [`Token: ${signedToken}`, `PostId: ${postId}`]);
      await readJsonOrThrow(
        await apiFetch(`/api/coin-page/posts/${encodeURIComponent(postId)}/delete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chainId, token: signedToken, auth }),
        }),
      );
      await refresh();
    },
    [chainId, signedToken, refresh],
  );

  /** Uploads one image for `slot` ("banner" | "post" | "section:<key>") and returns its URL. */
  const uploadImage = useCallback(
    async (sign: (a: string, l: string[]) => Promise<WalletActionAuthPayload>, slot: string, file: File, session?: FeedSessionRunner) => {
      if (session && slot === "post") {
        const qs = new URLSearchParams({ chainId: String(chainId), token: signedToken, slot });
        const data = await session(async (token) => {
          const form = new FormData();
          form.append("file", file);
          return readJsonOrThrow(
            await apiFetch(`/api/coin-page/image?${qs.toString()}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form }),
          );
        });
        return String(data.url);
      }
      const auth = await sign("coin_page_image", [`Token: ${signedToken}`, `Slot: ${slot}`]);
      const qs = new URLSearchParams({ chainId: String(chainId), token: signedToken, slot });
      appendAuthToSearchParams(qs, auth);
      const form = new FormData();
      form.append("file", file);
      const data = await readJsonOrThrow(await apiFetch(`/api/coin-page/image?${qs.toString()}`, { method: "POST", body: form }));
      return String(data.url);
    },
    [chainId, signedToken],
  );

  return { saveProfile, createPost, deletePost, uploadImage, refresh };
}

/**
 * Saves the Story's full-story boxes (and an imported coin's short story) through the existing
 * POST /api/story/profile, unchanged. That endpoint replaces both fields, so callers pass every box.
 */
export async function saveStoryText(
  sign: (a: string, l: string[]) => Promise<WalletActionAuthPayload>,
  input: { chainId: number; token: string; shortStory: string; sections: Record<string, string> },
) {
  const auth = await sign("story_profile_update", [`Token: ${input.token}`]);
  return readJsonOrThrow(
    await apiFetch("/api/story/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chainId: input.chainId, token: input.token, shortStory: input.shortStory, sections: input.sections, auth }),
    }),
  );
}
