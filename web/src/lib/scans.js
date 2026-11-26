import { fmtMonth, fmtShort } from "./dates.js";

// The same eight choices as the Telegram menu, in the same order.
export const SCANS = {
  oversold: { name: "Oversold", desc: "Below SMA20 with weak RSI, or a 10%+ drop", tag: "Screen", tone: "down", icon: "down" },
  overbought: { name: "Overbought", desc: "Above SMA20 with strong RSI, or a 10%+ rise", tag: "Screen", tone: "up", icon: "up" },
  both: { name: "Both sides", desc: "Oversold and overbought together in one run", tag: "Screen", tone: "accent", icon: "both", span: true },
  bands: { name: "SMA20 bands", desc: "Every ticker with prices 2.8% either side of SMA20", tag: "Levels", icon: "bands" },
  fxbands: { name: "Forex bands", desc: "Same levels for gold, crypto and majors", tag: "Levels", icon: "fx" },
  last5: { name: "Last 5 days", desc: "Ranking over the latest five sessions", tag: "Ranking", icon: "clock" },
  first5: { name: "First 5 days", desc: "How the month opened, for any month", tag: "Ranking", icon: "cal" },
  moves: { name: "Year movement", desc: "Every ticker's move over D1, D5, D15 … D400", tag: "Movement", icon: "trend", span: true },
};
export const SCAN_ORDER = ["oversold", "overbought", "both", "bands", "fxbands", "last5", "first5", "moves"];

export function runLabel(run) {
  const name = SCANS[run.scan]?.name ?? run.scan;
  if (run.month) return `${name} · ${fmtMonth(run.month)}`;
  if (run.asOf) return `${name} · ${fmtShort(run.asOf)}`;
  return `${name} · latest bar`;
}

export const ACTIVE = new Set(["queued", "running"]);
export const FAILED = new Set(["failure", "cancelled", "stale"]);
