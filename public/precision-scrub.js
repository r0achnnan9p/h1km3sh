// Shared by the real recorder UI; no playback, timers or network side effects.
export const DAY_MS = 86_400_000;
export function precisionGain(distance) {
  return Math.max(1 / 2880, Math.pow(2, -Math.max(0, Number(distance) - 24) / 14));
}
export function precisionSpan(distance) { return DAY_MS * precisionGain(distance); }
export function precisionDelta(deltaX, width, distance) {
  return Number(deltaX) * precisionSpan(distance) / Math.max(1, Number(width));
}
