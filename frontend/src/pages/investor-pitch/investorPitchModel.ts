/**
 * Revenue model behind /investorpitch. Pure functions, no I/O.
 * Every month's coins keep aging and paying; graduates keep trading; active wallets carry over month to month.
 * Fee shares are the protocol's own share after creators, league, recruiters and partners (see the page's fee table).
 */

export type PathKey = "slow" | "middle" | "fast";
export type QualityKey = "base" | "realistic" | "strong";
export type TerminalKey = "off" | "low" | "base" | "high";
export type ChainKey = "Solana" | "Robinhood" | "BNB";

type Params = {
  m1: number; tail2: number; tdec: number; grad: number; gradfee: number; postv: number; pdec: number; ret: number;
  wmult: number; upl: number; upw: number; impw: number; impv: number; bpl: number; bold: number; stake: number;
  sup: number; bst: number; tpw: number; tent: number; buyin: number; tbst: number; spons: number; sponsusd: number;
};

export type Lanes = {
  new_coins: number; older_coins: number; graduation: number; graduates: number; imports: number; terminal: number;
  upvotes: number; battles: number; tournaments: number; sponsorships: number;
};

export type Month = { lpd: number; lanes: Lanes; total: number; active: number; bych: Record<ChainKey, number> };

/** Share of Solana graduate volume traded on our own site, where the 1% route pays us 0.5%. */
const SITE = 0.3;
const CH: Record<ChainKey, { share: number; fee: number; vol: number; post: number }> = {
  Solana: { share: 0.6, fee: 1.0, vol: 1.0, post: 0.0005 + SITE * 0.005 },
  Robinhood: { share: 0.25, fee: 1.91, vol: 0.6, post: 0.005 },
  BNB: { share: 0.15, fee: 1.91, vol: 0.5, post: 0.005 },
};
export const CHAINS: ChainKey[] = ["Solana", "Robinhood", "BNB"];

const BASE: Params = {
  m1: 128, tail2: 0.1, tdec: 0.75, grad: 0.05, gradfee: 75, postv: 30000, pdec: 0.6, ret: 0.6, wmult: 1, upl: 6, upw: 0.02,
  impw: 0.3, impv: 300, bpl: 1.0, bold: 0.2, stake: 25, sup: 20, bst: 10, tpw: 1.0, tent: 16, buyin: 20, tbst: 8, spons: 0.25,
  sponsusd: 500,
};
const STRONG: Params = {
  ...BASE, m1: 200, tail2: 0.2, tdec: 0.85, grad: 0.2, gradfee: 90, postv: 50000, pdec: 0.7, ret: 0.7, wmult: 1.5, upl: 10,
  bpl: 1.5, bold: 0.3, stake: 50, sup: 40, bst: 15, spons: 0.4,
};
const IMP_OURS = 0.0035;
const DIL: Array<[number, number]> = [[0.43, 1.0], [1, 0.9], [5, 0.7], [10, 0.55], [20, 0.45], [40, 0.38]];
const WAL: Array<[number, number]> = [[0.43, 35], [1, 30], [5, 20], [10, 15], [20, 12], [40, 10]];

export const PATHS: Record<PathKey, number[]> = {
  slow: [0.43, 0.43, 0.5, 0.6, 0.7, 0.85, 1, 1, 1.2, 1.5, 1.8, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8],
  middle: [0.43, 0.6, 0.8, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22],
  fast: [0.43, 1, 2, 3, 5, 7, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40, 40, 40],
};

type TermParams = { part: number; org0: number; og: number; vol: number };
const TERM: Record<TerminalKey, TermParams | null> = {
  off: null,
  low: { part: 0.2, org0: 100, og: 0.08, vol: 500 },
  base: { part: 0.35, org0: 200, og: 0.12, vol: 1000 },
  high: { part: 0.5, org0: 400, og: 0.18, vol: 2000 },
};
/** The terminal goes live in month 2 and replaces import swaps from then on. */
export const TERM_START = 2;
const TERM_UNCLAIMED = 0.8;
const TERM_LAG = 3;

function interp(x: number, pts: Array<[number, number]>): number {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [a, fa] = pts[i - 1];
    const [b, fb] = pts[i];
    if (x <= b) return fa + ((fb - fa) * (x - a)) / (b - a);
  }
  return pts[pts.length - 1][1];
}

/** Realistic: strong values up to 2 launches a day, base values from 15 a day, linear in between. */
function params(q: QualityKey, lpd: number): Params {
  if (q === "base") return BASE;
  if (q === "strong") return STRONG;
  const w = Math.min(1, Math.max(0, (lpd - 2) / 13));
  const out = { ...BASE };
  (Object.keys(BASE) as Array<keyof Params>).forEach((k) => {
    out[k] = STRONG[k] * (1 - w) + BASE[k] * w;
  });
  return out;
}

const emptyLanes = (): Lanes => ({
  new_coins: 0, older_coins: 0, graduation: 0, graduates: 0, imports: 0, terminal: 0, upvotes: 0, battles: 0, tournaments: 0,
  sponsorships: 0,
});

export function runModel(path: number[], q: QualityKey, tk: TerminalKey): Month[] {
  const hist: Array<[number, number, Params]> = [];
  const termVol: number[] = [];
  const t = TERM[tk];
  const out: Month[] = [];
  let active = 0;
  for (const lpd of path) {
    const mo = out.length + 1;
    const p = params(q, lpd);
    const L = lpd * 30.4;
    hist.push([L, interp(lpd, DIL), p]);
    const lanes = emptyLanes();
    const bych: Record<ChainKey, number> = { Solana: 0, Robinhood: 0, BNB: 0 };
    for (let age = 0; age < hist.length; age++) {
      const [n, dil, c] = hist[hist.length - 1 - age];
      for (const ch of CHAINS) {
        const k = CH[ch];
        const per = c.m1 * k.fee * k.vol * dil * n * k.share;
        if (age === 0) {
          lanes.new_coins += per;
          const g = n * k.share * c.grad * c.gradfee;
          lanes.graduation += g;
          bych[ch] += per + g;
        } else {
          const tail = per * c.tail2 * c.tdec ** (age - 1);
          const gr = n * k.share * c.grad * c.postv * k.vol * c.pdec ** (age - 1) * k.post;
          lanes.older_coins += tail;
          lanes.graduates += gr;
          bych[ch] += tail + gr;
        }
      }
    }
    active = active * p.ret + L * interp(lpd, WAL) * p.wmult;
    const older = hist.slice(-4, -1).reduce((s, h) => s + h[0], 0);
    const battles = L * p.bpl + older * p.bold;
    lanes.battles = battles * (0.05 * (2 * p.stake + p.sup) + 0.1 * p.bst);
    const tournaments = p.tpw * Math.max(1, lpd / 2.5) * 4.33;
    lanes.tournaments = tournaments * (0.05 * p.tent * p.buyin + 0.1 * (p.tent - 1) * p.tbst);
    lanes.sponsorships = tournaments * p.spons * p.sponsusd * 0.1;
    lanes.upvotes = L * p.upl + active * p.upw * 3;
    lanes.imports = active * p.impw * p.impv * IMP_OURS;
    let vol = 0;
    if (t && mo >= TERM_START) {
      vol = (active * t.part + t.org0 * Math.pow(1 + t.og, mo - TERM_START)) * t.vol;
      lanes.imports = 0;
    }
    termVol.push(vol);
    const lagged = termVol.length > TERM_LAG ? termVol[termVol.length - 1 - TERM_LAG] : 0;
    lanes.terminal = vol * 0.005 + lagged * 0.005 * TERM_UNCLAIMED;
    const shared = lanes.imports + lanes.terminal + lanes.upvotes + lanes.battles + lanes.tournaments + lanes.sponsorships;
    for (const ch of CHAINS) bych[ch] += shared * CH[ch].share;
    const total = Object.values(lanes).reduce((a, b) => a + b, 0);
    out.push({ lpd, lanes, total, active, bych });
  }
  return out;
}

export const yearTotals = (data: Month[]) => ({
  y1: data.slice(0, 12).reduce((s, d) => s + d.total, 0),
  y2: data.slice(12).reduce((s, d) => s + d.total, 0),
});
