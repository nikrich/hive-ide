/**
 * hexA(hex, alpha) — convert a `#rgb` / `#rrggbb` (with or without leading `#`)
 * to an `rgba(r, g, b, a)` string. Ported verbatim from
 * `design-reference/primitives.jsx`.
 */
export function hexA(hex: string, alpha: number): string {
  const h = hex.replace('#', '')
  const expanded = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const n = parseInt(expanded, 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}
