import { useMemo } from "react";
import { getGraduationTiers, type GraduationTier } from "@/lib/graduationTiers";

export function GraduationTierSelector({
  chainId,
  value,
  onChange,
  disabled = false,
  tiers: tierOverride,
}: {
  chainId: number;
  value: bigint;
  onChange: (value: bigint) => void;
  disabled?: boolean;
  /** A launch type with its own tiers (DBC) passes them; otherwise the chain's launchpad tiers. */
  tiers?: GraduationTier[];
}) {
  const tiers = useMemo(() => tierOverride || getGraduationTiers(chainId), [chainId, tierOverride]);

  return (
    <div className="mwz-card p-4">
      <div className="mb-3">
        <div className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Graduation threshold</div>
        <p className="mt-1 text-sm text-muted-foreground">
          Select the fixed USD target that this campaign must reach before DEX graduation.
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {tiers.map((tier) => {
          const selected = value === tier.targetWei;
          return (
            <button
              key={tier.id}
              type="button"
              disabled={disabled}
              onClick={() => onChange(tier.targetWei)}
              className={`rounded-lg border px-3 py-3 text-left transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
                selected
                  ? tier.testOnly
                    ? "border-orange-300 bg-orange-400/15 text-orange-100"
                    : "border-success/60 bg-success/10 text-success"
                  : "border-border bg-black/30 text-muted-foreground hover:border-success/40 hover:text-foreground"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-retro text-lg">{tier.label}</span>
                <span className="text-[10px] uppercase tracking-[0.14em]">{tier.title}</span>
              </div>
              <p className="mt-2 text-xs leading-5">{tier.description}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}
