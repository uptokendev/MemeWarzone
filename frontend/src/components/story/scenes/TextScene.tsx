import { Stamp } from "../Stamp";
import { EmphasisText, WordReveal } from "../storyText";

function SonarFx() {
  const bubbles = Array.from({ length: 14 }, (_, i) => ({
    left: `${(i * 37) % 92}%`,
    duration: `${4 + (i % 5)}s`,
    delay: `${(i % 8) * 0.45}s`,
    size: `${3 + (i % 6)}px`,
  }));
  return (
    <>
      <div className="ring" />
      <div className="ring" />
      <div className="ring" />
      {bubbles.map((b, i) => (
        <i
          key={i}
          className="bubble"
          style={{
            left: b.left,
            animationDuration: b.duration,
            animationDelay: b.delay,
            width: b.size,
            height: b.size,
          }}
        />
      ))}
    </>
  );
}

function CandleFx() {
  const heights = [18, 24, 15, 30, 26, 38, 22, 34, 46, 40, 55];
  return (
    <>
      <div className="candles">
        {heights.map((h, i) => (
          <i
            key={i}
            className={`candle${i % 4 === 2 ? " red" : ""}`}
            style={{ height: `${h}%`, animationDelay: `${i * 0.05}s` }}
          />
        ))}
        <i className="candle hero-candle" />
      </div>
      <div className="veil" />
    </>
  );
}

export function TextScene({ chapter }: { chapter: any }) {
  const style = chapter.style || "plain";
  const heading = chapter.heading;
  const body = chapter.body;
  return (
    <div className={`bg ${style === "candle" ? "legend-bg" : style === "sonar" ? "origin-bg" : "cover-bg"}`}>
      {style === "sonar" ? <SonarFx /> : null}
      {style === "candle" ? <CandleFx /> : null}
      <div className="inner">
        <Stamp voice={chapter.voice} stamp={chapter.stamp} />
        {heading && (style === "sonar" || style === "words") ? (
          <WordReveal text={heading} className="big words fit" />
        ) : heading ? (
          <h2 className="big fit">{heading}</h2>
        ) : null}
        {body ? (
          <p className={`lede ${chapter.voice === "chronicle" ? "m" : ""} ${heading ? "" : ""}`.trim()}>
            <EmphasisText text={body} />
          </p>
        ) : null}
      </div>
    </div>
  );
}
