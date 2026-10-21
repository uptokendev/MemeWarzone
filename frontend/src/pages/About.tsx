/**
 * About: what MemeWarzone is, how a coin's life works, battles, rewards, safety and who runs it.
 * The copy lives in shared/aboutContent.mjs so the API renderer serves the same text to crawlers.
 * Edit the copy there, not here.
 */
import { Link } from "react-router-dom";
import { ArrowRight, Info } from "lucide-react";

import { cp } from "@/components/token/coinPageStyles";
import { ABOUT_INTRO, ABOUT_SECTIONS, ABOUT_TITLE } from "../../shared/aboutContent.mjs";

const PRIMARY_BTN =
  "mw-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50";
const JUMP_BTN =
  "mw-focus inline-flex min-h-11 items-center gap-1.5 whitespace-nowrap rounded-full border border-mw-edge bg-[#171B20] px-3.5 text-[14px] font-semibold text-[#C9CED4] hover:border-[#3A424C] hover:bg-[#1F252C] hover:text-mw-text";

type AboutLink = { href: string; text: string };

function SectionLink({ link }: { link: AboutLink }) {
  if (link.href.startsWith("/")) {
    return (
      <Link to={link.href} className={cp.btn}>
        {link.text}
      </Link>
    );
  }
  return (
    <a href={link.href} target="_blank" rel="noopener noreferrer" className={cp.btn}>
      {link.text}
    </a>
  );
}

const About = () => (
  <div className="h-full w-full overflow-y-auto scrollbar-thin scrollbar-thumb-accent/40 scrollbar-track-muted/20">
    <div className="mx-auto w-full max-w-[1100px] px-1 pb-12 font-mw-body text-mw-text md:px-2">
      <div className="pb-5 pt-4 md:pb-6 md:pt-6">
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
          <div className="min-w-0">
            <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-[#FF9A4D]">About</div>
            <div className="mt-1 flex items-center gap-2.5">
              <Info className="h-7 w-7 shrink-0 text-mw-accent-soft" aria-hidden="true" />
              <h1 className="m-0 font-mw-cond text-[32px] font-bold leading-none lg:text-[40px]">{ABOUT_TITLE}</h1>
            </div>
            <div className="mt-3 max-w-3xl space-y-2 text-[15px] leading-6 text-mw-muted">
              {ABOUT_INTRO.map((line) => (
                <p key={line} className="m-0">
                  {line}
                </p>
              ))}
            </div>
          </div>
          <Link to="/create" className={`${PRIMARY_BTN} w-full shrink-0 sm:w-auto`}>
            Launch a coin <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>

        <nav className="mt-4 flex flex-wrap gap-2" aria-label="About sections">
          {ABOUT_SECTIONS.map((s) => (
            <a key={s.id} href={`#${s.id}`} className={JUMP_BTN}>
              {s.heading}
            </a>
          ))}
        </nav>
      </div>

      <div className="space-y-4">
        {ABOUT_SECTIONS.map((s) => (
          <section key={s.id} id={s.id} className={`${cp.card} scroll-mt-6 p-4 md:p-5`}>
            <h2 className={`m-0 ${cp.title}`}>{s.heading}</h2>
            <div className="mt-3 space-y-3 text-[15px] leading-6 text-mw-muted">
              {(s.paragraphs || []).map((line) => (
                <p key={line} className="m-0">
                  {line}
                </p>
              ))}
              {s.items?.length ? (
                <ul className="m-0 list-none space-y-2 p-0">
                  {s.items.map((item) => (
                    <li key={item} className="flex gap-2">
                      <span className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full bg-mw-accent" aria-hidden="true" />
                      <span className="min-w-0">{item}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {s.note ? <p className="m-0">{s.note}</p> : null}
              {s.links?.length ? (
                <div className="flex flex-wrap gap-2 pt-1">
                  {s.links.map((link) => (
                    <SectionLink key={link.href} link={link} />
                  ))}
                </div>
              ) : null}
            </div>
          </section>
        ))}
      </div>
    </div>
  </div>
);

export default About;
