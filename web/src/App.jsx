import { useCallback, useEffect, useRef, useState } from "react";
import { AuthError, api } from "./api.js";
import { ACTIVE, FAILED } from "./lib/scans.js";
import History from "./components/History.jsx";
import Icon, { BrandMark } from "./components/Icon.jsx";
import Login from "./components/Login.jsx";
import Progress, { Failed } from "./components/Progress.jsx";
import Report from "./components/Report.jsx";
import ThemeToggle, { applyStoredTheme } from "./components/ThemeToggle.jsx";
import Watchlist from "./components/Watchlist.jsx";
import Wizard from "./components/Wizard.jsx";

applyStoredTheme();

const POLL_ACTIVE_MS = 4000;
const POLL_IDLE_MS = 30000;

function storedRail() {
  try { return localStorage.getItem("sd-rail") !== "closed"; } catch { return true; }
}

function Desk({ onSignedOut }) {
  const [runs, setRuns] = useState(null);
  const [activeId, setActiveId] = useState(null);
  const [details, setDetails] = useState({}); // id -> { parts, version }
  const resultsRef = useRef(null);
  const [railOpen, setRailOpen] = useState(storedRail);
  const [view, setView] = useState("runs"); // runs | watchlist

  const toggleRail = () => {
    setRailOpen(open => {
      try { localStorage.setItem("sd-rail", open ? "closed" : "open"); } catch { /* private window */ }
      return !open;
    });
  };

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
    setView("runs");
    if (window.innerWidth <= 980) {
      setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
    }
  };

  const signOut = async () => {
    await api.logout().catch(() => {});
    onSignedOut();
  };

  const parts = active ? details[active.id]?.parts : null;
  const selectRun = id => {
    setActiveId(id);
    setView("runs");
  };

  let pane;
  if (view === "watchlist") pane = <Watchlist onSignedOut={onSignedOut} />;
  else if (!runs) pane = <section className="panel notice"><p>Loading runs…</p></section>;
  else if (!active) {
    pane = (
      <section className="panel notice">
        <h2>No runs yet</h2>
        <p>Pick a scan and press Run scan. Results show up here in a minute or two.</p>
        {!railOpen && <p><button type="button" className="btn-primary" onClick={toggleRail}><Icon name="panelOpen" size={14} /> New scan</button></p>}
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
        <button type="button" className="icon-btn rail-toggle" onClick={toggleRail}
          aria-expanded={railOpen} aria-controls="rail"
          title={railOpen ? "Hide scans and runs" : "Show scans and runs"}
          aria-label={railOpen ? "Hide scans and runs" : "Show scans and runs"}>
          <Icon name={railOpen ? "panelClose" : "panelOpen"} />
        </button>
        <div className="topbar-meta">
          <button type="button" className={`chip-btn ${view === "watchlist" ? "active" : ""}`}
            onClick={() => setView(v => (v === "watchlist" ? "runs" : "watchlist"))}
            aria-pressed={view === "watchlist"} title="Edit the tickers every scan runs on">
            <Icon name="list" size={14} /> Watchlist
          </button>
          <ThemeToggle />
          <button type="button" className="icon-btn" onClick={signOut} title="Sign out" aria-label="Sign out"><Icon name="logout" /></button>
        </div>
      </header>
      <div className={`layout ${railOpen ? "" : "rail-closed"}`}>
        <aside className="rail" id="rail" inert={railOpen ? undefined : ""} aria-hidden={!railOpen}>
          <Wizard onRun={startRun} runs={runs ?? []} />
          <History runs={runs ?? []} activeId={activeId} onSelect={selectRun} />
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
