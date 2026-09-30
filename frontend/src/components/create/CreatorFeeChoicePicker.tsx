import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type CreatorFeeChoice = "keep" | "holders" | "split" | "buyback";

/**
 * The creator fee choice on the create page (DBC D5). Same four options and words on
 * a Solana DBC coin and on an EVM generation-6 coin; the chain only changes where the
 * money is held, not what the creator picks.
 */
export const CREATOR_FEE_CHOICE_OPTIONS = [
  ["keep", "Keep it", "Your share of every trade fee is yours to claim."],
  ["holders", "Give it to holders", "Your share is paid out to the coin's holders every week."],
  ["split", "Split", "You keep a percentage; holders get the rest every week."],
  ["buyback", "Buyback and burn", "Bought back at random times each week and burned."],
] as const;

export function CreatorFeeChoicePicker({
  value,
  onChange,
  sharePct,
  onSharePctChange,
}: {
  value: CreatorFeeChoice;
  onChange: (choice: CreatorFeeChoice) => void;
  sharePct: string;
  onSharePctChange: (pct: string) => void;
}) {
  return (
    <div>
      <div className="font-retro text-sm text-foreground">Creator fee</div>
      <div className="mt-2 grid gap-1.5">
        {CREATOR_FEE_CHOICE_OPTIONS.map(([id, label, detail]) => (
          <button key={id} type="button" onClick={() => onChange(id)} className={cn("rounded-lg border px-2.5 py-2 text-left", value === id ? "border-accent bg-accent/15" : "border-border bg-muted/30")}>
            <div className="font-retro text-sm">{label}</div>
            <p className="mt-0.5 text-[0.65rem] leading-4 text-muted-foreground">{detail}</p>
          </button>
        ))}
      </div>
      {value === "split" ? (
        <div className="mt-2">
          <label className="text-xs text-muted-foreground">Your share percent</label>
          <Input type="number" min={1} max={99} value={sharePct} onChange={(e) => onSharePctChange(e.target.value)} className="mt-1 max-w-[8rem]" />
        </div>
      ) : null}
    </div>
  );
}
