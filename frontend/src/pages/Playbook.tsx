/**
 * Playbook: in-app guide to the Create Coin wizard, Graduation Markets and what happens after launch.
 * Static docs. Facts are read from Create.tsx, GraduationMarketStep.tsx, the quote catalog helpers,
 * shared/dbcQuotes.mjs, graduationBindingRisks.mjs and docs/claude (binding-and-create-path.md,
 * meteora-dbc.md). Update this page when those change.
 */
import { useCallback, useRef } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  BookOpen,
  FileText,
  Rocket,
  ShieldCheck,
  Sparkles,
  Target,
} from "lucide-react";

import { cp } from "@/components/token/coinPageStyles";

const STEPS = [
  { id: "path", n: "01", label: "Path" },
  { id: "identity", n: "02", label: "Identity" },
  { id: "story", n: "03", label: "Story" },
  { id: "bond", n: "04", label: "Bond" },
  { id: "market", n: "05", label: "Market" },
  { id: "review", n: "06", label: "Review" },
] as const;

const EXTRA_SECTIONS = [
  { id: "markets", label: "Graduation Markets" },
  { id: "after", label: "After launch" },
] as const;

const PRIMARY_BTN =
  "mw-focus inline-flex min-h-11 items-center justify-center gap-2 rounded-[10px] border border-mw-accent bg-mw-accent px-4 text-[15px] font-semibold text-[#140A02] hover:bg-[#FF8F3D] disabled:opacity-50";
const JUMP_BTN =
  "mw-focus inline-flex min-h-11 items-center gap-1.5 whitespace-nowrap rounded-full border border-mw-edge bg-[#171B20] px-3.5 text-[14px] font-semibold text-[#C9CED4] hover:border-[#3A424C] hover:bg-[#1F252C] hover:text-mw-text";
const INSET = "rounded-[10px] border border-mw-border bg-mw-input p-3";
const INSET_ACCENT = "rounded-[10px] border border-[#7A3A0C] bg-[#2A1609] p-3 font-mw-body";
const BOX_TITLE = "font-mw-cond text-lg font-bold text-mw-text";
const STRONG = "font-semibold text-mw-text";
const MONO = "font-mw-mono text-mw-text";

function Section({
  id,
  step,
  title,
  subtitle,
  children,
}: {
  id: string;
  step?: string;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className={`${cp.card} scroll-mt-6 p-4 md:p-5`}>
      <div className="flex items-start gap-3">
        {step ? <span className={`${cp.chipAccent} shrink-0 font-mw-mono`}>{step}</span> : null}
        <div className="min-w-0 flex-1">
          <h2 className={`m-0 ${cp.title}`}>{title}</h2>
          {subtitle ? <p className="mt-1 text-[15px] leading-relaxed text-mw-muted">{subtitle}</p> : null}
        </div>
      </div>
      <div className="mt-4 space-y-3 text-[15px] leading-6 text-mw-muted">{children}</div>
    </section>
  );
}

function Rule({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      <span className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full bg-mw-accent" aria-hidden="true" />
      <span className="min-w-0">{children}</span>
    </li>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-mw-border py-2 last:border-b-0 sm:flex-row sm:justify-between sm:gap-4">
      <dt className="text-mw-muted">{label}</dt>
      <dd className="m-0 text-mw-text sm:text-right">{children}</dd>
    </div>
  );
}

const Playbook = () => {
  const scrollRef = useRef<HTMLDivElement>(null);

  const scrollToSection = useCallback((id: string) => {
    const container = scrollRef.current;
    if (!container) return;
    const el = container.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" });
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.hash = id;
      window.history.replaceState({}, "", url.toString());
    }
  }, []);

  return (
    <div
      ref={scrollRef}
      className="h-full w-full overflow-y-auto scrollbar-thin scrollbar-thumb-accent/40 scrollbar-track-muted/20"
    >
      <div className="mx-auto w-full max-w-[1480px] px-1 pb-12 font-mw-body text-mw-text md:px-2">
        <div className="pb-5 pt-4 md:pb-6 md:pt-6">
          <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
            <div className="min-w-0">
              <div className="font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-[#FF9A4D]">Create guide</div>
              <div className="mt-1 flex items-center gap-2.5">
                <BookOpen className="h-7 w-7 shrink-0 text-mw-accent-soft" aria-hidden="true" />
                <h1 className="m-0 font-mw-cond text-[32px] font-bold leading-none lg:text-[40px]">Playbook</h1>
              </div>
              <p className="mt-2 max-w-2xl text-[15px] text-mw-muted">
                Create Coin has six steps: Path, Identity, Story, Bond, Market and Review. This page explains each one,
                how Graduation Markets work on each chain, and what you can do once the coin exists.
              </p>
            </div>
            <Link to="/create" className={`${PRIMARY_BTN} w-full sm:w-auto`}>
              Open Create Coin <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </div>

          <nav className="mt-4 flex flex-wrap gap-2" aria-label="Playbook sections">
            {STEPS.map((item) => (
              <button key={item.id} type="button" className={JUMP_BTN} onClick={() => scrollToSection(item.id)}>
                <span className="font-mw-mono text-[12px] text-mw-accent-soft">{item.n}</span>
                {item.label}
              </button>
            ))}
            {EXTRA_SECTIONS.map((item) => (
              <button key={item.id} type="button" className={JUMP_BTN} onClick={() => scrollToSection(item.id)}>
                {item.label}
              </button>
            ))}
          </nav>
        </div>

        <div className="space-y-4">
          <Section
            id="path"
            step="01"
            title="Path: Draft or Direct deploy"
            subtitle="Create will not let you continue until you pick one."
          >
            <div className="grid gap-3 md:grid-cols-2">
              <div className={INSET_ACCENT}>
                <div className={`flex items-center gap-2 ${BOX_TITLE}`}>
                  <FileText className="h-4 w-4 text-mw-accent-soft" aria-hidden="true" />
                  Draft mode
                </div>
                <p className="mt-1">
                  One wallet signature, no gas. Saves the coin as a draft with its own promotion page. You can build
                  interest there and Push Live when you are ready.
                </p>
              </div>
              <div className={INSET}>
                <div className={`flex items-center gap-2 ${BOX_TITLE}`}>
                  <Rocket className="h-4 w-4 text-mw-accent-soft" aria-hidden="true" />
                  Direct deploy
                </div>
                <p className="mt-1">
                  Uploads the image, asks your wallet to sign the launch transaction and pays gas. When it confirms you
                  land on the coin page. There is no promotion page in between.
                </p>
              </div>
            </div>
            <p>
              The chain is the one your wallet is on. With no wallet connected, Create shows a chain switch at the top.
              Use a Solana wallet for Solana and an EVM wallet on the right network for BNB or Robinhood. If Direct
              deploy is not available for your wallet or chain, the card says why and you can still save a Draft.
            </p>
          </Section>

          <Section
            id="identity"
            step="02"
            title="Identity: image, name, ticker"
            subtitle="The card preview next to the form updates as you type."
          >
            <ul className="m-0 list-none space-y-2 p-0">
              <Rule>
                <span className={STRONG}>Token image</span> is required. PNG, JPG or WebP, up to 5 MB.
              </Rule>
              <Rule>
                <span className={STRONG}>Name</span> is the public coin name, mixed case allowed. The limit is 32 bytes
                and a counter shows how many you have used. An emoji can take up to 4 bytes.
              </Rule>
              <Rule>
                <span className={STRONG}>Ticker</span> uses letters and numbers only, up to 10 characters. A leading $
                and other symbols are dropped, and letters are shown in capitals.
              </Rule>
            </ul>
            <p>
              Create checks the ticker while you type. Next stays locked until the line under the field reads{" "}
              <span className="text-[#6EE7A0]">Ticker is available.</span> A ticker that is taken or reserved blocks the
              step. So does a check that is still running or has failed.
            </p>
          </Section>

          <Section
            id="story"
            step="03"
            title="Story: description and socials"
            subtitle="Tell visitors what the coin is. Socials are optional."
          >
            <ul className="m-0 list-none space-y-2 p-0">
              <Rule>
                <span className={STRONG}>Short description</span> is required, up to 1,000 characters. It shows on the
                card and on the coin page.
              </Rule>
              <Rule>
                Website, X, Telegram, Discord and one other link are optional. For X you can type a handle, a full URL
                or the bare name, for example <span className={MONO}>@memewarzone</span>.
              </Rule>
            </ul>
            <p>Check every link before you continue. Lookalike domains are a common scam.</p>
          </Section>

          <Section
            id="bond"
            step="04"
            title="Bond: graduation market cap, fees and first buy"
            subtitle="The market cap at which your coin moves to its DEX pool, what happens to your fee share, and your own first buy."
          >
            <div className="grid gap-2 sm:grid-cols-2">
              <div className={INSET}>
                <div className="font-mw-mono text-base font-bold text-mw-text">$30K MC</div>
                <div className={cp.label}>Fast grad</div>
                <p className="mt-1 text-[13px]">The coin moves to its DEX pool when its market cap reaches $30K.</p>
              </div>
              <div className={INSET_ACCENT}>
                <div className="font-mw-mono text-base font-bold text-mw-text">$50K MC</div>
                <div className={cp.label}>Normal</div>
                <p className="mt-1 text-[13px]">The default. The coin moves to its DEX pool at a $50K market cap.</p>
              </div>
            </div>
            <p>
              The same two choices apply on Solana, BNB and Robinhood. The pool is on Meteora on Solana, on Topaz on BNB
              and on Uniswap on Robinhood. The market cap is part of the launch and does not change afterwards. Test
              networks also show a small rehearsal target. It never appears on mainnet.
            </p>
            <p>
              Every coin has 1 billion tokens. 85% is sold on the bonding curve, 13% goes into the DEX pool at graduation
              and 2% is the creator reserve, released at graduation. The coin graduates when the curve sells out.
            </p>
            <div className={INSET}>
              <div className={BOX_TITLE}>Creator fee</div>
              <p className="mt-1">Pick what happens to your share of the trade fee. The four options:</p>
              <ul className="m-0 mt-2 list-none space-y-1.5 p-0">
                <Rule><span className={STRONG}>Keep it.</span> Your share of every trade fee is yours to claim.</Rule>
                <Rule><span className={STRONG}>Give it to holders.</span> Your share is paid out to the coin&apos;s holders every week.</Rule>
                <Rule><span className={STRONG}>Split.</span> You keep a percentage and holders get the rest every week.</Rule>
                <Rule><span className={STRONG}>Buyback and burn.</span> Bought back at random times each week and burned.</Rule>
              </ul>
              <p className="mt-2">
                The launch fee starts at 90% and falls to 2% within 60 seconds, so bots that buy at launch pay for it.
                Your own first buy does not.
              </p>
            </div>
            <div className={INSET}>
              <div className={BOX_TITLE}>Your first buy (optional)</div>
              <p className="mt-1">
                You can buy your own coin in the launch transaction, before anyone else, at the normal 2% fee. Type an
                amount or press <span className={STRONG}>MAX</span>. You can buy up to 70% of the supply, with no cost
                limit, so at least 15% stays for everyone else. MAX takes the most your wallet can pay after gas and
                launch fees.
              </p>
              <ul className="m-0 mt-2 list-none space-y-1.5 p-0">
                <Rule>On BNB and Robinhood the first buy is in this step, under the creator fee.</Rule>
                <Rule>On Solana it is in the Market step, because you pay in the token you pick there.</Rule>
                <Rule>The first-buy tokens go to your wallet unlocked.</Rule>
                <Rule>
                  Later buys from the creator wallet on your own coin go into escrow: 20% is released after 30 days, then
                  20% every 7 days.
                </Rule>
              </ul>
            </div>
            <p>
              There is no wait between launches and no limit on how many live coins one wallet can have.
            </p>
            <p>
              <span className={STRONG}>Launch Safety</span> is a collapsible status of the launchpad on your chain. If it
              is not ready, Direct deploy will refuse.
            </p>
          </Section>

          <Section
            id="market"
            step="05"
            title="Market: what your coin pairs with"
            subtitle="Pick the token your coin is paired with after graduation. The full rules are under Graduation Markets below."
          >
            <ul className="m-0 list-none space-y-2 p-0">
              <Rule>
                The step opens with the chain&apos;s own coin selected when the list has one: SOL, BNB, or ETH on
                Robinhood. Keep it and there is nothing more to decide.
              </Rule>
              <Rule>
                The list comes from the approved catalog for your chain. You can search by symbol, name or provider and
                browse by tab, such as Stables and currencies or Stocks and ETFs. A tab only shows when it holds an
                approved token.
              </Rule>
              <Rule>
                Picking anything other than the chain&apos;s own coin opens a confirmation first. You have to choose{" "}
                <span className={STRONG}>I understand, use</span> followed by the symbol, or pick another asset.
              </Rule>
              <Rule>
                On Solana this step shows its own short list: SOL, a stablecoin or a stock token. You pay on the curve in
                the token you pick, and your optional first buy (up to 70% of the supply) is set here.
              </Rule>
            </ul>
            <p>Next stays locked until a market is selected.</p>
          </Section>

          <Section
            id="review"
            step="06"
            title="Review: check and launch"
            subtitle="Last check. Then save the draft or deploy."
          >
            <p>
              The summary lists mode, name, ticker, graduation market cap and the market. On BNB and Robinhood that means
              the Graduation Market pair, quote asset, provider and bonding currency. On Solana it shows the Meteora pool
              the coin graduates into. A creator fee or first buy is listed when it applies. Use Back to
              fix anything.
            </p>
            <div className="grid gap-3 md:grid-cols-2">
              <div className={INSET}>
                <div className={`flex items-center gap-2 ${BOX_TITLE}`}>
                  <FileText className="h-4 w-4 text-mw-accent-soft" aria-hidden="true" />
                  Save Draft
                </div>
                <p className="mt-1">
                  One signature to save, no gas. Next comes the promotion setup page. Push Live later from Command Center,
                  My Coins.
                </p>
              </div>
              <div className={INSET_ACCENT}>
                <div className={`flex items-center gap-2 ${BOX_TITLE}`}>
                  <Rocket className="h-4 w-4 text-mw-accent-soft" aria-hidden="true" />
                  Deploy now
                </div>
                <p className="mt-1">
                  Your wallet signs and pays gas. Stay on the page until the transaction confirms. Then you land on the
                  coin page.
                </p>
              </div>
            </div>
            <p>
              Problems show here before you sign: no wallet connected, wrong network, Direct deploy not ready, or a first
              buy your wallet cannot pay for.
            </p>
          </Section>

          <Section
            id="markets"
            title="Graduation Markets and binding tokens"
            subtitle="Which token your coin is paired with, where the list comes from, and what your choice changes."
          >
            <div className={INSET}>
              <div className={BOX_TITLE}>What the quote token is</div>
              <p className="mt-1">
                Every coin trades against a second token, the quote. When the coin graduates, its pool pairs it with that
                quote, for example <span className={MONO}>$TICKER / USDC</span>. Choosing the quote binds the coin to it.
                Create calls this choice the Graduation Market.
              </p>
            </div>

            <div className={INSET}>
              <div className={BOX_TITLE}>Only approved markets appear</div>
              <p className="mt-1">
                Create only offers tokens on the approved list for the chain you are on. The list loads when you open the
                Market step, so the approved list shown in Create is the current one. A token that stops being eligible
                drops off, and Create checks your pick again before the launch goes through.
              </p>
            </div>

            <div className="grid gap-3 lg:grid-cols-2">
              <div className={INSET}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={BOX_TITLE}>Solana</span>
                  <span className={cp.chipAccent}>Fixed list</span>
                </div>
                <p className="mt-1">
                  Every Solana coin launches on Meteora, and the Market step shows its own list. Mainnet: SOL, USDC, USDT and four
                  xStocks (NVDAx, TSLAx, SPYx, QQQx). Devnet: SOL and USDC. SOL is the default. Picking a stock opens a
                  risk screen you have to confirm.
                </p>
              </div>
              <div className={INSET}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={BOX_TITLE}>Robinhood</span>
                  <span className={cp.chip}>ETH + Stock Tokens</span>
                </div>
                <p className="mt-1">
                  Two paths only: native ETH, or a Robinhood Stock Token from Robinhood&apos;s own registry. A stock is
                  offered only while it passes live checks, including a fresh price feed and at least $50K of pool
                  liquidity. Other tokens are not offered on Robinhood because there is no route to graduate through.
                </p>
              </div>
              <div className={INSET}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={BOX_TITLE}>BNB</span>
                  <span className={cp.chip}>BNB + catalog</span>
                </div>
                <p className="mt-1">
                  BNB is the default. Another token can only be offered once it has a Topaz pool against BNB with enough
                  liquidity. The approved list shown in Create has the ones that qualify today.
                </p>
              </div>
            </div>

            <div className={INSET}>
              <div className={BOX_TITLE}>What your choice changes</div>
              <dl className="m-0 mt-2 text-[14px]">
                <Row label="Bonding currency, BNB and Robinhood">Stays in the chain&apos;s coin: BNB or ETH</Row>
                <Row label="Bonding currency, Solana">The quote you picked, from the first trade</Row>
                <Row label="Pool after graduation">Your coin paired with the quote</Row>
                <Row label="Price after graduation">Moves with your coin and with the quote</Row>
              </dl>
              <p className="mt-2">
                A quote with its own market price, such as a stock or another crypto token, means your coin&apos;s USD
                price can move because of both markets. A stablecoin is counted 1:1 to USD.
              </p>
            </div>

            <div className={INSET}>
              <div className={BOX_TITLE}>What you get at graduation</div>
              <ul className="m-0 mt-2 list-none space-y-1.5 p-0">
                <Rule>
                  <span className={STRONG}>BNB and Robinhood</span>: the coin moves into the pool Create shows as
                  Post-graduation market, paired with the quote you picked, with the liquidity locked. Your 2% creator
                  reserve is released. The 2% graduation fee goes to MemeWarzone&apos;s fee routing, not to the creator.
                </Rule>
                <Rule>
                  <span className={STRONG}>Solana</span>: a <span className={MONO}>$TICKER / quote</span>{" "}
                  pool on Meteora with the liquidity locked. Your 2% creator reserve (20M tokens) unlocks. The 2%
                  graduation fee goes to MemeWarzone&apos;s fee routing, not to the creator.
                </Rule>
              </ul>
            </div>

            <div className={INSET_ACCENT}>
              <div className={BOX_TITLE}>Before you bind to a token other than the chain&apos;s coin</div>
              <ul className="m-0 mt-2 list-none space-y-1.5 p-0 text-[#E8D5C4]">
                <Rule>Graduation locks the pool&apos;s liquidity for good. It cannot be unwound or moved later.</Rule>
                <Rule>Your coin&apos;s price and liquidity follow the quote. If the quote falls or thins out, so does your market.</Rule>
                <Rule>
                  The quote is checked once, at graduation. If its issuer holds powers, such as freezing accounts, Create
                  lists them before you confirm. Choosing the token accepts them for the life of the pool.
                </Rule>
              </ul>
            </div>
          </Section>

          <Section id="after" title="After launch" subtitle="Where your coin lives once it exists.">
            <ul className="m-0 list-none space-y-2 p-0">
              <Rule>
                <span className={STRONG}>Draft</span>: your promotion page. Share it, collect followers and Push Live when
                you are ready.
              </Rule>
              <Rule>
                <span className={STRONG}>Coin page</span>: bonding curve trading starts right after a Direct deploy. The
                page has Posts, Trades, Holders and About tabs. Graduation happens without leaving MemeWarzone.
              </Rule>
              <Rule>
                <span className={STRONG}>Story</span>: opens from the coin page. A full-screen story with your own
                chapters and an automatic chronicle of the coin, with a link you can share.
              </Rule>
              <Rule>
                <span className={STRONG}>UpVote</span>: a paid $3 vote on the coin page. Cooldown and daily limits apply.
              </Rule>
              <Rule>
                <span className={STRONG}>Battles</span>: a launched coin can battle once it graduates. Challenges and
                results are in the Warzone.
              </Rule>
              <Rule>
                Find drafts and live coins in <span className={STRONG}>Command Center, My Coins</span>. For questions use
                Command Center, Support &amp; Safety, or Discord. Report impersonation and stolen identity with Report
                Abuse.
              </Rule>
            </ul>
            <div className="flex flex-wrap gap-2 pt-1">
              <Link to="/create" className={PRIMARY_BTN}>
                <Sparkles className="h-4 w-4" aria-hidden="true" />
                Start Create
              </Link>
              <Link to="/command/support" className={cp.btn}>
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                Support & Safety
              </Link>
              <Link to="/war-room" className={cp.btn}>
                <Target className="h-4 w-4" aria-hidden="true" />
                War Trade Room
              </Link>
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
};

export default Playbook;
