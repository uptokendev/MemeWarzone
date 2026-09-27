import { CountUp } from "../CountUp";
import { Stamp } from "../Stamp";
import { EmphasisText } from "../storyText";
import { useStoryCtx } from "../StoryContext";

export function ProgressScene({ chapter, coin }: { chapter: any; coin: any }) {
  const { reducedMotion } = useStoryCtx();
  const percent = Number(chapter.percent) || 0;
  const rival = chapter.rival;
  const rivalImg = rival && typeof rival === "object" ? rival.imageUrl || rival.logoUrl : null;
  const rivalTicker = rival && typeof rival === "object" ? rival.ticker : typeof rival === "string" ? rival : null;
  return (
    <div className="bg chron-bg">
      <div className="grid-bg" />
      <div className="inner">
        <Stamp voice={chapter.voice} stamp={chapter.stamp} />
        <h2 className="big fit">{chapter.title}</h2>
        <div className="pct">
          <CountUp value={percent} decimals={1} reducedMotion={reducedMotion} />%
        </div>
        <div className="track">
          <b style={{ ["--pct" as string]: `${percent}%` }} />
        </div>
        <div className="ticks">
          <span>{chapter.fromLabel}</span>
          <span>{chapter.toLabel}</span>
        </div>
        <div className="push">
          <div className="vs">
            <div className="fighter win">
              <img src={coin.logoUrl} alt={coin.ticker} />
              <div className="tag">${coin.ticker}</div>
            </div>
            <span className="vsw">VS</span>
            {rivalImg ? (
              <div className="fighter">
                <img src={rivalImg} alt={rivalTicker || ""} />
                {rivalTicker ? <div className="tag">${rivalTicker}</div> : null}
              </div>
            ) : (
              <div className="fighter empty">{rivalTicker || "?"}</div>
            )}
          </div>
          {chapter.lede ? (
            <p className="lede m" style={{ marginTop: 14 }}>
              <EmphasisText text={chapter.lede} />
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
