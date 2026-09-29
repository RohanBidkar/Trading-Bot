import { useState } from "react";
import { MAX_MONTHS_BACK, MONTHS, fmtLong, fmtMonth, fmtShort, isWeekday, isoOf, monthsBetween, nowYM, pad, todayISO } from "../lib/dates.js";
import { SCANS, SCAN_ORDER } from "../lib/scans.js";
import { useThemeColors } from "../lib/theme.js";
import ClickSpark from "./bits/ClickSpark.jsx";
import SpotlightCard from "./bits/SpotlightCard.jsx";
import Icon from "./Icon.jsx";

function Choice({ selected, onClick, className = "", spotlight, children }) {
  return (
    <button type="button" className={`spot-btn ${selected ? "selected" : ""} ${className}`} onClick={onClick} aria-pressed={selected}>
      <SpotlightCard spotlightColor={spotlight}>{children}</SpotlightCard>
    </button>
  );
}

/** Days that already have finished results for this scan get a dot. */
function savedDays(runs, scan) {
  const days = new Set();
  for (const r of runs) {
    if (r.status !== "success") continue;
    const matches = r.scan === scan || (r.scan === "both" && (scan === "oversold" || scan === "overbought"));
    if (!matches) continue;
    days.add(r.asOf || isoOf(new Date(r.createdAt)));
  }
  return days;
}

function Calendar({ scan, value, onPick, runs }) {
  const now = nowYM();
  const [view, setView] = useState(value ? { y: +value.slice(0, 4), m: +value.slice(5, 7) - 1 } : now);
  const [dir, setDir] = useState(1);
  const today = todayISO();
  const elapsed = monthsBetween(view, now);
  const saved = savedDays(runs, scan);

  const nav = step => {
    setDir(step);
    setView(v => {
      const d = new Date(Date.UTC(v.y, v.m + step, 1));
      return { y: d.getUTCFullYear(), m: d.getUTCMonth() };
    });
  };

  const total = new Date(Date.UTC(view.y, view.m + 1, 0)).getUTCDate();
  const lead = (new Date(Date.UTC(view.y, view.m, 1)).getUTCDay() + 6) % 7; // Monday first, like Telegram
  const cells = Array.from({ length: lead }, (_, i) => <span key={`b${i}`} />);
  for (let day = 1; day <= total; day++) {
    const iso = `${view.y}-${pad(view.m + 1)}-${pad(day)}`;
    // Weekends and the future are off; holidays stay open because the scanner
    // rolls back to the previous session anyway.
    const ok = isWeekday(iso) && iso <= today;
    cells.push(
      <button key={iso} type="button" disabled={!ok} onClick={() => onPick(iso)}
        className={`day ${iso === today ? "today" : ""} ${iso === value ? "sel" : ""}`}
        aria-label={fmtLong(iso)} aria-pressed={iso === value}>
        {day}
        {ok && saved.has(iso) && <i className="dot" />}
      </button>,
    );
  }

  return (
    <div className="cal">
      <div className="cal-head">
        <button type="button" className="cal-nav" onClick={() => nav(-1)} disabled={elapsed >= MAX_MONTHS_BACK} aria-label="Previous month"><Icon name="chevL" /></button>
        <div className="cal-title"><span key={`${view.y}-${view.m}`} className={dir < 0 ? "back" : ""}>{MONTHS[view.m]} {view.y}</span></div>
        <button type="button" className="cal-nav" onClick={() => nav(1)} disabled={elapsed <= 0} aria-label="Next month"><Icon name="chevR" /></button>
      </div>
      <div className="cal-body">
        <div className="cal-grid static">
          {["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map(d => <span key={d} className="cal-dow">{d}</span>)}
        </div>
        <div key={`${view.y}-${view.m}`} className={`cal-grid ${dir < 0 ? "back" : ""}`}>{cells}</div>
      </div>
      <div className="cal-legend"><span><i />Saved results</span><span>Weekends and future days are off</span></div>
    </div>
  );
}

function MonthGrid({ value, onPick }) {
  const now = nowYM();
  const [year, setYear] = useState(value ? +value.slice(0, 4) : now.y);
  const [dir, setDir] = useState(1);
  const thisMonth = todayISO().slice(0, 7);
  const canPrev = monthsBetween({ y: year - 1, m: 11 }, now) <= MAX_MONTHS_BACK;
  const go = step => { setDir(step); setYear(y => y + step); };

  return (
    <div className="cal">
      <div className="cal-head">
        <button type="button" className="cal-nav" disabled={!canPrev} onClick={() => go(-1)} aria-label="Previous year"><Icon name="chevL" /></button>
        <div className="cal-title"><span key={year} className={dir < 0 ? "back" : ""}>{year}</span></div>
        <button type="button" className="cal-nav" disabled={year >= now.y} onClick={() => go(1)} aria-label="Next year"><Icon name="chevR" /></button>
      </div>
      <div key={year} className={`month-grid ${dir < 0 ? "back" : ""}`}>
        {MONTHS.map((name, m) => {
          const ym = `${year}-${pad(m + 1)}`;
          const ok = ym <= thisMonth && monthsBetween({ y: year, m }, now) <= MAX_MONTHS_BACK;
          return (
            <button key={ym} type="button" disabled={!ok} onClick={() => onPick(ym)} className={`month ${ym === value ? "sel" : ""}`} aria-pressed={ym === value}>
              {name.slice(0, 3)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function Wizard({ onRun, runs }) {
  const [step, setStep] = useState("scan"); // scan | when | date | month
  const [dir, setDir] = useState(1);
  const [scan, setScan] = useState(null);
  const [when, setWhen] = useState(null); // latest | date
  const [date, setDate] = useState(null);
  const [month, setMonth] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const colors = useThemeColors(["--accent", "--accent-glow"]);

  const go = (next, d = 1) => { setDir(d); setStep(next); };
  const reset = () => { setScan(null); setWhen(null); setDate(null); setMonth(null); };

  const pickScan = key => {
    reset();
    setScan(key);
    setError("");
    go(key === "first5" ? "month" : "when");
  };

  const ready = scan && (scan === "first5" ? !!month : when === "latest" || (when === "date" && !!date));

  const run = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError("");
    try {
      await onRun({ scan, asOf: when === "date" ? date : "", month: scan === "first5" ? month : "" });
      reset();
      go("scan", -1);
    } catch (err) {
      setError(err.message || "Couldn't start the scan.");
    } finally {
      setBusy(false);
    }
  };

  const crumbs = [{ label: "New scan", to: "scan" }];
  if (scan) crumbs.push({ label: SCANS[scan].name, to: scan === "first5" ? "month" : "when" });
  if (step === "date") crumbs.push({ label: date ? fmtShort(date) : "Pick a date", to: "date" });
  if (step === "month" && month) crumbs.push({ label: fmtMonth(month), to: "month" });

  const whenText = !scan ? null
    : scan === "first5" ? (month ? fmtMonth(month) : "pick a month")
    : when === "latest" ? "latest bar"
    : when === "date" && date ? `as of ${fmtShort(date)}`
    : "pick when";

  let body;
  if (step === "scan") {
    body = (
      <>
        <h2 className="step-title">What should we scan?</h2>
        <p className="step-sub">The same scans as the Telegram menu. Results from here stay on the website.</p>
        <div className="scan-grid">
          {SCAN_ORDER.map(key => {
            const s = SCANS[key];
            return (
              <Choice key={key} className={s.span ? "span-2" : ""} selected={scan === key} onClick={() => pickScan(key)} spotlight={colors["--accent-glow"]}>
                <div className="spot-top">
                  <span className={`spot-icon ${s.tone ?? ""}`}><Icon name={s.icon} /></span>
                  <span className="tag">{s.tag}</span>
                </div>
                <div>
                  <div className="spot-name">{s.name}</div>
                  <div className="spot-desc">{s.desc}</div>
                </div>
              </Choice>
            );
          })}
        </div>
      </>
    );
  } else if (step === "when") {
    body = (
      <>
        <h2 className="step-title">{SCANS[scan].name}: which bar?</h2>
        <p className="step-sub">Run on the most recent close, or go back up to 24 months.</p>
        <div className="when-grid">
          <Choice selected={when === "latest"} onClick={() => { setWhen("latest"); setDate(null); }} spotlight={colors["--accent-glow"]}>
            <span className="spot-icon accent"><Icon name="latest" /></span>
            <div><div className="spot-name">Latest bar</div><div className="spot-desc">The most recent daily close</div></div>
          </Choice>
          <Choice selected={when === "date"} onClick={() => { setWhen("date"); go("date"); }} spotlight={colors["--accent-glow"]}>
            <span className="spot-icon"><Icon name="pick" /></span>
            <div>
              <div className="spot-name">Pick a date</div>
              <div className="spot-desc">{date ? `Selected ${fmtLong(date)}` : "Choose a past trading day from the calendar"}</div>
            </div>
          </Choice>
        </div>
      </>
    );
  } else if (step === "date") {
    body = (
      <>
        <h2 className="step-title">Pick a trading day</h2>
        <p className="step-sub">Holidays stay open. The scanner rolls back to the session before.</p>
        <Calendar scan={scan} value={date} runs={runs} onPick={iso => { setDate(iso); setWhen("date"); }} />
      </>
    );
  } else {
    body = (
      <>
        <h2 className="step-title">Which month's open?</h2>
        <p className="step-sub">Returns over the first five sessions, measured from the prior month's close.</p>
        <MonthGrid value={month} onPick={setMonth} />
      </>
    );
  }

  return (
    <section className="panel" aria-label="New scan">
      <div className="panel-head"><span className="eyebrow">New scan</span></div>
      <nav className="crumbs" aria-label="Steps">
        {crumbs.map((c, i) => (
          <span key={c.label} style={{ display: "contents" }}>
            {i > 0 && <span className="crumb-sep">›</span>}
            <button type="button" className={`crumb ${i === crumbs.length - 1 ? "current" : ""}`}
              onClick={() => i < crumbs.length - 1 && go(c.to, -1)} aria-current={i === crumbs.length - 1 ? "step" : undefined}>
              {c.label}
            </button>
          </span>
        ))}
      </nav>
      <div className="step-viewport">
        <div key={step} className={`step ${dir < 0 ? "back" : ""}`}>{body}</div>
      </div>
      <div className="wizard-foot">
        <ClickSpark sparkColor={colors["--accent"]} sparkSize={9} sparkRadius={22} sparkCount={10} duration={450}>
          <div className="wizard-foot-inner">
            <div className="selection">{scan ? <><strong>{SCANS[scan].name}</strong> · {whenText}</> : "Choose a scan to start"}</div>
            <button type="button" className="btn-primary" disabled={!ready || busy} onClick={run}>
              {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="play" size={13} />} Run scan
            </button>
          </div>
        </ClickSpark>
        {error && <div className="form-error" role="alert">{error}</div>}
      </div>
    </section>
  );
}
