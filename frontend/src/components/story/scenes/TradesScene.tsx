import { CountUp } from "../CountUp";
import { Stamp } from "../Stamp";
import { StoryHref } from "../StoryHref";
import { EmphasisText } from "../storyText";
import { useStoryCtx } from "../StoryContext";

function shortTx(url: string) {
  try {
    const id = new URL(url).pathname.split("/").filter(Boolean).pop() || url;
    return id.length > 12 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id;
  } catch {
    return url;
  }
}

export function TradesScene({ chapter }: { chapter: any }) {
  const { reducedMotion } = useStoryCtx();
  const items: any[] = Array.isArray(chapter.items) ? chapter.items : [];
  return (
    <div className="bg chron-bg">
      <div className="grid-bg" />
      <div className="inner">
        <Stamp voice={chapter.voice} stamp={chapter.stamp} />
        {items.map((item, i) => (
          <div key={i} className={i === items.length - 1 ? "push" : ""}>
            {item.offsetLabel ? <div className="date">{item.offsetLabel}</div> : null}
            <div className="stat">
              <CountUp
                value={Number(item.amount)}
                decimals={Number(item.decimals || 0)}
                className={item.tone === "accent" ? "accent whale" : ""}
                reducedMotion={reducedMotion}
              />
              <span className="unit">{item.unit}</span>
            </div>
            {item.note ? (
              <p className="lede m">
                <EmphasisText text={item.note} />
                {item.wallet ? (
                  <>
                    {" "}
                    <em>{item.wallet}</em>
                  </>
                ) : null}
              </p>
            ) : item.wallet ? (
              <p className="lede m">
                <em>{item.wallet}</em>
              </p>
            ) : null}
            {item.txUrl ? (
              <p className="tx">
                <StoryHref href={item.txUrl}>{shortTx(item.txUrl)}</StoryHref>
              </p>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
