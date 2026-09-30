import { useState } from "react";
import { ethers, type Signer } from "ethers";
import { Button } from "@/components/ui/button";
import {
  claimCreatorEscrow,
  claimCreatorGraduation,
  claimVaultCreatorFees,
  claimVaultCreatorQuote,
  type Gen5CampaignState,
  type Gen5CreatorState,
} from "@/lib/evmGen6Client";
import { evmFeeChoiceLine } from "@/lib/evmGen6.mjs";

function tokens(raw: bigint): string {
  const whole = raw / 10n ** 18n;
  return whole > 0n ? whole.toLocaleString("en-US") : raw > 0n ? "<1" : "0";
}

function native(raw: bigint, symbol: string): string {
  const n = Number(ethers.formatEther(raw));
  if (!Number.isFinite(n)) return `${raw.toString()} wei`;
  if (n === 0) return `0 ${symbol}`;
  return `${n.toFixed(n >= 1 ? 4 : 6).replace(/0+$/, "").replace(/\.$/, "")} ${symbol}`;
}

function quoteAmount(raw: bigint, symbol: string | null, decimals: number): string {
  const n = Number(ethers.formatUnits(raw, decimals));
  const unit = symbol || "quote";
  if (!Number.isFinite(n)) return `${raw.toString()} raw ${unit}`;
  if (n === 0) return `0 ${unit}`;
  return `${n.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${unit}`;
}

function when(unix: number): string {
  return new Date(unix * 1000).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type Row = {
  key: string;
  title: string;
  detail: string;
  amount: string;
  disabled: boolean;
  label?: string;
  run: () => Promise<{ hash: string }>;
};

/**
 * The creator's side of a generation-5 EVM coin, laid out like the DBC creator
 * rewards panel: bought tokens held in escrow, the 19.8% graduation payout, and the
 * creator fees for a keep or split coin.
 */
export function EvmGen5CreatorPanel({
  state,
  creator,
  signer,
  account,
  nativeSymbol,
  onClaimed,
}: {
  state: Gen5CampaignState;
  creator: Gen5CreatorState;
  signer: Signer | null;
  account: string;
  nativeSymbol: string;
  onClaimed: () => void;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const noSigner = !signer || !account;
  const isBeneficiary =
    creator.graduationBeneficiary !== ethers.ZeroAddress &&
    creator.graduationBeneficiary.toLowerCase() === account.toLowerCase();
  const hasQuote = creator.pendingGraduationQuote > 0n;

  const escrowDetail =
    creator.escrowTotal === 0n
      ? "Your buys after launch are held here: 20% is released 30 days after each buy, then 20% every 7 days."
      : creator.escrowLocked > 0n && creator.nextReleaseAt > 0
        ? `Held ${tokens(creator.escrowHeld)}, locked ${tokens(creator.escrowLocked)}. Next release ${when(creator.nextReleaseAt)}.`
        : `Held ${tokens(creator.escrowHeld)}, nothing locked.`;

  const graduationDetail = state.launched
    ? isBeneficiary
      ? "19.8% of what the curve raised, plus any refund from the pool."
      : "Paid to the coin owner at graduation. Connect that wallet to claim."
    : "19.8% of what the curve raised, paid when the coin graduates.";

  const rows: Row[] = [
    {
      key: "escrow",
      title: "Your locked buys",
      detail: escrowDetail,
      amount: `${tokens(creator.escrowClaimable)} tokens released`,
      disabled: noSigner || creator.escrowClaimable <= 0n,
      run: () => claimCreatorEscrow(signer!, state.campaign),
    },
    {
      key: "graduation",
      title: "Graduation payout",
      detail: graduationDetail,
      amount: hasQuote
        ? `${native(creator.pendingGraduation, nativeSymbol)} + ${quoteAmount(creator.pendingGraduationQuote, state.quoteSymbol, state.quoteDecimals)}`
        : native(creator.pendingGraduation, nativeSymbol),
      disabled: noSigner || !state.launched || !isBeneficiary || (creator.pendingGraduation <= 0n && !hasQuote),
      run: () => claimCreatorGraduation(signer!, state.campaign, account, hasQuote),
    },
  ];
  if (hasQuote && state.launched && isBeneficiary && creator.pendingGraduation > 0n) {
    rows.push({
      key: "graduation-native",
      title: `Graduation payout, ${nativeSymbol} only`,
      detail: `Use this if the ${state.quoteSymbol || "quote"} token refuses the transfer. Its part stays claimable.`,
      amount: native(creator.pendingGraduation, nativeSymbol),
      disabled: noSigner,
      run: () => claimCreatorGraduation(signer!, state.campaign, account, false),
    });
  }
  if ((state.feeChoice === "keep" || state.feeChoice === "split") && state.feeVault) {
    rows.push({
      key: "fees",
      title: "Creator fees",
      detail: state.feeChoice === "split" ? `Your ${state.feeCreatorPct}% of the creator fees.` : "Your share of every trade fee and of the pool's fees after graduation.",
      amount: native(creator.vaultCreatorBalance, nativeSymbol),
      disabled: noSigner || creator.vaultCreatorBalance <= 0n,
      run: () => claimVaultCreatorFees(signer!, state.feeVault, state.campaign),
    });
    if (creator.vaultCreatorQuoteBalance > 0n) {
      rows.push({
        key: "fees-quote",
        title: `Creator fees in ${state.quoteSymbol || "the quote token"}`,
        detail: "Pool fees earned in the coin's quote token.",
        amount: quoteAmount(creator.vaultCreatorQuoteBalance, state.quoteSymbol, state.quoteDecimals),
        disabled: noSigner,
        run: () => claimVaultCreatorQuote(signer!, state.feeVault, state.campaign),
      });
    }
  }

  const choiceLine = evmFeeChoiceLine(state.feeChoice, state.feeCreatorPct);

  return (
    <div className="mt-3 space-y-2 rounded-xl border border-orange-400/30 bg-background/60 p-3" data-testid="evm-gen5-creator-panel">
      <p className="font-retro text-xs text-orange-200">Creator rewards</p>
      {choiceLine ? <p className="text-[11px] text-muted-foreground">{choiceLine}</p> : null}
      {rows.map((row) => (
        <div key={row.key} className="flex items-center justify-between gap-2">
          <div>
            <p className="text-xs font-medium">{row.title}</p>
            <p className="text-[11px] text-muted-foreground">{row.detail}</p>
            <p className="font-mono text-[11px]">{row.amount}</p>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={Boolean(pending) || row.disabled}
            onClick={async () => {
              try {
                setPending(row.key);
                setError(null);
                const result = await row.run();
                setNote(`Tx ${result.hash.slice(0, 12)}…`);
                onClaimed();
              } catch (err: any) {
                setError(String(err?.shortMessage || err?.reason || err?.message || err));
              } finally {
                setPending(null);
              }
            }}
          >
            {pending === row.key ? "Claiming…" : "Claim"}
          </Button>
        </div>
      ))}
      {note ? <p className="text-[11px] text-muted-foreground">{note}</p> : null}
      {error ? <p className="text-[11px] text-destructive">{error}</p> : null}
    </div>
  );
}
