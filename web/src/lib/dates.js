// Date helpers. Everything is UTC and ISO (YYYY-MM-DD), the same as the
// Worker's validation, so a day picked here is the day the scanner receives.

export const MAX_MONTHS_BACK = 24; // matches LOOKBACK_HISTORICAL ("2y") in scanner_core.py

export const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const pad = n => String(n).padStart(2, "0");
export const isoOf = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
export const dateOf = iso => new Date(`${iso}T00:00:00Z`);
export const todayISO = () => isoOf(new Date());
export const isWeekday = iso => { const w = dateOf(iso).getUTCDay(); return w !== 0 && w !== 6; };

export function nowYM() {
  const d = new Date();
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() };
}
export const monthsBetween = (a, b) => (b.y - a.y) * 12 + (b.m - a.m);

export function fmtLong(iso) {
  const d = dateOf(iso);
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCFullYear()}`;
}
export function fmtShort(iso) {
  const d = dateOf(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)} ${d.getUTCFullYear()}`;
}
export function fmtMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

export function relTime(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return fmtShort(isoOf(new Date(ms)));
}
