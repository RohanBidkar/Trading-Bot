// Turns the raw numbers the scanners post back (see publish_result in
// scanner_core.py) into what the results pane draws: a title, stat tiles and
// one table per setup.

import { fmtLong } from "./dates.js";

const TIERS = ["$100 and under", "Above $100"]; // sort_by_tier lists the cheaper names first
const byTier = r => (r.close > 100 ? "Above $100" : "$100 and under");

const col = (key, label, kind, extra = {}) => ({ key, label, kind, ...extra });
const TKR = col("ticker", "STK", "tkr", { left: true });

// Telegram titles carry an emoji and markup-free text; the tab already says
// which setup it is, so the note only needs the words.
const stripEmoji = s => (s || "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

function screen(run, parts) {
  const sides = run.scan === "both" ? ["oversold", "overbought"] : [run.scan];
  const present = sides.filter(s => parts[s]?.kind === "screen");
  if (!present.length) return null;

  const sections = present.flatMap(side => {
    const part = parts[side];
    const over = side === "overbought";
    const letters = over ? ["C", "D"] : ["A", "B"];
    return part.sections.map((s, i) => {
      const sma = s.key === "diff";
      const label = sma ? (over ? "Above SMA20" : "Below SMA20") : over ? "Sharp rise" : "Sharp drop";
      return {
        id: `${side}-${i}`,
        side,
        tab: `${letters[i] ?? i + 1} · ${label}`,
        note: stripEmoji(s.title),
        columns: sma
          ? [TKR, col("close", "Close", "price"), col("diff", "Diff", "pct", { scale: 8 }), col("sma", "SMA20", "price"), col("rsi", "RSI", "rsi"), col("move", "D10", "pctPlain")]
          : [TKR, col("close", "Close", "price"), col("move", "D10", "pct", { scale: 15 }), col("sma", "SMA20", "price"), col("rsi", "RSI", "rsi")],
        rows: s.rows,
        group: byTier,
        groupOrder: TIERS,
        scanned: part.scanned,
      };
    });
  });

  const first = parts[present[0]];
  const matches = side => new Set(sections.filter(s => s.side === side).flatMap(s => s.rows.map(r => r.ticker))).size;
  const stats =
    run.scan === "both"
      ? [
          { label: "Oversold matches", value: matches("oversold"), tone: "down" },
          { label: "Overbought matches", value: matches("overbought"), tone: "up" },
          { label: "Tickers scanned", value: first.scanned },
        ]
      : sections.map(s => ({ label: `Setup ${s.tab.split(" · ")[0]} matches`, value: s.rows.length, tone: run.scan === "oversold" ? "down" : "up" }))
          .concat([{ label: "Tickers scanned", value: first.scanned }]);

  return {
    title: run.scan === "both" ? "Oversold and overbought" : first.title,
    sub: `Bar ${fmtLong(first.bar)}${run.asOf ? " · backdated" : ""}`,
    stats,
    sections,
  };
}

function bands(run, part) {
  const b = part.band;
  const below = part.rows.filter(r => r.diff <= -b).length;
  const above = part.rows.filter(r => r.diff >= b).length;
  const moves = (part.moves || []).map(n => col(`d${n}`, `D${n}`, "pctPlain"));
  return {
    title: part.title,
    sub: `Bar ${fmtLong(part.bar)} · most stretched below first`,
    stats: [
      { label: "At or below the low band", value: below, tone: "down" },
      { label: "At or above the high band", value: above, tone: "up" },
      { label: "Inside the band", value: part.rows.length - below - above },
    ],
    sections: [{
      id: run.scan,
      tab: "All levels",
      note: `Low and high are SMA20 × (1 ∓ ${b.toFixed(1)}%). The dot shows where the close sits against the band.`,
      columns: [
        part.forex ? { ...TKR, label: "Pair" } : TKR,
        ...moves,
        col("diff", "Diff", "pctPlain"),
        col("rsi", "RSI14", "rsi"),
        col("sma", "SMA20", "price"),
        col("close", "Close", "price"),
        col("low", `−${b.toFixed(1)}%`, "price"),
        col("high", `+${b.toFixed(1)}%`, "price"),
        col("diff", "Band", "band", { band: b, sortable: false }),
      ],
      rows: part.rows,
      group: part.forex ? null : byTier,
      groupOrder: TIERS,
      scanned: part.rows.length,
      rsiBuckets: true,
    }],
  };
}

// The RSI ladder for the bands tables: lower bound inclusive, so exactly 40.0
// sits in "RSI 40–45". Anything 70 or over gets a group of its own.
const RSI_BUCKETS = [
  [35, "RSI below 35"],
  [40, "RSI 35–40"],
  [45, "RSI 40–45"],
  [50, "RSI 45–50"],
  [55, "RSI 50–55"],
  [60, "RSI 55–60"],
  [65, "RSI 60–65"],
  [70, "RSI 65–70"],
  [Infinity, "RSI 70 and above"],
];

function rsiBucket(rsi) {
  if (rsi == null) return "No RSI";
  return RSI_BUCKETS.find(([below]) => rsi < below)[1];
}

/** The same table, ordered by RSI low to high and split into the ladder. */
export function byRsiBuckets(section) {
  return {
    ...section,
    id: `${section.id}-rsi`,
    rows: [...section.rows].sort((a, b) => (a.rsi ?? Infinity) - (b.rsi ?? Infinity)),
    group: r => rsiBucket(r.rsi),
    groupOrder: [...RSI_BUCKETS.map(([, label]) => label), "No RSI"],
    gapped: true,
  };
}

function returns(run, part) {
  const rows = part.rows;
  const up = rows.filter(r => r.ret > 0).length;
  const avg = rows.reduce((s, r) => s + r.ret, 0) / (rows.length || 1);
  const strong = part.strong_move ?? 5;
  const movers = rows.filter(r => Math.abs(r.ret) >= strong).length;
  return {
    title: part.title,
    sub: `${part.span} · measured from the prior close`,
    stats: [
      { label: "Up", value: up, tone: "up" },
      { label: "Down", value: rows.length - up, tone: "down" },
      { label: "Average return", value: Math.round(avg * 10) / 10, suffix: "%", signed: true, tone: avg >= 0 ? "up" : "down" },
      { label: `Moved ${strong}% or more`, value: movers },
    ],
    sections: [{
      id: run.scan,
      tab: "Ranking",
      columns: [TKR, col("base", "Prev", "price"), col("last", "Last", "price"), col("ret", "Ret", "pct", { scale: 8 })],
      rows,
      group: r => (r.ret > 0 ? "Up" : "Down"),
      groupOrder: ["Up", "Down"],
      scanned: rows.length,
    }],
    summary: `${up} up / ${rows.length - up} down of ${rows.length} · average ${avg >= 0 ? "+" : ""}${avg.toFixed(1)}%, ${movers} moved ${strong}%+`,
  };
}

function moves(run, part) {
  const rows = part.rows;
  const days = part.moves || [];
  const count = (key, up) => rows.filter(r => r[key] != null && (up ? r[key] > 0 : r[key] < 0)).length;
  const avg = key => {
    const vals = rows.map(r => r[key]).filter(v => v != null);
    return vals.length ? Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10 : 0;
  };
  const a200 = avg("d200");
  return {
    title: part.title,
    sub: `Bar ${fmtLong(part.bar)} · % change in the close over N trading days`,
    stats: [
      { label: "Up on the day", value: count("d1", true), tone: "up" },
      { label: "Down on the day", value: count("d1", false), tone: "down" },
      { label: "Up over 200 days", value: count("d200", true), tone: "up" },
      { label: "Average D200", value: a200, suffix: "%", signed: true, tone: a200 >= 0 ? "up" : "down" },
    ],
    sections: [{
      id: run.scan,
      tab: "All tickers",
      note: "D22 ≈ one month, D200 ≈ ten months, D400 ≈ a year and a half. “—” means not enough history for that window.",
      columns: [TKR, col("close", "Close", "price"), ...days.map(n => col(`d${n}`, `D${n}`, "pctPlain"))],
      rows,
      group: byTier,
      groupOrder: TIERS,
      scanned: rows.length,
    }],
  };
}

/** The view model for one run, or null while nothing has arrived yet. */
export function buildReport(run, parts = {}) {
  const error = Object.values(parts).find(p => p?.kind === "error");
  let report = null;
  if (["oversold", "overbought", "both"].includes(run.scan)) report = screen(run, parts);
  else if (parts[run.scan]?.kind === "bands") report = bands(run, parts[run.scan]);
  else if (parts[run.scan]?.kind === "returns") report = returns(run, parts[run.scan]);
  else if (parts[run.scan]?.kind === "moves") report = moves(run, parts[run.scan]);
  if (!report && error) return { error };
  return report ? { ...report, error } : null;
}
