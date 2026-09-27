import { Stamp } from "../Stamp";

export function StandingScene({ chapter }: { chapter: any }) {
  const rows: any[] = Array.isArray(chapter.rows) ? chapter.rows : [];
  return (
    <div className="bg chron-bg">
      <div className="grid-bg" />
      <div className="inner">
        <Stamp voice={chapter.voice} stamp={chapter.stamp} />
        <h2 className="big fit">
          {chapter.title}
          {chapter.sub ? <small>{chapter.sub}</small> : null}
        </h2>
        <div className="push">
          {rows.map((row, i) => (
            <div key={i} className="rank" style={{ animationDelay: `${0.4 + i * 0.35}s` }}>
              <div className="pos">{row.position || row.pos}</div>
              <div className="lab">
                {row.label}
                {row.detail ? <span>{row.detail}</span> : null}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
