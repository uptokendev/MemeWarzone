import { Stamp } from "../Stamp";
import { EmphasisText } from "../storyText";

function Fighter({ side }: { side: any }) {
  if (!side) return null;
  return (
    <div className={`fighter ${side.won ? "win" : "lose"}`}>
      {side.imageUrl ? <img src={side.imageUrl} alt={side.ticker || ""} /> : null}
      {side.ticker ? <div className="tag">${side.ticker}</div> : null}
    </div>
  );
}

export function BattleScene({ chapter }: { chapter: any }) {
  return (
    <div className="bg chron-bg">
      <div className="grid-bg" />
      <div className="inner">
        <Stamp voice={chapter.voice} stamp={chapter.stamp} />
        {chapter.date ? <div className="date">{chapter.date}</div> : null}
        <h2 className="big fit">
          {chapter.title}
          {chapter.sub ? <small>{chapter.sub}</small> : null}
        </h2>
        <div className="vs">
          <Fighter side={chapter.left} />
          <span className="vsw">VS</span>
          <Fighter side={chapter.right} />
        </div>
        {chapter.resultLabel ? <div className="result">{chapter.resultLabel}</div> : null}
        {chapter.lede ? (
          <p className="lede push">
            <EmphasisText text={chapter.lede} />
          </p>
        ) : null}
      </div>
    </div>
  );
}
