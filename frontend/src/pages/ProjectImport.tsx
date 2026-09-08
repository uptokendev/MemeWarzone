import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CheckCircle2, Loader2, Search, ShieldCheck, ShieldQuestion } from "lucide-react";
import { toast } from "sonner";

import { ContentContainer } from "@/components/layout/ContentContainer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSolanaWallet } from "@/contexts/SolanaWalletContext";
import { useWallet } from "@/contexts/WalletContext";
import { BNB_CHAIN_ID, SOLANA_CHAIN_ID } from "@/lib/chainConfig";
import { isSolanaAddress } from "@/lib/address";
import {
  createProjectImport,
  lookupProjectImport,
  requestProjectClaim,
  type ProjectImportItem,
} from "@/lib/projectImports";
import { signSolanaMessage } from "@/lib/solanaWallet";
import { signWalletAction } from "@/lib/walletActionAuth";

type ImportChain = "bnb" | "solana";

function projectUrl(item: ProjectImportItem) {
  return `/token/${encodeURIComponent(item.tokenAddress)}?chainId=${item.chainId}`;
}

export default function ProjectImport() {
  const navigate = useNavigate();
  const wallet = useWallet();
  const solanaWallet = useSolanaWallet();
  const [chain, setChain] = useState<ImportChain>("bnb");
  const [tokenAddress, setTokenAddress] = useState("");
  const [resolved, setResolved] = useState<ProjectImportItem | null>(null);
  const [lookupComplete, setLookupComplete] = useState(false);
  const [working, setWorking] = useState(false);
  const [claiming, setClaiming] = useState(false);

  const chainId = chain === "bnb" ? BNB_CHAIN_ID : SOLANA_CHAIN_ID;
  const connectedWallet = chain === "bnb" ? wallet.account : solanaWallet.solanaAccount;
  const connected = Boolean(connectedWallet);
  const validAddress = useMemo(() => {
    const value = tokenAddress.trim();
    return chain === "bnb" ? /^0x[a-fA-F0-9]{40}$/.test(value) : isSolanaAddress(value);
  }, [chain, tokenAddress]);

  const ownershipVerified = Boolean(resolved?.verifiedAt);
  const currentWalletOwnsRecord = Boolean(
    resolved?.ownerWallet && connectedWallet &&
      (chain === "solana"
        ? resolved.ownerWallet === connectedWallet
        : resolved.ownerWallet.toLowerCase() === connectedWallet.toLowerCase()),
  );

  const resetResolution = () => {
    setResolved(null);
    setLookupComplete(false);
  };

  const connect = async () => {
    try {
      if (chain === "solana") await solanaWallet.connectSolana();
      else await wallet.connect();
    } catch (error: any) {
      toast.error(String(error?.message || "Wallet connection failed."));
    }
  };

  const resolveProject = async () => {
    if (!validAddress || working) return;
    setWorking(true);
    setLookupComplete(false);
    try {
      const item = await lookupProjectImport(tokenAddress.trim(), chainId);
      setResolved(item);
      setLookupComplete(true);
    } catch (error: any) {
      toast.error(String(error?.message || "Project lookup failed."));
      setResolved(null);
      setLookupComplete(true);
    } finally {
      setWorking(false);
    }
  };

  const signImportAction = async (action: string, extraLines: string[]) => {
    if (!connectedWallet) throw new Error("Connect the project wallet first.");
    if (chain === "solana") {
      return signWalletAction({
        action,
        walletAddress: connectedWallet,
        chainId,
        walletType: "solana",
        extraLines,
        signMessage: async (message) => (await signSolanaMessage(message, connectedWallet)).signature,
      });
    }
    return signWalletAction({
      action,
      walletAddress: connectedWallet,
      chainId,
      extraLines,
      signer: wallet.signer,
    });
  };

  const registerProject = async () => {
    if (!connected || !validAddress || working) return;
    setWorking(true);
    const toastId = toast.loading("Registering project and checking ownership...");
    try {
      const token = tokenAddress.trim();
      const auth = await signImportAction("arena_import_token", [`Token: ${token}`]);
      const result = await createProjectImport({
        tokenAddress: token,
        chainId,
        walletAddress: connectedWallet,
        auth,
      });
      setResolved(result.item);
      setLookupComplete(true);
      toast.success(result.ownershipVerified ? "Project registered. Ownership verified." : "Project registered. Automatic ownership verification is unavailable.");
    } catch (error: any) {
      toast.error(String(error?.message || "Could not register project."));
    } finally {
      toast.dismiss(toastId);
      setWorking(false);
    }
  };

  const requestClaim = async () => {
    if (!resolved || !currentWalletOwnsRecord || claiming) return;
    setClaiming(true);
    const toastId = toast.loading("Requesting project claim...");
    try {
      const auth = await signImportAction("arena_import_request_review", [`Import: ${resolved.id}`]);
      const next = await requestProjectClaim(resolved.id, auth);
      setResolved(next);
      toast.success("Project claim requested.");
    } catch (error: any) {
      toast.error(String(error?.message || "Could not request project claim."));
    } finally {
      toast.dismiss(toastId);
      setClaiming(false);
    }
  };

  return (
    <ContentContainer className="space-y-6 px-1 pb-12 pt-2" data-project-import-page="true">
      <section className="mwz-hud-frame p-5">
        <div className="text-[11px] uppercase tracking-[0.2em] text-accent">Existing project onboarding</div>
        <h1 className="mt-2 font-retro text-2xl text-foreground">IMPORT YOUR MEMECOIN</h1>
        <p className="mt-3 max-w-2xl text-sm text-muted-foreground">
          Register an existing BNB or Solana memecoin with MemeWarzone. Connect the project wallet, resolve the contract or mint, and verify ownership where the chain exposes safe evidence.
        </p>
      </section>

      <section className="mwz-hud-frame space-y-5 p-5">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.14em] text-white/70">1. Choose chain</div>
          <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Import chain">
            <Button type="button" variant={chain === "bnb" ? "default" : "outline"} onClick={() => { setChain("bnb"); resetResolution(); }} data-import-chain="bnb">
              BNB
            </Button>
            <Button type="button" variant={chain === "solana" ? "default" : "outline"} onClick={() => { setChain("solana"); resetResolution(); }} data-import-chain="solana">
              Solana
            </Button>
          </div>
        </div>

        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.14em] text-white/70">2. Connect wallet</div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button type="button" variant="outline" onClick={() => void connect()} disabled={chain === "bnb" ? wallet.connecting : solanaWallet.connectingSolana}>
              {connected ? "WALLET CONNECTED" : chain === "bnb" ? "CONNECT BNB WALLET" : "CONNECT SOLANA WALLET"}
            </Button>
            {connectedWallet ? <span className="max-w-full truncate text-xs text-muted-foreground">{connectedWallet}</span> : null}
          </div>
        </div>

        <div>
          <label htmlFor="project-import-token" className="text-xs font-semibold uppercase tracking-[0.14em] text-white/70">
            3. Contract / mint
          </label>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <Input
              id="project-import-token"
              value={tokenAddress}
              onChange={(event) => { setTokenAddress(event.target.value); resetResolution(); }}
              placeholder={chain === "bnb" ? "0x..." : "Solana mint address"}
              autoComplete="off"
              spellCheck={false}
              data-import-contract-input="true"
            />
            <Button type="button" variant="outline" disabled={!validAddress || working} onClick={() => void resolveProject()}>
              {working ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}
              RESOLVE PROJECT
            </Button>
          </div>
          {tokenAddress && !validAddress ? <p className="mt-2 text-xs text-amber-200">Enter a valid {chain === "bnb" ? "BNB contract" : "Solana mint"} address.</p> : null}
        </div>
      </section>

      {lookupComplete ? (
        <section className="mwz-hud-frame p-5" data-import-ownership-result="true">
          {resolved ? (
            <>
              <div className="flex items-start gap-3">
                {ownershipVerified ? <ShieldCheck className="mt-0.5 h-5 w-5 text-emerald-300" /> : <ShieldQuestion className="mt-0.5 h-5 w-5 text-amber-200" />}
                <div>
                  <h2 className="font-retro text-sm text-foreground">
                    {ownershipVerified ? "OWNER VERIFIED" : "AUTOMATIC OWNERSHIP VERIFICATION UNAVAILABLE"}
                  </h2>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {ownershipVerified
                      ? "The registered owner wallet matches the ownership evidence resolved by the server."
                      : "The project is registered, but automatic chain evidence did not verify ownership. You can request a project claim from the registered wallet."}
                  </p>
                </div>
              </div>

              <div className="mt-5 flex flex-wrap gap-2">
                {!ownershipVerified && currentWalletOwnsRecord ? (
                  <Button type="button" variant="outline" onClick={() => void requestClaim()} disabled={claiming || Boolean(resolved.reviewRequestedAt)} data-project-claim-action="true">
                    {claiming ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                    {resolved.reviewRequestedAt ? "PROJECT CLAIM REQUESTED" : "REQUEST PROJECT CLAIM"}
                  </Button>
                ) : null}
                <Button type="button" onClick={() => navigate(projectUrl(resolved))}>
                  <CheckCircle2 className="mr-2 h-4 w-4" />
                  OPEN PROJECT PAGE
                </Button>
              </div>
            </>
          ) : (
            <>
              <h2 className="font-retro text-sm text-foreground">PROJECT NOT REGISTERED</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                No imported MemeWarzone project was found for this {chain === "bnb" ? "contract" : "mint"}. Register it from the connected project wallet to run the server ownership check.
              </p>
              <Button type="button" className="mt-4" disabled={!connected || !validAddress || working} onClick={() => void registerProject()} data-register-project="true">
                {working ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                REGISTER & VERIFY PROJECT
              </Button>
              {!connected ? <p className="mt-2 text-xs text-amber-200">Connect the project wallet before registering.</p> : null}
            </>
          )}
        </section>
      ) : null}
    </ContentContainer>
  );
}
