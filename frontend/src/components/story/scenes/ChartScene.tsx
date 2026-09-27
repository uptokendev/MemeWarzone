import { useId } from "react";

import { Stamp } from "../Stamp";
import { EmphasisText } from "../storyText";
import { useStoryCtx } from "../StoryContext";

export function ChartScene({ chapter }: { chapter: any }) {
  const { story } = useStoryCtx();
  const gid = useId().replace(/:/g, "");
  const pts: number[] = Array.isArray(chapter.points) ? chapter.points : [];
  const w = 300;
  const h = 170;
  const max = Math.max(...pts, 1);
  const min = Math.min(...pts, 0);
  const X = (i: number) => (i / Math.max(1, pts.length - 1)) * w;
  const Y = (v: number) => h - ((v - min) / (max - min || 1)) * (h - 10) - 5;
  const d = pts.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
  const pin = (p: { index?: number; i?: number; label: string; date?: string } | null, cls: string, delay: string) => {
    if (!p) return null;
    const i = Number(p.index ?? p.i ?? 0);
    const x = pts[i];
    if (!Number.isFinite(x)) return null;
    return (
      <div
        className={`pin ${cls}`}
        style={{
          left: `${(X(i) / w) * 100}%`,
          top: `${(Y(x) / h) * 100}%`,
          animationDelay: delay,
        }}
      >
        <i />
        <b>{p.label}</b>
        {p.date || ""}
      </div>
    );
  };
  return (
    <div className="bg chron-bg">
      <div className="grid-bg" />
      <div className="inner">
        <Stamp voice={chapter.voice} stamp={chapter.stamp} />
        <h2 className="big fit">
          {chapter.title}
          {chapter.sub ? <small>{chapter.sub}</small> : null}
        </h2>
        <div className="chart">
          <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
            <defs>
              <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor={story.coin.accent} stopOpacity="0.35" />
                <stop offset="1" stopColor={story.coin.accent} stopOpacity="0" />
              </linearGradient>
            </defs>
            <path className="area" d={`${d} L${w},${h} L0,${h} Z`} fill={`url(#${gid})`} />
            <path className="line" d={d} style={{ ["--len" as string]: 1400 }} />
          </svg>
          {pin(chapter.low, "low", "1.4s")}
          {pin(chapter.high, "ath", "2.4s")}
        </div>
        <div className="axis">
          <span>{chapter.fromLabel}</span>
          <span>{chapter.toLabel}</span>
        </div>
        {chapter.lede ? (
          <p className="lede push">
            <EmphasisText text={chapter.lede} />
          </p>
        ) : null}
      </div>
    </div>
  );
}
