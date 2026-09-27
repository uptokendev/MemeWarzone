import { Stamp } from "../Stamp";

export function WarcryScene({ chapter, coin }: { chapter: any; coin: any }) {
  const lines: string[] = Array.isArray(chapter.lines) ? chapter.lines : [];
  return (
    <div className="bg cry-bg">
      <img className="still" src={coin.logoUrl} alt="" />
      <div className="inner cry-inner">
        <Stamp voice={chapter.voice} stamp={chapter.stamp} />
        <h2 className="cry">
          {lines.map((line, i) => (
            <div key={i} className="fit cry-line" style={{ animationDelay: `${0.2 + i * 1.3}s` }}>
              {line}
            </div>
          ))}
        </h2>
      </div>
    </div>
  );
}
