import type { CSSProperties, HTMLAttributes, ReactNode } from "react";

const LAYER_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 0,
  pointerEvents: "none",
  overflow: "hidden",
};

export function WarzoneDecorativeLayer({
  children,
  className,
  style,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { children?: ReactNode }) {
  return (
    <div
      data-mwz-decorative-layer="true"
      aria-hidden="true"
      className={className}
      {...rest}
      style={{ ...LAYER_STYLE, ...style }}
    >
      {children}
    </div>
  );
}
