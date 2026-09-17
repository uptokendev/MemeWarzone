import { apiFetch } from "@/lib/apiBase";
import { isSolanaChainId } from "@/lib/chainConfig";

const EVM_TX_RE = /^0x[a-fA-F0-9]{64}$/;
const SOLANA_TX_RE = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/;
const EVM_ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Best-effort: persist chain-discovered fills into the indexer book. */
export function notifyIndexerFills(input: {
  chainId: number;
  campaignAddress: string;
  txHashes: string[];
}) {
  const chainId = Number(input.chainId || 0);
  const campaign = String(input.campaignAddress || "").trim();
  const hashes = [...new Set((input.txHashes || []).map((value) => String(value || "").trim()).filter(Boolean))];
  if (!hashes.length) return;

  if (isSolanaChainId(chainId)) {
    if (!SOLANA_ADDR_RE.test(campaign)) return;
    const signatures = hashes.filter((value) => SOLANA_TX_RE.test(value)).slice(0, 12);
    if (!signatures.length) return;
    void apiFetch(`/api/token/${encodeURIComponent(campaign)}/ingest-tx?chainId=${chainId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chainId, signatures, txHash: signatures[0] }),
    }).catch(() => undefined);
    return;
  }

  if ((chainId !== 56 && chainId !== 97) || !EVM_ADDR_RE.test(campaign)) return;
  for (const txHash of hashes.filter((value) => EVM_TX_RE.test(value)).slice(0, 12)) {
    void apiFetch(`/api/token/${encodeURIComponent(campaign)}/ingest-tx?chainId=${chainId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chainId, txHash }),
    }).catch(() => undefined);
  }
}
