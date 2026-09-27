import { Fragment } from "react";

import { emphasisParts } from "../../../shared/storyContract.mjs";

export function EmphasisText({ text }: { text?: string | null }) {
  return (
    <>
      {emphasisParts(text || "").map((part: { em: boolean; text: string }, i: number) => (
        <Fragment key={i}>{part.em ? <em>{part.text}</em> : part.text}</Fragment>
      ))}
    </>
  );
}

export function SlamTitle({ text, className = "title fit" }: { text: string; className?: string }) {
  let n = 0;
  const words = String(text || "").split(" ").filter(Boolean);
  return (
    <h2 className={className} aria-label={text}>
      {words.map((word, wi) => (
        <Fragment key={wi}>
          {wi > 0 ? " " : null}
          <span className="word">
            {[...word].map((ch, ci) => {
              const delay = 0.15 + n++ * 0.07;
              return (
                <span key={ci} style={{ animationDelay: `${delay}s` }}>
                  {ch}
                </span>
              );
            })}
          </span>
        </Fragment>
      ))}
    </h2>
  );
}

export function WordReveal({ text, className }: { text: string; className?: string }) {
  const words = String(text || "").split(" ").filter(Boolean);
  return (
    <h2 className={className}>
      {words.map((word, i) => (
        <Fragment key={i}>
          {i > 0 ? " " : null}
          <span className="word-in" style={{ animationDelay: `${0.25 + i * 0.12}s` }}>
            {word}
          </span>
        </Fragment>
      ))}
    </h2>
  );
}
