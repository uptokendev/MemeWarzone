import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type Tone = "default" | "accent" | "auto" | "up" | "down";

const TONES: Record<Tone, string> = {
  default: "border-mw-edge bg-[#171B20] text-[#C9CED4]",
  accent: "border-[#7A3A0C] bg-[#2A1609] text-mw-accent-soft",
  auto: "border-[#24384A] bg-[#14202A] text-[#8CC4F0]",
  up: "border-mw-edge bg-[#171B20] text-mw-up",
  down: "border-mw-edge bg-[#171B20] text-mw-down",
};

export function Chip({ tone = "default", mono = false, className, ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone; mono?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-[13px] font-semibold",
        mono ? "font-mw-mono" : "font-mw-body",
        TONES[tone],
        className,
      )}
      {...props}
    />
  );
}
