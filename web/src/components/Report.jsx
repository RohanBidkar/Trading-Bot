import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { buildReport, byRsiBuckets } from "../lib/report.js";
import { SCANS } from "../lib/scans.js";
import BlurText from "./bits/BlurText.jsx";
import CountUp from "./bits/CountUp.jsx";
import DataTable from "./DataTable.jsx";
import Icon from "./Icon.jsx";

function Tabs({ items, value, onChange }) {
  const wrap = useRef(null);
  const [pill, setPill] = useState(null);
  useLayoutEffect(() => {
    const el = wrap.current?.querySelector(`[data-id="${value}"]`);
    if (el) setPill({ left: el.offsetLeft, width: el.offsetWidth, top: el.offsetTop, height: el.offsetHeight });
  }, [value, items.length]);
  return (
    <div className="tabs" ref={wrap} role="tablist">
      {pill && <span className="tab-pill" style={pill} />}
      {items.map(t => (
        <button key={t.id} data-id={t.id} role="tab" type="button" aria-selected={t.id === value}
          className={`tab ${t.id === value ? "on" : ""}`} onClick={() => onChange(t.id)}>
          {t.label}<span className="count">{t.count}</span>
        </button>
      ))}
    </div>
  );
}

function Stat({ stat }) {
  return (
    <div className="stat">
      <div className="stat-label">{stat.label}</div>
      <div className={`stat-value ${stat.tone ?? ""}`}>
        {stat.signed && stat.value > 0 ? "+" : ""}
        <CountUp to={stat.value} duration={1.1} />
        {stat.suffix}
      </div>
    </div>
  );
}

export default function Report({ run, parts }) {
  const report = useMemo(() => buildReport(run, parts), [run, parts]);
  const [tab, setTab] = useState(null);
  const [query, setQuery] = useState("");
  const [rsiBuckets, setRsiBuckets] = useState(() => {
    try { return localStorage.getItem("sd-rsi-buckets") === "on"; } catch { return false; }
  });
  const toggleRsiBuckets = () => {
    setRsiBuckets(on => {
      try { localStorage.setItem("sd-rsi-buckets", on ? "off" : "on"); } catch { /* private window */ }
      return !on;
    });
  };
  useEffect(() => { setTab(null); setQuery(""); }, [run.id]);

  if (!report) {
    return (
      <section className="panel notice">
        <span className="eyebrow">{run.source} · {run.id}</span>
        <h2>The run finished but sent nothing back</h2>
        <p>GitHub marked it done, but no results reached the website. Check that the RESULTS_URL and RESULTS_SECRET secrets are set in the GitHub repo.</p>
        {run.ghUrl && <p><a className="chip" href={run.ghUrl} target="_blank" rel="noreferrer">Open the run on GitHub <Icon name="external" size={12} /></a></p>}
      </section>
    );
  }
  if (!report.sections) {
    return (
      <section className="panel notice failed">
        <span className="eyebrow">{run.source} · {run.id}</span>
        <h2>{report.error.title}</h2>
        <p>{report.error.message}</p>
      </section>
    );
  }

  const picked = report.sections.find(s => s.id === tab) ?? report.sections[0];
  const section = picked.rsiBuckets && rsiBuckets ? byRsiBuckets(picked) : picked;
  const scan = SCANS[run.scan] ?? {};

  return (
    <section className="panel" aria-label="Results">
      <div className="report-head">
        <div style={{ minWidth: 0 }}>
          <span className="eyebrow">{scan.tag} · {run.source}</span>
          <BlurText key={run.id} text={report.title} className="report-title blur" delay={70} stepDuration={0.3} />
          <div className="report-sub">{report.sub}</div>
        </div>
        <div className="report-id">
          <span className="mono">{run.id}</span>
          {run.ghUrl && <a className="chip" href={run.ghUrl} target="_blank" rel="noreferrer">GitHub run <Icon name="external" size={12} /></a>}
        </div>
      </div>

      <div className="stats" key={`stats-${run.id}`}>
        {report.stats.map(s => <Stat key={s.label} stat={s} />)}
      </div>

      <div className="toolbar">
        {report.sections.length > 1 ? (
          <Tabs value={section.id} onChange={setTab} items={report.sections.map(s => ({ id: s.id, label: s.tab, count: s.rows.length }))} />
        ) : (
          <span className="eyebrow">{section.rows.length} rows</span>
        )}
        <div className="toolbar-right">
        {picked.rsiBuckets && (
          <button type="button" className={`toggle ${rsiBuckets ? "on" : ""}`} onClick={toggleRsiBuckets} aria-pressed={rsiBuckets}
            title="Sort by RSI, low to high, in 5-point groups">
            <Icon name="rsi" size={14} /> RSI buckets
          </button>
        )}
        <label className="search">
          <Icon name="search" size={14} />
          <input id="ticker-search" type="search" placeholder="Filter tickers" value={query} onChange={e => setQuery(e.target.value)} aria-label="Filter tickers" />
        </label>
        </div>
      </div>

      {section.note && <div className="section-note">{section.note}</div>}
      <DataTable section={section} query={query} animKey={`${run.id}-${section.id}`} />
      <div className="summary">
        {report.summary ? <strong>{report.summary}</strong> : "Click a column to sort. On a phone the table scrolls sideways and the ticker stays pinned."}
      </div>
    </section>
  );
}
