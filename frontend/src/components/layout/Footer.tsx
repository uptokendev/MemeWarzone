/**
 * Fixed site footer. Copyright sits under the ScreenFrame bottom edge (z-index).
 */
export function Footer() {
  return (
    <footer
      data-mwz-footer="true"
      className="pointer-events-none fixed bottom-0 left-0 right-0 z-[80] border-0 bg-[#050505]/95 px-2 pb-[max(0.45rem,env(safe-area-inset-bottom))] pt-2 text-center font-retro text-[10px] leading-none text-muted-foreground/75 sm:text-xs lg:pl-[var(--mwz-left-sidebar-width,0px)]"
      aria-label="Site footer"
    >
      <span className="relative z-0 inline-block max-w-[min(92vw,42rem)] truncate px-2">
        © 2026 - MemeWarzone. All Rights Reserved.
      </span>
    </footer>
  );
}
