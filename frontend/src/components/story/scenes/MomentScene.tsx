import { Stamp } from "../Stamp";
import { EmphasisText } from "../storyText";

export function MomentScene({ chapter }: { chapter: any }) {
  const seal: string[] | null = Array.isArray(chapter.seal) ? chapter.seal : null;
  return (
    <div className="bg chron-bg">
      <div className="grid-bg" />
      {seal ? (
        <div className="seal">
          {seal.map((line, i) => (
            <span key={i}>
              {line}
              {i < seal.length - 1 ? <br /> : null}
            </span>
          ))}
        </div>
      ) : null}
      <div className="inner">
        <Stamp voice={chapter.voice} stamp={chapter.stamp} />
        {chapter.date ? <div className="date">{chapter.date}</div> : null}
        {chapter.time ? <div className="clock fit">{chapter.time}</div> : null}
        <h2 className="big fit">
          {chapter.title}
          {chapter.sub ? <small>{chapter.sub}</small> : null}
        </h2>
        {chapter.lede ? (
          <p className="lede m push">
            <EmphasisText text={chapter.lede} />
          </p>
        ) : null}
      </div>
    </div>
  );
}
