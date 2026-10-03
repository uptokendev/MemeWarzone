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
import { commandCenterImportPath, createProjectImport, type ProjectImportItem } from "@/lib/projectImports";
import { projectImportFeedback } from "@/lib/projectImportFeedback.mjs";
import { signSolanaMessage } from "@/lib/solanaWallet";
import { signWalletAction } from "@/lib/walletActionAuth";
import { cp } from "@/components/token/coinPageStyles";

const primaryBtn = "mw-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50";
const inputCls = "h-11 rounded-[10px] border border-mw-edge bg-mw-input px-3 text-[15px] text-mw-text placeholder:text-[#5C6670]";
const chainBtn = (active: boolean) => active ? primaryBtn : cp.btn;

type ImportChain = "bnb" | "solana" | "robinhood";
const ROBINHOOD_CHAIN_ID = 4663;

function projectUrl(item: ProjectImportItem) {
  const params = new URLSearchParams({ chainId: String(item.chainId) });
  if (item.ownershipStatus === "ownership_pending") params.set("claim", "prompt");
  return `/token/${encodeURIComponent(item.tokenAddress)}?${params.toString()}`;
}

function detectImportChain(solanaAccount?: string | null, evmAccount?: string | null, preferSolana = false): ImportChain | null {
  const solana = Boolean(String(solanaAccount || "").trim());
  const evm = Boolean(String(evmAccount || "").trim());
  if (!solana && !evm) return null;
  if (solana && (!evm || preferSolana)) return "solana";
  return "bnb";
}

export function ProjectImportPanel({ embedded = false, onProjectChange }: { embedded?: boolean; onProjectChange?: (item: ProjectImportItem) => void; }) {
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
  const contextRef = useRef(contextKey); contextRef.current = contextKey;
  const current = () => contextRef.current === contextKey;
  const validAddress = useMemo(() => { const value = tokenAddress.trim(); return chain === "solana" ? isSolanaAddress(value) : /^0x[a-fA-F0-9]{40}$/.test(value); }, [chain, tokenAddress]);

  useEffect(() => { if (chainChosenByUser || !detectedChain || detectedChain === chain) return; setChain(detectedChain); setFeedback(null); }, [detectedChain, chainChosenByUser, chain]);

  const connect = async () => { try { if (chain === "solana") await solanaWallet.connectSolana(); else await wallet.connect(); } catch (error: any) { setFeedback(projectImportFeedback(error)); } };
  const signCreate = async () => {
    if (!connectedWallet || !current()) throw new Error("Wallet changed. Connect your wallet and press IMPORT again.");
    return signWalletAction({ action: "project_import_create", walletAddress: connectedWallet, chainId, walletType: chain === "solana" ? "solana" : "evm", signMessage: chain === "solana" ? async (message) => (await signSolanaMessage(message, connectedWallet)).signature : undefined, signer: chain === "solana" ? undefined : wallet.signer });
  };
  const importToken = async () => {
    if (!validAddress || !connected || working) return;
    setWorking(true); setFeedback(null);
    try { const auth = await signCreate(); if (!current()) return; const result = await createProjectImport({ tokenAddress: tokenAddress.trim(), chainId, auth }); if (!current()) return; onProjectChange?.(result.project); navigate(projectUrl(result.project)); }
    catch (error: any) { if (current()) setFeedback(projectImportFeedback(error)); }
    finally { setWorking(false); }
  };

  const body = <>
    {embedded ? null : <section className="font-mw-body"><div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-[#FF9A4D]">Existing project onboarding</div><h1 className="m-0 mt-2 font-mw-cond text-[32px] font-bold leading-none text-mw-text lg:text-[40px]">IMPORT YOUR MEMECOIN</h1><p className="mt-3 max-w-2xl text-[15px] text-mw-muted">Import any existing memecoin on a supported chain, regardless of where it was launched or created. MemeWarzone resolves the token and runs critical safety checks before creating the project page. Project ownership can be claimed separately later.</p></section>}
    <section className={embedded ? "space-y-5" : "rounded-[14px] border border-mw-border bg-mw-surface p-4 font-mw-body space-y-5 sm:p-5"}>
      <div><div className={cp.label}>1. Choose chain</div><div className="mt-3 flex flex-wrap gap-2"><Button type="button" disabled={working} variant={chain === "bnb" ? "default" : "outline"} className={chainBtn(chain === "bnb")} onClick={() => { setChainChosenByUser(true); setChain("bnb"); setFeedback(null); }}>BNB</Button><Button type="button" disabled={working} variant={chain === "solana" ? "default" : "outline"} className={chainBtn(chain === "solana")} onClick={() => { setChainChosenByUser(true); setChain("solana"); setFeedback(null); }}>Solana</Button>{projectImportRobinhoodEnabled ? <Button type="button" disabled={working} variant={chain === "robinhood" ? "default" : "outline"} className={chainBtn(chain === "robinhood")} onClick={() => { setChainChosenByUser(true); setChain("robinhood"); setFeedback(null); }}>Robinhood</Button> : null}</div></div>
      <div><div className={cp.label}>2. Wallet</div><div className="mt-3 flex flex-wrap items-center gap-3"><Button type="button" variant="outline" className={cp.btn} onClick={() => void connect()} disabled={chain === "solana" ? solanaWallet.connectingSolana : wallet.connecting}>{connected ? "WALLET CONNECTED" : chain === "solana" ? "CONNECT SOLANA WALLET" : chain === "robinhood" ? "CONNECT ROBINHOOD WALLET" : "CONNECT BNB WALLET"}</Button>{connectedWallet ? <span className="max-w-full truncate font-mw-mono text-xs text-mw-muted">{connectedWallet}</span> : null}</div><p className="mt-2 text-[13px] text-mw-muted">Your wallet signs the import request only. It does not need to own the token.</p></div>
      <div><label htmlFor="project-import-token" className={cp.label}>3. Contract Address</label><div className="mt-3 flex flex-col gap-2 sm:flex-row"><Input id="project-import-token" className={`${inputCls} font-mw-mono`} disabled={working} value={tokenAddress} onChange={(e) => { setTokenAddress(e.target.value); setFeedback(null); }} placeholder="Contract Address" /><Button type="button" className={primaryBtn} disabled={!validAddress || !connected || working} onClick={() => void importToken()}>{working ? <Loader2 className="h-4 w-4 animate-spin" /> : null}IMPORT MEMECOIN</Button></div>{!connected ? <p className="mt-2 text-[13px] text-mw-accent-soft">Connect a wallet to submit the import.</p> : null}{tokenAddress.trim() && !validAddress ? <p role="alert" className="mt-2 text-sm text-mw-sell">This Contract Address is not valid for the selected chain.</p> : null}</div>
    </section>
    {feedback ? <section role="alert" data-import-error="true" className="mw-alert rounded-[14px] border border-[#5A1A26] bg-[#1F0D12] p-4 font-mw-body"><h2 className="font-mw-cond text-lg font-bold text-mw-text">{feedback.title}</h2><p className="mt-2 text-sm text-mw-text">{feedback.message}</p>{feedback.retry ? <Button type="button" variant="outline" className={`${cp.btn} mt-3`} disabled={working || !validAddress || !connected} onClick={() => void importToken()}>RETRY IMPORT</Button> : null}</section> : null}
  </>;

  if (embedded) return <div className="space-y-5" data-project-import-panel="true">{body}</div>;
  return <ContentContainer className="space-y-6 px-1 pb-12 pt-2" data-project-import-page="true">{body}</ContentContainer>;
}

export default function ProjectImport() { const feedWallet = useActiveFeedWallet(); return <Navigate to={commandCenterImportPath(feedWallet.address)} replace />; }
