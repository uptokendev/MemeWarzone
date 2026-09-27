import { Stamp } from "../Stamp";
import { StoryHref } from "../StoryHref";
import { useStoryCtx } from "../StoryContext";

export function CallScene({ chapter, coin }: { chapter: any; coin: any }) {
  const { story, openShare, openFullStory } = useStoryCtx();
  const ctas: any[] = Array.isArray(chapter.ctas) ? chapter.ctas : [];
  const main = ctas.filter((c) => c.primary || String(c.href || "").startsWith("/"));
  const socials = ctas.filter((c) => !c.primary && /^https:\/\//.test(c.href || ""));
  return (
    <div className="bg call-bg">
      <div className="inner call-inner">
        <Stamp voice={chapter.voice} stamp={chapter.stamp} />
        <img className="mini" src={coin.logoUrl} alt="" />
        <h2 className="big fit call-title">{chapter.title}</h2>
        <div className="ctas">
          {main.map((cta, i) => (
            <StoryHref key={`${cta.href}-${i}`} href={cta.href} className={`cta ${cta.primary ? "main" : "alt"}`}>
              {cta.label}
            </StoryHref>
          ))}
          {story.fullStory ? (
            <button type="button" className="cta alt full-width" onClick={openFullStory}>
              Read the full story
            </button>
          ) : null}
          <button type="button" className="cta alt full-width" onClick={openShare}>
            Share this story
          </button>
        </div>
        {socials.length ? (
          <div className="socials">
            {socials.map((cta, i) => (
              <StoryHref key={`${cta.href}-s${i}`} href={cta.href} className="social">
                {cta.label}
              </StoryHref>
            ))}
          </div>
        ) : null}
        <div className="push tap-hint" style={{ marginTop: 14 }}>
          TAP LEFT TO REPLAY
        </div>
      </div>
    </div>
  );
}
