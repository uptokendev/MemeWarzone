function fmt(v: string | number, dec: number) {
  return Number(v).toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

/** A hidden copy of `el` (same classes and width) showing `text`, placed next to it for measuring. */
function measureProbe(el: HTMLElement, text: string): HTMLElement {
  const probe = el.cloneNode(false) as HTMLElement;
  probe.textContent = text;
  probe.removeAttribute("data-count");
  probe.setAttribute("aria-hidden", "true");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.width = `${el.clientWidth}px`;
  probe.style.fontSize = "";
  el.parentElement?.insertBefore(probe, el.nextSibling);
  return probe;
}

/** Shrink titles, numbers and the chapter body until nothing leaves the frame. */
export function fitSlide(slide: HTMLElement | null | undefined) {
  if (!slide) return;
  const fits = [...slide.querySelectorAll(".fit")] as HTMLElement[];
  fits.forEach((el) => {
    el.style.fontSize = "";
  });
  const widest = (el: HTMLElement) =>
    el.classList.contains("num") && el.dataset.count
      ? `${el.dataset.prefix || ""}${fmt(el.dataset.count, Number(el.dataset.dec || 0))}${el.dataset.suffix || ""}`
      : null;
  fits.forEach((el) => {
    const final = widest(el);
    // A counting number (CountUp) is sized for its final value. Measure that on a hidden copy:
    // writing el.textContent swapped out React's text nodes, so the count-up kept updating detached
    // nodes and the number froze at 0 (K88 Story report, 2026-10-03).
    const target = final ? measureProbe(el, final) : el;
    let size = parseFloat(getComputedStyle(target).fontSize);
    for (let i = 0; i < 40 && target.scrollWidth > target.clientWidth + 1 && size > 14; i++) {
      size *= 0.94;
      target.style.fontSize = `${size}px`;
    }
    if (target !== el) {
      el.style.fontSize = target.style.fontSize;
      target.remove();
    }
  });
  const inner = slide.querySelector(".inner") as HTMLElement | null;
  for (let i = 0; inner && i < 20 && inner.scrollHeight > inner.clientHeight + 1; i++) {
    fits.forEach((el) => {
      el.style.fontSize = `${parseFloat(getComputedStyle(el).fontSize) * 0.92}px`;
    });
  }
}
