import { Stamp } from "../Stamp";
import { SlamTitle } from "../storyText";

export function CoverScene({ chapter, coin }: { chapter: any; coin: any }) {
  return (
    <div className="bg cover-bg">
      <div className="halo" />
      <img className="hero" src={coin.logoUrl} alt={coin.name} />
      <div className="inner">
        <Stamp voice={chapter.voice} stamp={chapter.stamp} />
        <SlamTitle text={coin.name} />
        <div className="ticker">
          ${coin.ticker} · {chapter.kicker}
        </div>
        {chapter.quote ? <div className="quote">{chapter.quote}</div> : null}
        <div className="push tap-hint">TAP TO BEGIN →</div>
      </div>
    </div>
  );
}
