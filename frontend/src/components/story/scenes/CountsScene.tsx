import { CountUp } from "../CountUp";
import { Stamp } from "../Stamp";
import { EmphasisText } from "../storyText";
import { useStoryCtx } from "../StoryContext";

export function CountsScene({ chapter }: { chapter: any }) {
  const { reducedMotion } = useStoryCtx();
  const rows: any[] = Array.isArray(chapter.rows) ? chapter.rows : [];
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
        <div className="push">
          {rows.map((row, i) => (
            <div key={i} className="stat">
              <CountUp
                value={Number(row.value)}
                decimals={Number(row.decimals || 0)}
                prefix={row.prefix || ""}
                suffix={row.suffix || ""}
                className={row.tone === "accent" ? "accent" : row.tone === "ember" ? "ember" : i === 0 ? "accent" : ""}
                reducedMotion={reducedMotion}
              />
              <span className="unit">{row.label}</span>
            </div>
          ))}
          {chapter.lede ? (
            <p className="lede m" style={{ marginTop: 12 }}>
              <EmphasisText text={chapter.lede} />
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
