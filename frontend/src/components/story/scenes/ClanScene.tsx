import { Stamp } from "../Stamp";
import { EmphasisText } from "../storyText";

export function ClanScene({ chapter }: { chapter: any }) {
  const holding = Math.max(0, Number(chapter.holding) || 0);
  const exited = Math.max(0, Number(chapter.exited) || 0);
  const total = holding + exited;
  return (
    <div className="bg chron-bg">
      <div className="grid-bg" />
      <div className="inner">
        <Stamp voice={chapter.voice} stamp={chapter.stamp} />
        <h2 className="big fit">
          {chapter.title}
          {chapter.sub ? <small>{chapter.sub}</small> : null}
        </h2>
        <div className="dots">
          {Array.from({ length: total }, (_, i) => (
            <i
              key={i}
              className={`dot ${i < holding ? "lit" : "past"}`}
              style={{ animationDelay: `${0.3 + i * 0.045}s` }}
            />
          ))}
        </div>
        <div className="legend-row">
          <span className="l1">{holding}</span>
          <span className="l2">{exited}</span>
        </div>
        {chapter.lede ? (
          <p className="lede m push">
            <EmphasisText text={chapter.lede} />
          </p>
        ) : null}
      </div>
    </div>
  );
}
