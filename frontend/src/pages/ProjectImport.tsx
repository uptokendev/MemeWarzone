import { useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { ContentContainer } from "@/components/layout/ContentContainer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { useWallet } from "@/contexts/WalletContext";
import { useActiveFeedWallet } from "@/hooks/useActiveFeedWallet";
import { BNB_CHAIN_ID, SOLANA_CHAIN_ID } from "@/lib/chainConfig";
import { projectImportRobinhoodEnabled } from "@/features/projectImports/config";
import { isSolanaAddress } from "@/lib/address";
import {
  commandCenterImportPath,
  createProjectImport,
  type ProjectImportItem,
} from "@/lib/projectImports";
import { projectImportFeedback } from "@/lib/projectImportFeedback.mjs";
import { signSolanaMessage } from "@/lib/solanaWallet";
import { signWalletAction } from "@/lib/walletActionAuth";

type ImportChain = "bnb" | "solana" | "robinhood";
const ROBINHOOD_CHAIN_ID = 4663;

function projectUrl(item: ProjectImportItem) {
  const params = new URLSearchParams({ chainId: String(item.chainId) });
  if (item.chainId === SOLANA_CHAIN_ID && item.ownershipStatus === "ownership_pending") params.set("claim", "prompt");
  return `/token/${encodeURIComponent(item.tokenAddress)}?${params.toString()}`;
}

function detectImportChain(
  solanaAccount?: string | null,
  evmAccount?: string | null,
  preferSolana = false,
): ImportChain | null {
  const solana = Boolean(String(solanaAccount || "").trim());
  const evm = Boolean(String(evmAccount || "").trim());
  if (!solana && !evm) return null;
  if (solana && (!evm || preferSolana)) return "solana";
  return "bnb";
}

export function ProjectImportPanel({
  embedded = false,
  onProjectChange,
}: {
  embedded?: boolean;
  onProjectChange?: (item: ProjectImportItem) => void;
}) {
  const navigate = useNavigate();
  const wallet = useWallet();
  const solanaWallet = useSolanaWallet();
  const feedWallet = useActiveFeedWallet();
  const detectedChain = detectImportChain(feedWallet.solanaAccount, feedWallet.evmAccount, feedWallet.isSolana);
  const [chain, setChain] = useState<ImportChain>(detectedChain || "bnb");
  const [chainChosenByUser, setChainChosenByUser] = useState(false);
  const [tokenAddress, setTokenAddress] = useState("");
  const [working, setWorking] = useState(false);
  const [feedback, setFeedback] = useState<{ title: string; message: string; retry: boolean } | null>(null);

  const chainId = chain === "solana" ? SOLANA_CHAIN_ID : chain === "robinhood" ? ROBINHOOD_CHAIN_ID : BNB_CHAIN_ID;
  const connectedWallet = chain === "solana" ? solanaWallet.solanaAccount : wallet.account;
  const connected = Boolean(connectedWallet);
  const contextKey = JSON.stringify([chainId, tokenAddress.trim(), connectedWallet]);
  const contextRef = useRef(contextKey);
  contextRef.current = contextKey;
  const current = () => contextRef.current === contextKey;
  const validAddress = useMemo(() => {
    const value = tokenAddress.trim();
    return chain === "solana" ? isSolanaAddress(value) : /^0x[a-fA-F0-9]{40}$/.test(value);
  }, [chain, tokenAddress]);

  useEffect(() => {
    if (chainChosenByUser || !detectedChain || detectedChain === chain) return;
    setChain(detectedChain);
    setFeedback(null);
  }, [detectedChain, chainChosenByUser, chain]);

  const connect = async () => {
    try {
      if (chain === "solana") await solanaWallet.connectSolana();
      else await wallet.connect();
    } catch (error: any) {
      setFeedback(projectImportFeedback(error));
    }
  };

  const signCreate = async () => {
    if (!connectedWallet || !current()) throw new Error("Wallet changed. Connect your wallet and press IMPORT again.");
    return signWalletAction({
      action: "project_import_create",
      walletAddress: connectedWallet,
      chainId,
      walletType: chain === "solana" ? "solana" : "evm",
      signMessage: chain === "solana"
        ? async (message) => (await signSolanaMessage(message, connectedWallet)).signature
        : undefined,
      signer: chain === "solana" ? undefined : wallet.signer,
    });
  };

  const importToken = async () => {
    if (!validAddress || !connected || working) return;
    setWorking(true);
    setFeedback(null);
    try {
      const auth = await signCreate();
      if (!current()) return;
      const result = await createProjectImport({ tokenAddress: tokenAddress.trim(), chainId, auth });
      if (!current()) return;
      onProjectChange?.(result.project);
      navigate(projectUrl(result.project));
    } catch (error: any) {
      if (current()) setFeedback(projectImportFeedback(error));
    } finally {
      setWorking(false);
    }
  };

  const body = <>
    {embedded ? null : (
      <section className="mwz-hud-frame p-5">
        <div className="text-[11px] uppercase tracking-[0.2em] text-accent">Existing project onboarding</div>
        <h1 className="mt-2 font-retro text-2xl text-foreground">IMPORT YOUR MEMECOIN</h1>
        <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
          Import any supported memecoin. MemeWarzone verifies the token, confirms it is no longer bonding and runs critical safety checks before creating the page. Project ownership can be claimed separately later.
        </p>
      </section>
    )}

    <section className={embedded ? "space-y-5" : "mwz-hud-frame space-y-5 p-5"}>
      <div>
        <div className="text-xs font-semibold uppercase tracking-[0.14em] text-white/70">1. Choose chain</div>
        <div className="mt-3 flex gap-2">
          <Button type="button" disabled={working} variant={chain === "bnb" ? "default" : "outline"} onClick={() => { setChainChosenByUser(true); setChain("bnb"); setFeedback(null); }}>BNB</Button>
          <Button type="button" disabled={working} variant={chain === "solana" ? "default" : "outline"} onClick={() => { setChainChosenByUser(true); setChain("solana"); setFeedback(null); }}>Solana</Button>
          {projectImportRobinhoodEnabled ? <Button type="button" disabled={working} variant={chain === "robinhood" ? "default" : "outline"} onClick={() => { setChainChosenByUser(true); setChain("robinhood"); setFeedback(null); }}>Robinhood</Button> : null}
        </div>
      </div>

      <div>
        <div className="text-xs font-semibold uppercase tracking-[0.14em] text-white/70">2. Wallet</div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" onClick={() => void connect()} disabled={chain === "solana" ? solanaWallet.connectingSolana : wallet.connecting}>
            {connected ? "WALLET CONNECTED" : chain === "solana" ? "CONNECT SOLANA WALLET" : chain === "robinhood" ? "CONNECT ROBINHOOD WALLET" : "CONNECT BNB WALLET"}
          </Button>
          {connectedWallet ? <span className="max-w-full truncate text-xs text-muted-foreground">{connectedWallet}</span> : null}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">Your wallet signs the import request only. It does not need to own the token.</p>
      </div>

      <div>
        <label htmlFor="project-import-token" className="text-xs font-semibold uppercase tracking-[0.14em] text-white/70">3. Contract Address</label>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <Input id="project-import-token" disabled={working} value={tokenAddress} onChange={(e) => { setTokenAddress(e.target.value); setFeedback(null); }} placeholder="Contract Address" />
          <Button type="button" disabled={!validAddress || !connected || working} onClick={() => void importToken()}>
            {working ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            IMPORT MEMECOIN
          </Button>
        </div>
        {!connected ? <p className="mt-2 text-xs text-amber-200">Connect a wallet to submit the import.</p> : null}
        {tokenAddress.trim() && !validAddress ? <p role="alert" className="mt-2 text-sm text-red-200">This Contract Address is not valid for the selected chain.</p> : null}
      </div>
    </section>

    {feedback ? (
      <section role="alert" data-import-error="true" className="rounded-md border border-red-300/40 bg-red-400/10 p-4">
        <h2 className="font-retro text-sm text-red-100">{feedback.title}</h2>
        <p className="mt-2 text-sm text-red-50">{feedback.message}</p>
        {feedback.retry ? <Button type="button" variant="outline" className="mt-3" disabled={working || !validAddress || !connected} onClick={() => void importToken()}>RETRY IMPORT</Button> : null}
      </section>
    ) : null}
  </>;

  if (embedded) return <div className="space-y-5" data-project-import-panel="true">{body}</div>;
  return <ContentContainer className="space-y-6 px-1 pb-12 pt-2" data-project-import-page="true">{body}</ContentContainer>;
}

export default function ProjectImport() {
  const feedWallet = useActiveFeedWallet();
  return <Navigate to={commandCenterImportPath(feedWallet.address)} replace />;
}
