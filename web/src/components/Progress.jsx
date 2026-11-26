import { relTime } from "../lib/dates.js";
import { SCANS, runLabel } from "../lib/scans.js";
import ShinyText from "./bits/ShinyText.jsx";
import Icon from "./Icon.jsx";

// Which scripts post a part for each scan; "both" runs two.
const EXPECTED = { both: ["oversold", "overbought"] };

export default function Progress({ run, parts }) {
  const expected = EXPECTED[run.scan] ?? [run.scan];
  const arrived = expected.filter(p => parts?.[p]);
  const running = run.status === "running";

  const phases = [
    { label: "Queued on GitHub Actions", sub: "Starting a runner. This usually takes 20–40 seconds.", done: running, on: !running },
    { label: "Fetching prices", sub: "Daily bars from Yahoo Finance", done: running && arrived.length > 0, on: running && arrived.length === 0 },
    {
      label: "Running the scan",
      sub: expected.length > 1 ? expected.map(p => `${SCANS[p].name} ${parts?.[p] ? "✓" : "…"}`).join("  ·  ") : "SMA20, RSI(14) and moves",
      done: false,
      on: running && arrived.length > 0,
      right: expected.length > 1 ? `${arrived.length}/${expected.length}` : "",
    },
  ];
  const pct = !running ? 12 : arrived.length === 0 ? 40 : 40 + (arrived.length / expected.length) * 50;

  return (
    <section className="panel progress" aria-live="polite">
      <span className="eyebrow">{run.source}{run.group ? ` · ${run.group}` : ""} · {run.id}</span>
      <h1 className="report-title">
        <ShinyText text={runLabel(run)} color="var(--muted)" shineColor="var(--fg)" speed={1.8} />
      </h1>
      <div className="report-sub">Started {relTime(run.createdAt)} · results appear here on their own</div>
      <div className="prog-bar"><div className="prog-fill" style={{ width: `${pct}%` }} /></div>
      <ol className="phases">
        {phases.map(p => (
          <li key={p.label} className={`phase ${p.done ? "done" : p.on ? "on" : ""}`}>
            <span className="ph-icon">{p.done && <Icon name="check" size={12} sw={2.6} />}</span>
            <span><div>{p.label}</div><div className="ph-sub">{p.sub}</div></span>
            <span className="ph-right mono">{p.right}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

const FAIL_COPY = {
  failure: ["The scan failed", "GitHub reported an error while it ran. The log on GitHub says which step broke."],
  cancelled: ["The scan was cancelled", "Someone stopped the run on GitHub before it finished."],
  stale: ["GitHub never started this run", "It was queued more than 15 minutes ago and nothing has reported back. Check the Actions tab and the GITHUB_TOKEN permissions."],
};

export function Failed({ run }) {
  const [title, body] = FAIL_COPY[run.status] ?? FAIL_COPY.failure;
  return (
    <section className="panel notice failed" role="alert">
      <span className="eyebrow">{run.source} · {run.id}</span>
      <h2>{title}</h2>
      <p>{body}</p>
      {run.ghUrl && <p><a className="chip" href={run.ghUrl} target="_blank" rel="noreferrer">Open the run on GitHub <Icon name="external" size={12} /></a></p>}
    </section>
  );
}
