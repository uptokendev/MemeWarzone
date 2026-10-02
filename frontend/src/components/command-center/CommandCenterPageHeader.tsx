import type { ReactNode } from "react";

type CommandCenterPageHeaderProps = {
  eyebrow?: string;
  title: string;
  description?: string;
  children?: ReactNode;
};

export function CommandCenterPageHeader({
  eyebrow = "Command Center",
  title,
  description,
  children,
}: CommandCenterPageHeaderProps) {
  // UI redesign: the active tab is the visible title (artboard); the header keeps a heading for screen
  // readers and shows only its buttons, as a toolbar row.
  void eyebrow;
  void description;
  return (
    <>
      <h2 className="sr-only">{title}</h2>
      {children ? <div className="mb-3.5 flex flex-wrap items-center justify-end gap-2">{children}</div> : null}
    </>
  );
}
