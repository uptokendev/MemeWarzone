/** Pieces the Solana widget (mwzSwapWidget.ts) and the gen-8 EVM widget (gen8Widget.ts) share. */

// ---------------------------------------------------------------- amounts (no floats for money)

export function toRaw(text: string, decimals: number): bigint | null {
  const value = String(text || "").trim().replace(",", ".");
  if (!/^\d*\.?\d*$/.test(value) || value === "" || value === ".") return null;
  const [whole, frac = ""] = value.split(".");
  if (frac.length > decimals) return null;
  const raw = BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
  return raw > 0n ? raw : null;
}

export function fromRaw(raw: string | bigint, decimals: number, maxFraction = 6): string {
  const value = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  let frac = (value % base).toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "");
  if (!frac && whole === 0n && value > 0n) return `<0.${"0".repeat(Math.max(0, maxFraction - 1))}1`;
  return frac ? `${whole.toLocaleString("en-US")}.${frac}` : whole.toLocaleString("en-US");
}

// ---------------------------------------------------------------- styles

export const STYLE = `
:host { all: initial; display: block; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.box { --bg:#0e1114; --panel:#161b20; --line:#2e353d; --text:#f2f4f5; --muted:#8a949e; --accent:#ff7a1a; --accent-text:#140a02; --up:#2ecc71; --down:#ff5c5c;
  box-sizing:border-box; max-width:420px; width:100%; background:var(--bg); color:var(--text); border:1px solid var(--line); border-radius:14px; padding:16px; }
.box.light { --bg:#ffffff; --panel:#f4f5f7; --line:#dfe3e8; --text:#14181c; --muted:#5c6670; }
.box * { box-sizing:border-box; }
.box [hidden] { display:none !important; }
.head { display:flex; align-items:center; gap:10px; margin-bottom:12px; }
.head img { width:32px; height:32px; border-radius:50%; object-fit:cover; background:var(--panel); }
.title { font-weight:700; font-size:15px; }
.sub { color:var(--muted); font-size:12px; }
.tabs { display:grid; grid-template-columns:1fr 1fr; gap:6px; margin-bottom:12px; }
.tabs button { border:1px solid var(--line); background:var(--panel); color:var(--muted); border-radius:10px; padding:8px; font-weight:700; cursor:pointer; font-size:13px; }
.tabs button[aria-pressed="true"].buy { background:var(--up); color:#06210f; border-color:var(--up); }
.tabs button[aria-pressed="true"].sell { background:var(--down); color:#2a0606; border-color:var(--down); }
.field { position:relative; }
.field input { width:100%; height:48px; border-radius:10px; border:1px solid var(--line); background:var(--panel); color:var(--text); font-size:18px; padding:0 84px 0 12px; outline:none; font-family:ui-monospace, Menlo, monospace; }
.field input:focus { border-color:var(--accent); }
.unit { position:absolute; right:12px; top:50%; transform:translateY(-50%); color:var(--muted); font-size:13px; pointer-events:none; }
.row { display:flex; justify-content:space-between; gap:8px; font-size:12px; color:var(--muted); margin-top:8px; }
.row b { color:var(--text); font-weight:600; font-family:ui-monospace, Menlo, monospace; }
.max { background:none; border:none; color:var(--accent); cursor:pointer; font-size:12px; padding:0; }
.go { margin-top:14px; width:100%; height:46px; border-radius:10px; border:1px solid var(--accent); background:var(--accent); color:var(--accent-text); font-weight:800; font-size:14px; cursor:pointer; }
.go:disabled { opacity:.55; cursor:not-allowed; }
.msg { margin-top:10px; font-size:12px; min-height:16px; }
.msg.err { color:var(--down); } .msg.ok { color:var(--up); }
.foot { margin-top:12px; font-size:11px; color:var(--muted); text-align:center; }
.foot a { color:var(--muted); }
.claim { margin-top:8px; font-size:12px; text-align:center; color:var(--muted); }
.claim a { color:var(--accent); font-weight:600; }
`;

