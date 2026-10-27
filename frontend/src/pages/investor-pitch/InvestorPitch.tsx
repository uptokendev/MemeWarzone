/**
 * /investorpitch: revenue outlook for prospective investors. Unlisted: no link in the app, noindex (seoRoutes.mjs +
 * deploy/nginx/app.conf), not in the sitemap. Rendered outside the app shell (App.tsx), so no wallets or sidebar load.
 * The model lives in investorPitchModel.ts; this file is layout and copy only.
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import "./investorPitch.css";
import {
  CHAINS,
  PATHS,
  runModel,
  yearTotals,
  type Lanes,
  type Month,
  type PathKey,
  type QualityKey,
  type TerminalKey,
} from "./investorPitchModel";

const PAGE_TITLE = "MemeWarzone Revenue Outlook";

const GROUPS: Array<{ key: string; name: string; color: string; of: (l: Lanes) => number }> = [
  { key: "new", name: "New coins on the curve", color: "var(--ip-s1)", of: (l) => l.new_coins },
  { key: "old", name: "Older coins still trading", color: "var(--ip-s2)", of: (l) => l.older_coins },
  { key: "grad", name: "Graduates", color: "var(--ip-s3)", of: (l) => l.graduation + l.graduates },
  { key: "term", name: "Trading terminal and imports", color: "var(--ip-s4)", of: (l) => l.imports + l.terminal },
  {
    key: "arena",
    name: "Battles, tournaments and UpVotes",
    color: "var(--ip-s5)",
    of: (l) => l.battles + l.tournaments + l.sponsorships + l.upvotes,
  },
];

const SOURCE_ROWS: Array<[string, (l: Lanes) => number]> = [
  ["New coins, first month on the curve", (l) => l.new_coins],
  ["Older coins still trading", (l) => l.older_coins],
  ["Graduates trading", (l) => l.graduates],
  ["Graduation fees", (l) => l.graduation],
  ["Trading terminal and import swaps", (l) => l.imports + l.terminal],
  ["UpVotes", (l) => l.upvotes],
  ["Battles", (l) => l.battles],
  ["Tournaments", (l) => l.tournaments],
  ["Sponsorships", (l) => l.sponsorships],
];

const PATH_OPTIONS: Array<[PathKey, string]> = [["slow", "Slow"], ["middle", "Middle"], ["fast", "Fast"]];
const QUALITY_OPTIONS: Array<[QualityKey, string]> = [["base", "Base"], ["realistic", "Realistic"], ["strong", "Strong"]];
const TERMINAL_OPTIONS: Array<[TerminalKey, string]> = [["off", "Off"], ["low", "Low"], ["base", "Base"], ["high", "High"]];

const PATH_HELP: Record<PathKey, string> = {
  slow: "3 a week, 1 a day by month 7, 5 a day by month 18, 8 a day by month 24.",
  middle: "3 a week, 1 a day by month 4, 10 a day by month 12, 22 a day by month 24.",
  fast: "3 a week, 10 a day by month 7, 20 a day by month 12, 40 a day by month 22.",
};
const QUALITY_HELP: Record<QualityKey, string> = {
  base: "Every coin like our first 2 coins: $128 first month, 5% graduate.",
  realistic: "Strong while launches are few, sliding to base as volume passes 2 a day.",
  strong: "Every coin strong: $200 first month, 20% graduate, communities that stay.",
};
const TERMINAL_HELP: Record<TerminalKey, string> = {
  off: "Leaves the terminal out: only launches, imports and the arena.",
  low: "From month 2: 20% of wallets plus 100 own traders growing 8% a month, $500 each a month.",
  base: "From month 2: 35% of wallets plus 200 own traders growing 12% a month, $1,000 each a month.",
  high: "From month 2: 50% of wallets plus 400 own traders growing 18% a month, $2,000 each a month.",
};

function fmt(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `$${(v / 1e6).toFixed(a >= 1e7 ? 1 : 2).replace(/\.0+$/, "")}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(a >= 1e5 ? 0 : 1).replace(/\.0$/, "")}K`;
  return `$${Math.round(v)}`;
}
const fmtFull = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;

function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / p;
  const n = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10;
  return n * p;
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(Math.max(300, el.clientWidth));
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

const MONTH_TICKS = [1, 6, 12, 18, 24];
const tickAnchor = (mo: number) => (mo === 1 ? "start" : mo === 24 ? "end" : "middle");

function RevenueChart({ data }: { data: Month[] }) {
  const [boxRef, W] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const H = W < 560 ? 280 : 340;
  const m = { t: 12, r: 12, b: 28, l: W < 560 ? 44 : 56 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const n = data.length;
  const maxT = niceMax(Math.max(...data.map((d) => d.total)) * 1.04);
  const x = (i: number) => m.l + (iw * i) / (n - 1);
  const y = (v: number) => m.t + ih * (1 - v / maxT);

  const areas = useMemo(() => {
    const cum = data.map(() => 0);
    return GROUPS.map((g) => {
      const lo = cum.slice();
      data.forEach((d, i) => {
        cum[i] += g.of(d.lanes);
      });
      let d = data.map((_, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(cum[i]).toFixed(1)}`).join("");
      for (let i = n - 1; i >= 0; i--) d += `L${x(i).toFixed(1)},${y(lo[i]).toFixed(1)}`;
      return { key: g.key, color: g.color, d: `${d}Z` };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, W, maxT]);
  const top = data.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d.total).toFixed(1)}`).join("");

  const onMove = (ev: ReactPointerEvent<SVGRectElement>) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return;
    const px = ((ev.clientX - r.left) * W) / r.width;
    setHover(Math.max(0, Math.min(n - 1, Math.round(((px - m.l) / iw) * (n - 1)))));
  };

  const last = data[n - 1];
  const tipLeft = (() => {
    if (hover == null) return 0;
    const tx = x(hover);
    const tw = 240;
    return Math.max(0, Math.min(W - tw, tx > W / 2 ? tx - tw - 14 : tx + 14));
  })();

  return (
    <div className="chartbox" ref={boxRef}>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Stacked area chart of monthly revenue by source over 24 months">
        <g className="grid">
          {[0, 1, 2, 3, 4].map((i) => (
            <line key={i} x1={m.l} x2={W - m.r} y1={y((maxT * i) / 4)} y2={y((maxT * i) / 4)} />
          ))}
        </g>
        <g className="axis">
          {[0, 1, 2, 3, 4].map((i) => (
            <text key={i} x={m.l - 8} y={y((maxT * i) / 4) + 4} textAnchor="end">{fmt((maxT * i) / 4)}</text>
          ))}
          {MONTH_TICKS.map((mo) => (
            <text key={mo} x={x(mo - 1)} y={H - 8} textAnchor={tickAnchor(mo)}>{`M${mo}`}</text>
          ))}
        </g>
        {areas.map((a) => (
          <path key={a.key} d={a.d} fill={a.color} fillOpacity={0.9} stroke="var(--ip-surface)" strokeWidth={1.5} strokeLinejoin="round" />
        ))}
        <path d={top} fill="none" stroke="var(--ip-text)" strokeWidth={2} strokeLinejoin="round" />
        <circle cx={x(n - 1)} cy={y(last.total)} r={4} fill="var(--ip-text)" stroke="var(--ip-surface)" strokeWidth={2} />
        <text x={x(n - 1) - 8} y={y(last.total) - 10} textAnchor="end" className="lbl-txt" style={{ fill: "var(--ip-text)", fontSize: 12 }}>
          {`${fmt(last.total)} / month`}
        </text>
        {hover != null && (
          <line x1={x(hover)} x2={x(hover)} y1={m.t} y2={m.t + ih} stroke="var(--ip-muted)" strokeWidth={1} strokeDasharray="3 3" />
        )}
        <rect
          x={m.l}
          y={m.t}
          width={iw}
          height={ih}
          fill="transparent"
          style={{ cursor: "crosshair" }}
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => setHover(null)}
        />
      </svg>
      {hover != null && (
        <div className="tip" style={{ left: `${(tipLeft / W) * 100}%` }}>
          <div className="t-head">{`Month ${hover + 1} · ${data[hover].lpd} launches a day`}</div>
          {GROUPS.slice().reverse().map((g) => (
            <div className="row" key={g.key}>
              <span><i className="swatch" style={{ background: g.color }} />{g.name}</span>
              <b>{fmtFull(g.of(data[hover].lanes))}</b>
            </div>
          ))}
          <div className="row tot"><span>Total</span><b>{fmtFull(data[hover].total)}</b></div>
        </div>
      )}
    </div>
  );
}

function LaunchesChart({ data }: { data: Month[] }) {
  const [boxRef, W] = useWidth<HTMLDivElement>();
  const H = 110;
  const m = { t: 16, r: 12, b: 24, l: W < 560 ? 44 : 56 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const n = data.length;
  const maxV = niceMax(Math.max(...data.map((d) => d.lpd)) * 1.05);
  const x = (i: number) => m.l + (iw * i) / (n - 1);
  const y = (v: number) => m.t + ih * (1 - v / maxV);
  const line = data.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d.lpd).toFixed(1)}`).join("");
  return (
    <div className="chartbox" ref={boxRef}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Line chart of launches per day over 24 months">
        <g className="grid">
          {[0, maxV / 2, maxV].map((v) => <line key={v} x1={m.l} x2={W - m.r} y1={y(v)} y2={y(v)} />)}
        </g>
        <g className="axis">
          {[0, maxV / 2, maxV].map((v) => (
            <text key={v} x={m.l - 8} y={y(v) + 4} textAnchor="end">{`${+v.toFixed(1)}/d`}</text>
          ))}
          {MONTH_TICKS.map((mo) => (
            <text key={mo} x={x(mo - 1)} y={H - 6} textAnchor={tickAnchor(mo)}>{`M${mo}`}</text>
          ))}
        </g>
        <path d={line} fill="none" stroke="var(--ip-accent)" strokeWidth={2} strokeLinejoin="round" />
        {[5, 11, 23].map((i) => (
          <g key={i}>
            <circle cx={x(i)} cy={y(data[i].lpd)} r={4} fill="var(--ip-accent)" stroke="var(--ip-surface)" strokeWidth={2} />
            <text
              x={x(i) - (i === 23 ? 6 : 0)}
              y={y(data[i].lpd) - 9}
              textAnchor={i === 23 ? "end" : "middle"}
              className="lbl-txt"
              style={{ fill: "var(--ip-text)" }}
            >
              {`${data[i].lpd} a day`}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

function Segmented<K extends string>({
  id, label, options, value, onChange,
}: { id: string; label: string; options: Array<[K, string]>; value: K; onChange: (v: K) => void }) {
  return (
    <div className="seg" role="group" aria-labelledby={`${id}-l`}>
      {options.map(([k, text]) => (
        <button key={k} type="button" id={`${id}-${k}`} aria-pressed={value === k} onClick={() => onChange(k)}>
          {text}
        </button>
      ))}
      <span hidden id={`${id}-l`}>{label}</span>
    </div>
  );
}

export default function InvestorPitch() {
  const [path, setPath] = useState<PathKey>("middle");
  const [quality, setQuality] = useState<QualityKey>("realistic");
  const [terminal, setTerminal] = useState<TerminalKey>("base");

  useEffect(() => {
    const prevTitle = document.title;
    document.title = PAGE_TITLE;
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex,nofollow";
    document.head.appendChild(meta);
    return () => {
      document.title = prevTitle;
      meta.remove();
    };
  }, []);

  const data = useMemo(() => runModel(PATHS[path], quality, terminal), [path, quality, terminal]);
  const { y1, y2 } = yearTotals(data);
  const grid = useMemo(
    () =>
      PATH_OPTIONS.map(([p]) =>
        QUALITY_OPTIONS.map(([q]) => yearTotals(runModel(PATHS[p], q, terminal))),
      ),
    [terminal],
  );
  const chainMonth = data[23].bych;
  const chainMax = Math.max(...CHAINS.map((c) => chainMonth[c]));

  return (
    <div className="ip">
      <div className="wrap">
        <header className="top">
          <div className="brandrow">
            <div className="wordmark">MEME<span>WAR</span>ZONE</div>
            <div className="dated">Revenue outlook · October 2026</div>
          </div>
          <h1>A launchpad that earns on <em>every trade</em>, on three chains</h1>
          <p className="lede">
            MemeWarzone takes a share of every trade of every coin launched on it, on Solana, Robinhood Chain and BNB Chain. Coins do not
            have to graduate for us to earn. Our trading terminal, now in development, extends that 1% fee to every token on those chains.
            This page shows what we have earned so far, exactly how we earn, and a 24 month model of what that grows into.
          </p>
          <div className="proof">
            <div><span className="lbl">Earned on our first 2 coins</span><span className="big">$255</span><span className="note">Solana, Sept to Oct 2026, neither graduated yet</span></div>
            <div><span className="lbl">Per launch so far</span><span className="big">$128</span><span className="note">About 6x pump.fun's average per launch</span></div>
            <div><span className="lbl">Chains live</span><span className="big">3</span><span className="note">Solana, Robinhood Chain, BNB Chain</span></div>
            <div><span className="lbl">Fee on every curve trade</span><span className="big">2%</span><span className="note">Split with creators, league prizes and recruiters</span></div>
          </div>
        </header>

        <section aria-labelledby="ip-live-h">
          <div className="section-head">
            <span className="eyebrow">What is live</span>
            <h2 id="ip-live-h">One platform, three chains, one set of players</h2>
            <p className="muted">Every product below is live on mainnet today, except the trading terminal. A wallet that joins for one coin can follow, battle and trade on all three chains.</p>
          </div>
          <div className="chains">
            <div className="chain">
              <div className="chain-head"><span className="chain-name">Solana</span><span className="pill">Live</span></div>
              <span className="rank">Expected #1 by volume · 60% of launches in the model</span>
              <ul>
                <li><b>Launch type:</b> Meteora bonding curve. Coins trade on Jupiter from the first second.</li>
                <li>Graduates at $30K or $50K market cap into a locked Meteora pool.</li>
              </ul>
            </div>
            <div className="chain">
              <div className="chain-head"><span className="chain-name">Robinhood Chain</span><span className="pill">Live</span></div>
              <span className="rank">Expected #2 · 25% of launches</span>
              <ul>
                <li><b>Launch type:</b> our own Uniswap V4 hook (gen-8).</li>
                <li>Opened October 2026. Contracts owned by a multisig Safe that needs 2 signatures.</li>
              </ul>
            </div>
            <div className="chain">
              <div className="chain-head"><span className="chain-name">BNB Chain</span><span className="pill">Live</span></div>
              <span className="rank">Expected #3 · 15% of launches</span>
              <ul>
                <li><b>Launch type:</b> the same gen-8 V4 hook and contracts as Robinhood.</li>
                <li>Opened October 2026. Contracts owned by a multisig Safe that needs 2 signatures.</li>
              </ul>
            </div>
          </div>
          <div className="products">
            <div className="product"><b>Launchpad</b><span className="desc">Create a coin with a creator first buy, anti-sniper fee for the first 60 seconds, and a fee choice for after graduation.</span></div>
            <div className="product"><b>Battles and tournaments</b><span className="desc">Coins compete head to head. Stakes, buy-ins and boosts form a war pool the winner takes.</span></div>
            <div className="product"><b>League</b><span className="desc">Monthly and quarterly prizes for creators, traders and squads, funded from fees.</span></div>
            <div className="product"><b>Imports and swap widget</b><span className="desc">Any outside coin can be imported and traded on MemeWarzone. Partners embed our swap widget on their own sites.</span></div>
            <div className="product"><b>UpVotes</b><span className="desc">Paid featured placement in the launch and graduated sections.</span></div>
            <div className="product"><b>Trading terminal <span className="pill dev">In development</span></b><span className="desc">Trade any token on Solana, BNB Chain and Robinhood Chain without importing it first, like pump.fun. Every trade pays the 1% fee.</span></div>
          </div>
        </section>

        <section aria-labelledby="ip-fees-h">
          <div className="section-head">
            <span className="eyebrow">How we earn</span>
            <h2 id="ip-fees-h">Our share of each source, per chain</h2>
            <p className="muted">Read from the live code and, for Robinhood and BNB, from the contracts on chain. "Ours" is what the protocol keeps after creators, the league, recruiters and partners are paid.</p>
          </div>
          <div className="tablebox">
            <table>
              <thead><tr><th>Source</th><th>Solana</th><th>Robinhood + BNB</th></tr></thead>
              <tbody>
                <tr><td>Curve trades<span className="sub">2% fee on every buy and sell before graduation</span></td><td><span className="ours">0.44%</span> of volume<span className="sub">21.9% of the fee, plus 0.08% referral on our own site</span></td><td><span className="ours">0.84%</span> of volume<span className="sub">41.9% of the fee</span></td></tr>
                <tr><td>Graduation<span className="sub">2% of the raise, once per coin</span></td><td><span className="ours">82.5%</span> of the fee<span className="sub">about $66 at $30K, $109 at $50K</span></td><td><span className="ours">80 to 82.5%</span> of the fee<span className="sub">same dollar range</span></td></tr>
                <tr><td>Trades after graduation</td><td><span className="ours">0.05%</span> of pool volume<span className="sub">plus <span className="ours">0.5%</span> of trades made on our site (1% route, half to the creator)</span></td><td><span className="ours">0.5%</span> of volume<span className="sub">1% hook fee, 0.5% to the creator. Verified on chain.</span></td></tr>
                <tr><td>Import swaps<span className="sub">outside coins traded on MemeWarzone</span></td><td><span className="ours">0.25 to 0.5%</span><span className="sub">1% fee, half to the coin's creator, a quarter to a widget partner</span></td><td><span className="ours">0.25 to 0.5%</span><span className="sub">Same 1% split, paid through an import fee vault on each chain</span></td></tr>
                <tr><td>Trading terminal <span className="pill dev">In development</span><span className="sub">1% on every trade of any token, on all three chains</span></td><td colSpan={2}><span className="ours">0.5 to 1%</span><span className="sub">0.5% to us at once. The other 0.5% goes to the token's creator if they claim it; if not claimed within 90 days of a trade, it comes to us.</span></td></tr>
                <tr><td>Battle stakes and tournament buy-ins</td><td colSpan={2}><span className="ours">5%</span><span className="sub">75% to the winner, 20% to the league prize pool</span></td></tr>
                <tr><td>Boosts in battles<span className="sub">$1 each</span></td><td colSpan={2}><span className="ours">10%</span><span className="sub">90% goes into the war pool</span></td></tr>
                <tr><td>Sponsorships of events</td><td colSpan={2}><span className="ours">10%</span><span className="sub">70% prize, 20% marketing</span></td></tr>
                <tr><td>UpVotes<span className="sub">featured placement, $3 each</span></td><td colSpan={2}><span className="ours">100%</span></td></tr>
              </tbody>
            </table>
          </div>
        </section>

        <section aria-labelledby="ip-model-h">
          <div className="section-head">
            <span className="eyebrow">The model</span>
            <h2 id="ip-model-h">24 months of revenue as launches grow</h2>
            <p className="muted">Every month's coins keep aging and trading. Graduates keep paying after graduation. Each launch brings wallets that stay to trade other tokens, buy UpVotes and join battles. The trading terminal adds traders of its own. Pick a growth path, a project quality and a terminal case.</p>
          </div>
          <div className="model">
            <div className="controls">
              <div className="control">
                <span className="control-label">Growth path (launches per day)</span>
                <Segmented<PathKey> id="ip-path" label="Growth path" options={PATH_OPTIONS} value={path} onChange={setPath} />
                <span className="control-help">{PATH_HELP[path]}</span>
              </div>
              <div className="control">
                <span className="control-label">Project quality</span>
                <Segmented<QualityKey> id="ip-q" label="Project quality" options={QUALITY_OPTIONS} value={quality} onChange={setQuality} />
                <span className="control-help">{QUALITY_HELP[quality]}</span>
              </div>
              <div className="control">
                <span className="control-label">Trading terminal (in development)</span>
                <Segmented<TerminalKey> id="ip-t" label="Trading terminal" options={TERMINAL_OPTIONS} value={terminal} onChange={setTerminal} />
                <span className="control-help">{TERMINAL_HELP[terminal]}</span>
              </div>
            </div>

            <div className="kpis">
              <div className="kpi lead"><span className="k">Year 1 revenue</span><span className="v">{fmt(y1)}</span></div>
              <div className="kpi lead"><span className="k">Year 2 revenue</span><span className="v">{fmt(y2)}</span></div>
              <div className="kpi"><span className="k">Month 12 per month</span><span className="v">{fmt(data[11].total)}</span></div>
              <div className="kpi"><span className="k">Month 24 per month</span><span className="v">{fmt(data[23].total)}</span></div>
              <div className="kpi"><span className="k">Active wallets, month 24</span><span className="v">{Math.round(data[23].active).toLocaleString("en-US")}</span></div>
            </div>

            <div className="chart-title">
              <h3>Revenue per month, by source</h3>
              <div className="legend">
                {GROUPS.map((g) => <span key={g.key}><i className="swatch" style={{ background: g.color }} />{g.name}</span>)}
              </div>
            </div>
            <RevenueChart data={data} />
            <div className="chart-title"><h3>Launches per day</h3><span className="muted" style={{ fontSize: "0.875rem" }}>Same months as above</span></div>
            <LaunchesChart data={data} />

            <div className="split">
              <div>
                <h3>Month 12 and month 24, by source</h3>
                <div className="tablebox">
                  <table className="narrow">
                    <thead><tr><th>Source</th><th className="r">Month 12</th><th className="r">Month 24</th></tr></thead>
                    <tbody>
                      {SOURCE_ROWS.map(([name, of]) => (
                        <tr key={name}><td>{name}</td><td className="r num">{fmtFull(of(data[11].lanes))}</td><td className="r num">{fmtFull(of(data[23].lanes))}</td></tr>
                      ))}
                      <tr className="total"><td>Total per month</td><td className="r num">{fmtFull(data[11].total)}</td><td className="r num">{fmtFull(data[23].total)}</td></tr>
                    </tbody>
                  </table>
                </div>
              </div>
              <div>
                <h3>Month 24, by chain</h3>
                <div className="bars">
                  {CHAINS.map((c) => (
                    <div className="bar-row" key={c}>
                      <span>{c}</span>
                      <div className="bar-track"><div className="bar-fill" style={{ width: `${((chainMonth[c] / chainMax) * 100).toFixed(1)}%` }} /></div>
                      <span className="num">{fmt(chainMonth[c])}</span>
                    </div>
                  ))}
                </div>
                <p className="muted" style={{ fontSize: "0.875rem" }}>Robinhood and BNB keep about twice Solana's share of each curve trade, and more of each trade after graduation. They get fewer launches and less volume per coin in the model, which brings them close to Solana per launch.</p>
              </div>
            </div>
          </div>
        </section>

        <section aria-labelledby="ip-grid-h">
          <div className="section-head">
            <span className="eyebrow">All scenarios</span>
            <h2 id="ip-grid-h">Year 1 and year 2 revenue</h2>
            <p className="muted">{`Each cell shows year 1, then year 2, with the trading terminal set to ${terminal}. The highlighted cell is the one selected above.`}</p>
          </div>
          <div className="tablebox">
            <table className="grid3">
              <thead>
                <tr><th>Growth path</th>{QUALITY_OPTIONS.map(([q, name]) => <th key={q} className="r">{`${name} projects`}</th>)}</tr>
              </thead>
              <tbody>
                {PATH_OPTIONS.map(([p, name], pi) => (
                  <tr key={p}>
                    <td>{name}<span className="sub">{`${PATHS[p][23]} a day by month 24`}</span></td>
                    {QUALITY_OPTIONS.map(([q], qi) => (
                      <td key={q} className={`cell${p === path && q === quality ? " sel" : ""}`}>
                        {fmt(grid[pi][qi].y1)} <span>{`then ${fmt(grid[pi][qi].y2)}`}</span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section aria-labelledby="ip-vs-h">
          <div className="section-head">
            <span className="eyebrow">Why this is not pump.fun</span>
            <h2 id="ip-vs-h">Fewer coins, stronger communities, more per launch</h2>
            <p className="muted">Pump.fun runs on volume: tens of thousands of coins a day, most dead the same day. MemeWarzone is built to keep coins alive, with battles, a league and creator rewards that keep paying after launch.</p>
          </div>
          <div className="versus">
            <div className="vcard">
              <h3>pump.fun</h3>
              <dl>
                <dt>Launches per day</dt><dd>30,663 to 52,438</dd>
                <dt>Coins with their last trade on launch day</dt><dd>68.7%</dd>
                <dt>Graduation rate</dt><dd>about 1%</dd>
                <dt>Revenue per day (June 2026)</dt><dd>about $800K</dd>
                <dt>Revenue per launch</dt><dd>about $20</dd>
              </dl>
            </div>
            <div className="vcard us">
              <h3>MemeWarzone</h3>
              <dl>
                <dt>Revenue per launch so far</dt><dd>$128</dd>
                <dt>Coins needed to graduate for that</dt><dd>0</dd>
                <dt>Holders per coin so far</dt><dd>about 35</dd>
                <dt>Chains</dt><dd>3</dd>
                <dt>Live revenue sources besides curve trades</dt><dd>7</dd>
                <dt>Trading terminal for any token</dt><dd>In development</dd>
              </dl>
            </div>
          </div>
          <div className="callouts">
            <div className="callout"><b>Older coins carry the business</b><p>At a steady 1 launch a day with strong projects, coins older than a month earn more than the new launches by month 12. A coin that keeps a community for a year pays us many times its first month.</p></div>
            <div className="callout"><b>Quality beats volume</b><p>On the middle path at month 24, strong projects earn $214K a month and base projects $77K without the terminal, on the same number of launches.</p></div>
            <div className="callout"><b>Every token pays 1%</b><p>With the terminal, our fee no longer depends on our own launches. Any token traded on MemeWarzone pays 1%, and unclaimed creator shares come to us after 90 days.</p></div>
            <div className="callout"><b>Graduates keep paying</b><p>In the strong case a graduate earns us $333 to $500 in trades after graduation, on top of a $90 graduation fee, because our fee stays on its trades.</p></div>
          </div>
        </section>

        <section aria-labelledby="ip-basis-h">
          <div className="section-head">
            <span className="eyebrow">What the numbers rest on</span>
            <h2 id="ip-basis-h">Measured facts and modelled assumptions</h2>
            <p className="muted">The fee rates are facts from code and chain. Revenue per launch comes from our first 2 coins. Everything else is an assumption, listed here so you can judge it.</p>
          </div>
          <div className="tablebox">
            <table>
              <thead><tr><th>Assumption</th><th className="r">Base</th><th className="r">Strong</th><th>Basis</th></tr></thead>
              <tbody>
                <tr><td>First month per launch, Solana</td><td className="r num">$128</td><td className="r num">$200</td><td className="muted">$255 on our first 2 coins; $200 is a successful launch by pump.fun standards</td></tr>
                <tr><td>Robinhood and BNB per launch</td><td className="r" colSpan={2}>1.9x the fee share, at 60% and 50% of Solana's volume</td><td className="muted">Contract fee constants</td></tr>
                <tr><td>Older coins, month 2 as share of month 1</td><td className="r num">10%</td><td className="r num">20%</td><td className="muted">Our 2 coins trade about 8% of their first month now</td></tr>
                <tr><td>Older coins, monthly decline after that</td><td className="r num">25%</td><td className="r num">15%</td><td className="muted">Assumption</td></tr>
                <tr><td>Graduation rate</td><td className="r num">5%</td><td className="r num">20%</td><td className="muted">The creator first buy (up to 70%) leaves about $2.4K of outside buying to graduate</td></tr>
                <tr><td>Graduate volume, first month after</td><td className="r num">$30K</td><td className="r num">$50K</td><td className="muted">Assumption, falling 40% and 30% a month</td></tr>
                <tr><td>Share of Solana graduate volume on our site</td><td className="r num" colSpan={2}>30%</td><td className="muted">Assumption; those trades pay the 1% route</td></tr>
                <tr><td>New wallets per launch</td><td className="r num">35 to 10</td><td className="r num">1.5x</td><td className="muted">About 35 holders per coin so far; fewer new wallets per launch as launches rise</td></tr>
                <tr><td>Wallets still active each month</td><td className="r num">60%</td><td className="r num">70%</td><td className="muted">Assumption</td></tr>
                <tr><td>Volume per coin as launches rise</td><td className="r" colSpan={2}>100% at 3 a week, 90% at 1 a day, 70% at 5, 55% at 10, 38% at 40</td><td className="muted">Traders are shared across more coins</td></tr>
                <tr><td>Import swaps per active wallet</td><td className="r" colSpan={2}>30% of wallets, $300 a month</td><td className="muted">Our average share 0.35%</td></tr>
                <tr><td>Battles per new coin, stake per side</td><td className="r num">1, $25</td><td className="r num">1.5, $50</td><td className="muted">Plus support and 10 to 15 boosts per battle</td></tr>
                <tr><td>Tournaments</td><td className="r" colSpan={2}>1 a week, more as launches grow; 16 coins, $20 buy-in</td><td className="muted">A quarter to 40% with a $500 sponsor</td></tr>
                <tr><td>UpVotes</td><td className="r num">$6 per launch</td><td className="r num">$10 per launch</td><td className="muted">Plus 2% of active wallets a month</td></tr>
                <tr><td>Trading terminal: live from</td><td className="r" colSpan={2}>Month 2</td><td className="muted">Assumption; it replaces import swaps from then on</td></tr>
                <tr><td>Terminal: share of active wallets trading on it</td><td className="r" colSpan={2}>Low 20%, base 35%, high 50%</td><td className="muted">Assumption</td></tr>
                <tr><td>Terminal: own traders at start, monthly growth</td><td className="r" colSpan={2}>Low 100 and 8%, base 200 and 12%, high 400 and 18%</td><td className="muted">Traders who come for the terminal, not for a launch</td></tr>
                <tr><td>Terminal: volume per trader per month</td><td className="r" colSpan={2}>Low $500, base $1,000, high $2,000</td><td className="muted">Assumption</td></tr>
                <tr><td>Terminal: tokens whose creator never claims</td><td className="r" colSpan={2}>80% of volume</td><td className="muted">Their 0.5% creator share comes to us 90 days after each trade</td></tr>
                <tr><td>Chain split of launches</td><td className="r" colSpan={2}>Solana 60%, Robinhood 25%, BNB 15%</td><td className="muted">Founder estimate</td></tr>
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ fontSize: "0.9375rem" }}>
            "Realistic" uses strong values up to 2 launches a day and moves to base values by 15 a day, because average project quality drops
            as volume grows. Revenue is in US dollars at today's prices (SOL about $100). Costs, taxes and token price changes are not
            included. These are projections from a model, not results.
          </p>
        </section>

        <footer>
          <span>Prepared by MemeWarzone, October 2026. Fee rates read from the live code and from the gen-8 launcher on BNB Chain and Robinhood Chain.</span>
          <span>pump.fun figures:</span>
          <ol>
            <li><a href="https://solanacompass.com/news/pumpfun-launched-42000-tokens-in-one-day-fewer-than-2-will-ever-reach-a-dex" target="_blank" rel="noopener noreferrer">Solana Compass: 42,000 launches in 24 hours</a></li>
            <li><a href="https://www.dextools.io/news/pump-fun-graduation-collapse-solana-fees-2026" target="_blank" rel="noopener noreferrer">DEXTools: graduation rate and fees in 2026</a></li>
            <li><a href="https://ankhlabs.co/articles/pump.fun-token-launches" target="_blank" rel="noopener noreferrer">Ankh Labs: how many pump.fun tokens fail</a></li>
            <li><a href="https://www.cryptopolitan.com/pump-fun-graduating-tokens-break-to-1-15-of-new-launches/" target="_blank" rel="noopener noreferrer">Cryptopolitan: graduating tokens at 1.15% of launches</a></li>
          </ol>
          <span>Revenue per launch for pump.fun is our estimate: about $800K revenue per day divided by about 40,000 launches per day, from different months.</span>
        </footer>
      </div>
    </div>
  );
}
