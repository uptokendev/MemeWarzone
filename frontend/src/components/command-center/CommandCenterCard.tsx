import type { ReactNode } from "react";

type CommandCenterCardProps = {
  title?: string;
  eyebrow?: string;
  description?: string;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
};

export function CommandCenterCard({
  title,
  eyebrow,
  description,
  action,
  children,
  className = "",
}: CommandCenterCardProps) {
  return (
    <section className={`flex flex-col gap-3 rounded-[14px] border border-mw-border bg-mw-surface p-3.5 font-mw-body text-mw-text md:p-[18px] ${className}`}>
      {(eyebrow || title || description || action) && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            {eyebrow && (
              <div className="mb-0.5 font-mw-cond text-xs font-semibold uppercase tracking-[0.08em] text-[#FF9A4D]">
                {eyebrow}
              </div>
            )}
            {title && <h2 className="m-0 font-mw-cond text-xl font-bold tracking-[0.02em] text-mw-text">{title}</h2>}
            {description && <p className="m-0 mt-1 text-sm text-mw-muted">{description}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}
