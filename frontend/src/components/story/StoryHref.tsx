import type { ReactNode, MouseEvent } from "react";
import { Link } from "react-router-dom";

export function StoryHref({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  const stop = (e: MouseEvent) => e.stopPropagation();
  if (href.startsWith("/")) {
    return (
      <Link to={href} className={className} onClick={stop}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} className={className} target="_blank" rel="noreferrer" onClick={stop}>
      {children}
    </a>
  );
}
