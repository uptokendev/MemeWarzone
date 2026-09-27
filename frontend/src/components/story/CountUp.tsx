import { useEffect, useState } from "react";

function fmt(v: number, dec: number) {
  return v.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

export function CountUp({
  value,
  decimals = 0,
  prefix = "",
  suffix = "",
  className = "",
  reducedMotion = false,
}: {
  value: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  className?: string;
  reducedMotion?: boolean;
}) {
  const [shown, setShown] = useState(reducedMotion ? value : 0);
  useEffect(() => {
    if (reducedMotion) {
      setShown(value);
      return;
    }
    const t0 = performance.now();
    const len = 1500;
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / len);
      const e = 1 - Math.pow(1 - k, 3);
      setShown(value * e);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, reducedMotion]);
  return (
    <span
      className={`num fit ${className}`.trim()}
      data-count={String(value)}
      data-dec={String(decimals)}
      data-prefix={prefix}
      data-suffix={suffix}
    >
      {prefix}
      {fmt(shown, decimals)}
      {suffix}
    </span>
  );
}
