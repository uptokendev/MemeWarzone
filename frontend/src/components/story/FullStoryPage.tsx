import { Fragment } from "react";

import { emphasisParts } from "../../../shared/storyContract.mjs";
import { StoryHref } from "./StoryHref";

function EmText({ text }: { text?: string | null }) {
  return (
    <>
      {emphasisParts(text || "").map((part: { em: boolean; text: string }, i: number) => (
        <Fragment key={i}>{part.em ? <em>{part.text}</em> : part.text}</Fragment>
      ))}
    </>
  );
}

export function FullStoryPage({
  story,
  onBack,
}: {
  story: any;
  onBack: () => void;
}) {
  const coin = story.coin;
  const sections = story.fullStory?.sections || [];
  const call = [...(story.chapters || [])].reverse().find((ch: any) => ch.kind === "call");
  const ctas = Array.isArray(call?.ctas) ? call.ctas : [];
  return (
    <div className="full-story">
      <button type="button" className="full-back" onClick={onBack}>
        Back
      </button>
      <div className="full-inner">
        <img className="full-logo" src={coin.logoUrl} alt="" width={96} height={96} />
        <h1 className="full-name">{coin.name}</h1>
        {sections.map((section: { key: string; heading: string; body: string }) => (
          <section key={section.key} className="full-section">
            <h2 className="full-heading">
              <EmText text={section.heading} />
            </h2>
            <p className="full-body">
              <EmText text={section.body} />
            </p>
          </section>
        ))}
        <div className="ctas">
          {ctas.map((cta: { label: string; href: string; primary?: boolean }, i: number) => (
            <StoryHref key={`${cta.href}-${i}`} href={cta.href} className={`cta ${cta.primary ? "main" : "alt"}`}>
              {cta.label}
            </StoryHref>
          ))}
        </div>
      </div>
    </div>
  );
}
