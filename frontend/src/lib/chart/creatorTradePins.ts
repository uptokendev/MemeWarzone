export type CreatorPinLayoutInput = {
  id: string;
  x: number;
  y: number | null;
  timestamp: number;
};

export type CreatorPinLayout = CreatorPinLayoutInput & {
  x: number;
  y: number;
  stackIndex: number;
  stackCount: number;
};

const GROUP_PX = 12;
const LIFT_PX = 44;
const STACK_GAP = 28;
const FAN_PX = 16;
const MIN_Y = 18;
const EDGE = 18;

/**
 * Place creator-buy/sell pills above candles.
 * Same-bar fills must not clamp onto one pixel — ALMOST has two creator buys.
 */
export function layoutCreatorPins(
  pins: CreatorPinLayoutInput[],
  overlay: { width: number; height: number },
): CreatorPinLayout[] {
  const raw = pins.filter((pin) => Number.isFinite(pin.x));
  raw.sort((a, b) => a.x - b.x || a.timestamp - b.timestamp || a.id.localeCompare(b.id));
  const groups: CreatorPinLayoutInput[][] = [];
  for (const pin of raw) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(last[0].x - pin.x) <= GROUP_PX) last.push(pin);
    else groups.push([pin]);
  }

  const next: CreatorPinLayout[] = [];
  const width = overlay.width || 0;
  const height = overlay.height || 0;
  for (const group of groups) {
    group.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
    const stackCount = group.length;
    const placedYs = group.map((pin) => (pin.y != null && Number.isFinite(pin.y) ? pin.y : MIN_Y));
    const anchorY = Math.min(...placedYs);
    const anchorX = group.reduce((sum, pin) => sum + pin.x, 0) / stackCount;
    group.forEach((pin, stackIndex) => {
      const fan = stackCount > 1 ? (stackIndex - (stackCount - 1) / 2) * FAN_PX : 0;
      const rawX = anchorX + fan;
      const safeX = width > 0 ? Math.min(Math.max(rawX, EDGE), width - EDGE) : rawX;
      const sourceY = pin.y != null && Number.isFinite(pin.y) ? pin.y : anchorY;
      const preferred = sourceY - LIFT_PX - stackIndex * STACK_GAP;
      const minStacked = MIN_Y + stackIndex * STACK_GAP;
      let y = Math.max(minStacked, preferred);
      if (height > EDGE * 2) y = Math.min(y, height - EDGE - (stackCount - 1 - stackIndex) * STACK_GAP);
      next.push({ ...pin, x: safeX, y, stackIndex, stackCount });
    });
  }
  return next;
}
