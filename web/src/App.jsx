import { useCallback, useEffect, useRef, useState } from "react";
import { AuthError, api } from "./api.js";
import { nextScheduled, pad } from "./lib/dates.js";
import { ACTIVE, FAILED } from "./lib/scans.js";
import History from "./components/History.jsx";
import Icon, { BrandMark } from "./components/Icon.jsx";
import Login from "./components/Login.jsx";
import Progress, { Failed } from "./components/Progress.jsx";
import Report from "./components/Report.jsx";
import ThemeToggle, { applyStoredTheme } from "./components/ThemeToggle.jsx";
import Wizard from "./components/Wizard.jsx";

applyStoredTheme();

const POLL_ACTIVE_MS = 4000;
const POLL_IDLE_MS = 30000;

function Countdown() {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick(x => x + 1), 30000);
    return () => clearInterval(t);
  }, []);
  const ms = nextScheduled() - Date.now();
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  return (
    <span className="chip hide-sm" title="The daily scan runs at 21:30 UTC, Monday to Friday">
      <i className="live-dot" />Daily scan in <strong className="num">{h}h {pad(m)}m</strong>
    </span>
  );
}

function Desk({ onSignedOut }) {
  const [runs, setRuns] = useState(null);
  const [activeId, setActiveId] = useState(null);
  const [details, setDetails] = useState({}); // id -> { parts, version }
  const resultsRef = useRef(null);

  const guard = useCallback(err => {
    if (err instanceof AuthError) onSignedOut();
    else console.error(err);
  }, [onSignedOut]);

  const refresh = useCallback(async () => {
    try {
      const data = await api.runs();
      setRuns(data.runs);
      setActiveId(id => id ?? data.runs[0]?.id ?? null);
    } catch (err) {
      guard(err);
    }
  }, [guard]);

  // Poll quickly while anything is queued or running, slowly otherwise.
  const anyActive = runs?.some(r => ACTIVE.has(r.status));
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, anyActive ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(t); window.removeEventListener("focus", onFocus); };
  }, [refresh, anyActive]);

  const active = runs?.find(r => r.id === activeId) ?? null;

  // Fetch the selected run's numbers whenever its status or part count moves.
  const version = active ? `${active.status}:${active.parts.join(",")}` : "";
  useEffect(() => {
    if (!active || details[active.id]?.version === version) return;
    if (active.parts.length === 0 && ACTIVE.has(active.status)) return;
    let cancelled = false;
    api.run(active.id)
      .then(data => { if (!cancelled) setDetails(d => ({ ...d, [active.id]: { parts: data.parts, version } })); })
      .catch(guard);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, version]);

  const startRun = async params => {
    const { run } = await api.start(params).catch(err => { guard(err); throw err; });
    setRuns(rs => [run, ...(rs ?? [])]);
    setActiveId(run.id);
    if (window.innerWidth <= 980) {
      setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
    }
  };

  const signOut = async () => {
    await api.logout().catch(() => {});
    onSignedOut();
  };

  const parts = active ? details[active.id]?.parts : null;
  let pane;
  if (!runs) pane = <section className="panel notice"><p>Loading runs…</p></section>;
  else if (!active) {
    pane = (
      <section className="panel notice">
        <h2>No runs yet</h2>
        <p>Pick a scan on the left and press Run scan. Results show up here in a minute or two.</p>
      </section>
    );
  } else if (ACTIVE.has(active.status)) pane = <Progress run={active} parts={parts} />;
  else if (!parts) pane = <section className="panel notice"><p>Loading results…</p></section>;
  else if (FAILED.has(active.status)) {
    pane = (
      <>
        <Failed run={active} />
        {Object.keys(parts).length > 0 && <Report run={active} parts={parts} />}
      </>
    );
  } else pane = <Report key={active.id} run={active} parts={parts} />;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark"><BrandMark /></span>Scanner Desk</div>
        <div className="topbar-meta">
          <Countdown />
          <ThemeToggle />
          <button type="button" className="icon-btn" onClick={signOut} title="Sign out" aria-label="Sign out"><Icon name="logout" /></button>
        </div>
      </header>
      <div className="layout">
        <aside className="rail">
          <Wizard onRun={startRun} runs={runs ?? []} />
          <History runs={runs ?? []} activeId={activeId} onSelect={setActiveId} />
        </aside>
        <main className="results" ref={resultsRef}>{pane}</main>
      </div>
    </div>
  );
}

export default function App() {
  const [auth, setAuth] = useState("checking"); // checking | out | in

  useEffect(() => {
    api.session()
      .then(s => setAuth(s.authenticated ? "in" : "out"))
      .catch(() => setAuth("out"));
  }, []);

  if (auth === "checking") return <div className="boot" aria-busy="true" />;
  if (auth === "out") return <Login onSuccess={() => setAuth("in")} />;
  return <Desk onSignedOut={() => setAuth("out")} />;
}
