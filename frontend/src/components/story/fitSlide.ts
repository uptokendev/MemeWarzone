function fmt(v: string | number, dec: number) {
  return Number(v).toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
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
    const shown = el.textContent;
    if (final) el.textContent = final;
    let size = parseFloat(getComputedStyle(el).fontSize);
    for (let i = 0; i < 40 && el.scrollWidth > el.clientWidth + 1 && size > 14; i++) {
      size *= 0.94;
      el.style.fontSize = `${size}px`;
    }
    if (final) el.textContent = shown;
  });
  const inner = slide.querySelector(".inner") as HTMLElement | null;
  for (let i = 0; inner && i < 20 && inner.scrollHeight > inner.clientHeight + 1; i++) {
    fits.forEach((el) => {
      el.style.fontSize = `${parseFloat(getComputedStyle(el).fontSize) * 0.92}px`;
    });
  }
}
