import { useEffect, useState } from "react";

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
// Same precision rule as sma_band_scanner.price(): EURUSD needs 4, BTCUSD none.
const fmtPrice = v => (v == null ? "—" : v < 10 ? v.toFixed(4) : v < 10000 ? v.toFixed(2) : Math.round(v).toLocaleString("en-US"));
const fmtPct = v => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`);
const tone = v => (v > 0 ? "up" : v < 0 ? "down" : "");

function Cell({ col, row }) {
  const v = row[col.key];
  switch (col.kind) {
    case "tkr":
      return <td className="tkr left">{v}</td>;
    case "price":
      return <td>{fmtPrice(v)}</td>;
    case "pctPlain":
      return <td><span className={`v ${tone(v)}`}>{fmtPct(v)}</span></td>;
    case "pct": {
      const width = Math.min(Math.abs(v ?? 0) / col.scale, 1) * 50;
      return (
        <td>
          <span className="pct">
            <span className={`v ${tone(v)}`}>{fmtPct(v)}</span>
            <span className="pbar"><span className={`pfill ${v >= 0 ? "up" : "down"}`} style={{ width: `${width}%` }} /></span>
          </span>
        </td>
      );
    }
    case "rsi":
      return (
        <td>
          <span className="gauge">
            {v == null ? "—" : v.toFixed(1)}
            <span className="gtrack" title="30 / 70 marked"><span className="gmark" style={{ left: `${clamp(v ?? 50, 0, 100)}%` }} /></span>
          </span>
        </td>
      );
    case "band": {
      // The track spans ±(band × 3); the shaded zone is the band itself.
      const span = col.band * 3;
      const pos = x => ((clamp(x, -span, span) + span) / (2 * span)) * 100;
      const where = v <= -col.band ? "down" : v >= col.band ? "up" : "";
      return (
        <td>
          <span className="band" title={`${fmtPct(v)} vs SMA20`}>
            <span className="band-track" />
            <span className="band-zone" style={{ left: `${pos(-col.band)}%`, width: `${pos(col.band) - pos(-col.band)}%` }} />
            <span className="band-mid" />
            <span className={`band-dot ${where}`} style={{ left: `${pos(v)}%` }} />
          </span>
        </td>
      );
    }
    default:
      return <td>{String(v ?? "")}</td>;
  }
}

export default function DataTable({ section, query, animKey }) {
  const [sort, setSort] = useState(null);
  useEffect(() => setSort(null), [section.id]);

  const q = query.trim().toLowerCase();
  let rows = section.rows.filter(r => r.ticker.toLowerCase().includes(q));
  if (sort) rows = [...rows].sort((a, b) => ((a[sort.key] ?? 0) - (b[sort.key] ?? 0)) * sort.dir);

  // Sorting flattens the tier groups; the scanner's own order keeps them.
  const groups = section.group && !sort
    ? section.groupOrder.map(g => ({ g, rows: rows.filter(r => section.group(r) === g) })).filter(x => x.rows.length)
    : [{ g: null, rows }];

  const sortable = c => c.sortable !== false && c.kind !== "tkr";
  const click = c => {
    if (!sortable(c)) return;
    setSort(s => (!s || s.key !== c.key ? { key: c.key, dir: -1 } : s.dir === -1 ? { key: c.key, dir: 1 } : null));
  };

  let index = 0;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {section.columns.map(c => {
              const on = sort?.key === c.key && sortable(c);
              return (
                <th key={c.label} className={`${c.left ? "left" : ""} ${sortable(c) ? "sortable" : ""}`} onClick={() => click(c)}
                  aria-sort={on ? (sort.dir < 0 ? "descending" : "ascending") : undefined} scope="col">
                  {c.label}
                  {sortable(c) && <span className="arrow" style={{ opacity: on ? 1 : 0.25, transform: on && sort.dir > 0 ? "rotate(180deg)" : "none" }}>↓</span>}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody key={`${animKey}-${sort ? sort.key + sort.dir : ""}`}>
          {rows.length === 0 && (
            <tr className="empty-row">
              <td colSpan={section.columns.length}>
                {q ? `No ticker matches “${query}”.` : `No matches · ${section.scanned ?? ""} tickers scanned.`}
              </td>
            </tr>
          )}
          {groups.map(({ g, rows: groupRows }, i) => (
            <GroupRows key={g ?? "all"} label={g} rows={groupRows} columns={section.columns} next={() => index++}
              gap={section.gapped && i > 0} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GroupRows({ label, rows, columns, next, gap }) {
  return (
    <>
      {gap && <tr className="group-gap" aria-hidden="true"><td colSpan={columns.length} /></tr>}
      {label && <tr className="group"><td colSpan={columns.length}>{label} · {rows.length}</td></tr>}
      {rows.map(r => (
        <tr key={r.ticker} className="row" style={{ animationDelay: `${Math.min(next(), 24) * 22}ms` }}>
          {columns.map(c => <Cell key={c.label} col={c} row={r} />)}
        </tr>
      ))}
    </>
  );
}
