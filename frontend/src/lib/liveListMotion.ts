export function displayedWhileFrozen<T>(
  frozenKeys: string[],
  frozenItems: T[],
  liveItems: T[],
  identity: (item: T) => string,
): T[] {
  const liveByKey = new Map<string, T>();
  for (const item of liveItems) {
    const key = identity(item);
    if (key) liveByKey.set(key, item);
  }
  const frozenByKey = new Map<string, T>();
  for (const item of frozenItems) {
    const key = identity(item);
    if (key) frozenByKey.set(key, item);
  }
  const out: T[] = [];
  for (const key of frozenKeys) {
    const next = liveByKey.get(key) ?? frozenByKey.get(key);
    if (next) out.push(next);
  }
  return out;
}

export function identitiesEqual<T>(a: T[], b: T[], identity: (item: T) => string): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (identity(a[i]) !== identity(b[i])) return false;
  }
  return true;
}

export function measureLiveRects(container: HTMLElement): Map<string, DOMRect> {
  const map = new Map<string, DOMRect>();
  const nodes = container.querySelectorAll<HTMLElement>("[data-live-id]");
  for (const node of nodes) {
    const id = String(node.dataset.liveId || "");
    if (!id) continue;
    map.set(id, node.getBoundingClientRect());
  }
  return map;
}

export function playLiveFlip(container: HTMLElement, first: Map<string, DOMRect>, durationMs = 220) {
  const nodes = container.querySelectorAll<HTMLElement>("[data-live-id]");
  for (const node of nodes) {
    const id = String(node.dataset.liveId || "");
    const prev = first.get(id);
    if (!prev) continue;
    const next = node.getBoundingClientRect();
    const dx = prev.left - next.left;
    const dy = prev.top - next.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    node.style.transform = `translate(${dx}px, ${dy}px)`;
    node.style.transition = "transform 0s";
    requestAnimationFrame(() => {
      node.style.transition = `transform ${durationMs}ms cubic-bezier(0.2, 0.8, 0.2, 1)`;
      node.style.transform = "none";
    });
  }
}
