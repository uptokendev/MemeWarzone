import type { ReactNode } from "react";

export function WarzonePageHeader({
  kicker = "Warzone",
  title,
  copy,
  children,
}: {
  kicker?: string;
  title: string;
  copy?: string;
  children?: ReactNode;
}) {
  return (
    <header
      data-warzone-page-header="true"
      className="flex min-w-0 flex-wrap items-start justify-between gap-3 border-b pb-3"
      style={{ borderColor: "var(--mwz-flat-card-border)" }}
    >
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-[0.22em] text-accent/80">{kicker}</div>
        <h1 className="mt-1 font-retro text-xl text-foreground md:text-2xl">{title}</h1>
        {copy ? <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{copy}</p> : null}
      </div>
      {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
    </header>
  );
}
