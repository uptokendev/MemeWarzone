/**
 * Default profile picture for wallets without one (founder, 2026-10-02): the "Creator" operative,
 * black kit with a green visor, from MWZ_profile_placeholders. Not the logo soldier.
 */
const KIT = { shell: "#1c1e1c", plate: "#2a2c2a", visor: "#3dff78" };

export function OperativeSvg({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg viewBox="0 0 96 96" aria-hidden="true" className={className} style={style}>
      <circle cx="48" cy="46" r="30" fill={KIT.shell} />
      <path d="M28 34 h40 v8 h-40 z" fill="#0e0e0c" opacity=".35" />
      <rect x="40" y="22" width="16" height="8" rx="1" fill={KIT.plate} />
      <rect x="30" y="40" width="36" height="5" rx="1" fill={KIT.visor} />
      <path d="M22 58 h52 l6 22 H16 z" fill={KIT.plate} />
      <rect x="34" y="66" width="28" height="8" fill="#0e0e0c" opacity=".25" />
    </svg>
  );
}

/** `mw-operative` keeps `rounded-full` working under the legacy square-corner CSS (see mw-v2.css). Round mark with the green role ring. `size` in px; pass `fill` to fill a parent that already draws the frame. */
export function OperativeMark({ size = 44, fill = false, className = "" }: { size?: number; fill?: boolean; className?: string }) {
  if (fill) {
    return (
      <span className={`flex h-full w-full items-center justify-center bg-[#0c0d0b] ${className}`} aria-hidden="true">
        <OperativeSvg style={{ width: "76%", height: "76%" }} />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`mw-operative flex shrink-0 items-center justify-center rounded-full ${className}`}
      style={{
        width: size,
        height: size,
        background: "#0c0d0b",
        border: "2px solid #2c3026",
        boxShadow: "inset 0 0 0 3px #0c0d0b, 0 0 0 2px #3dff78",
      }}
    >
      <OperativeSvg style={{ width: Math.round(size * 0.76), height: Math.round(size * 0.76) }} />
    </span>
  );
}
