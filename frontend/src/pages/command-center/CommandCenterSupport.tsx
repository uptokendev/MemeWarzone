import { useMemo, useState } from "react";
import { Flag, LifeBuoy, Search, ShieldAlert } from "lucide-react";

import { CommandCenterCard } from "@/components/command-center/CommandCenterCard";
import { CommandCenterPageHeader } from "@/components/command-center/CommandCenterPageHeader";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DISCORD_SUPPORT_URL,
  HELP_CATEGORIES,
  searchHelpArticles,
  type HelpCategoryId,
} from "@/lib/helpCenter";
import CommandCenterReportAbuse from "@/pages/command-center/CommandCenterReportAbuse";
import CommandCenterAbuseReports from "@/pages/command-center/CommandCenterAbuseReports";

type SupportPanel = "help" | "report" | "reports";

export default function CommandCenterSupport() {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<HelpCategoryId>("popular");
  const [panel, setPanel] = useState<SupportPanel>("help");
  const searching = query.trim().length > 0;
  const articles = useMemo(() => searchHelpArticles(query, category), [category, query]);

  return (
    <div className="space-y-4">
      <CommandCenterPageHeader
        eyebrow="Support & Safety"
        title="How can we help?"
        description="Search first. Product questions stay in Discord. Impersonation and stolen identity stay in Abuse."
      />

      <CommandCenterCard>
        <label className="sr-only" htmlFor="mwz-help-search">Search MemeWarzone Help</label>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-mw-muted" />
          <Input
            id="mwz-help-search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPanel("help");
            }}
            placeholder="Search MemeWarzone Help"
            className="border-border/60 bg-background/40 pl-10 font-sans"
          />
        </div>
        <div className="-mx-1 mt-3 flex gap-2 overflow-x-auto px-1 pb-1">
          {HELP_CATEGORIES.map((item) => {
            const active = !searching && category === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setCategory(item.id);
                  setQuery("");
                  setPanel("help");
                }}
                className={`shrink-0 rounded-full border px-3 py-1.5 font-semibold font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] transition-colors ${
                  active
                    ? "border-accent/60 bg-accent/15 text-mw-accent-soft"
                    : "border-border/50 bg-background/30 text-mw-muted hover:text-mw-text"
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      </CommandCenterCard>

      {panel === "help" ? (
        <CommandCenterCard
          eyebrow={searching ? "Search results" : HELP_CATEGORIES.find((item) => item.id === category)?.label}
          title={searching ? `Results for “${query.trim()}”` : "Help questions"}
        >
          {articles.length === 0 ? (
            <p className="text-sm text-mw-muted">
              Nothing in Help matches that. Product questions go to Discord. Targeted abuse stays in Report Abuse.
            </p>
          ) : (
            <Accordion type="single" collapsible className="w-full">
              {articles.map((article) => (
                <AccordionItem key={article.id} value={article.id} className="border-border/40 px-3 sm:px-4">
                  <AccordionTrigger className="gap-4 py-3.5 text-left text-sm font-medium hover:no-underline">
                    <span className="min-w-0 flex-1 pr-2">{article.title}</span>
                  </AccordionTrigger>
                  <AccordionContent className="pr-8 text-sm leading-6 text-mw-muted">
                    {article.body}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          )}
        </CommandCenterCard>
      ) : null}

      {panel === "report" ? <CommandCenterReportAbuse embedded /> : null}
      {panel === "reports" ? <CommandCenterAbuseReports embedded /> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <CommandCenterCard
          eyebrow="General support"
          title="Still need help?"
          description="Wallets, trading, launches, rewards and product questions stay in Discord."
        >
          <Button asChild className="font-semibold">
            <a href={DISCORD_SUPPORT_URL} target="_blank" rel="noreferrer">
              <LifeBuoy className="mr-2 h-4 w-4" />
              Open Discord Support
            </a>
          </Button>
        </CommandCenterCard>

        <CommandCenterCard
          eyebrow="Restricted lane"
          title="Report abuse"
          description="Impersonation, stolen images, fake official profiles and phishing. Not failed trades."
        >
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              className="font-semibold"
              onClick={() => setPanel((current) => (current === "report" ? "help" : "report"))}
            >
              <ShieldAlert className="mr-2 h-4 w-4" />
              {panel === "report" ? "Hide report form" : "File Abuse Report"}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="font-semibold"
              onClick={() => setPanel((current) => (current === "reports" ? "help" : "reports"))}
            >
              <Flag className="mr-2 h-4 w-4" />
              {panel === "reports" ? "Hide my reports" : "My Abuse Reports"}
            </Button>

          </div>
        </CommandCenterCard>
      </div>
    </div>
  );
}
