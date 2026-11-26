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

const MOBILE = "(max-width: 980px)";

/** True while the media query matches; follows rotation and resizes. */
function useMedia(query) {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}

/** Phone navigation: one screen per tab instead of the stacked desktop rail. */
function TabBar({ tab, onTab, running }) {
  const items = [
    { id: "scan", label: "Scan", icon: "play" },
    { id: "runs", label: "Runs", icon: "clock", dot: running },
    { id: "results", label: "Results", icon: "chart" },
    { id: "watchlist", label: "Watchlist", icon: "list" },
  ];
  return (
    <nav className="tabbar" aria-label="Sections">
      {items.map(it => (
        <button key={it.id} type="button" className={`tabbar-btn ${tab === it.id ? "on" : ""}`}
          onClick={() => onTab(it.id)} aria-current={tab === it.id ? "page" : undefined}>
          <span className="tabbar-icon"><Icon name={it.icon} size={19} />{it.dot && <i className="tabbar-dot" />}</span>
          <span>{it.label}</span>
        </button>
      ))}
    </nav>
  );
}

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
  const [watchlist, setWatchlist] = useState(null); // { groups, total, names, custom }
  const [scanGroup, setScanGroup] = useState(""); // "" = every group
  const mobile = useMedia(MOBILE);
  const [tab, setTabState] = useState("results"); // phones: scan | runs | results | watchlist
  const setTab = next => {
    setTabState(next);
    window.scrollTo({ top: 0 });
  };

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

  // The groups feed both the Watchlist page and the wizard's group picker.
  useEffect(() => {
    api.watchlist().then(setWatchlist).catch(guard);
  }, [guard]);

  const scanOnGroup = id => {
    setScanGroup(id);
    setView("runs");
    if (mobile) setTab("scan");
    else if (!railOpen) toggleRail();
  };

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
    if (mobile) setTab("results");
  };

  const signOut = async () => {
    await api.logout().catch(() => {});
    onSignedOut();
  };

  const parts = active ? details[active.id]?.parts : null;
  const selectRun = id => {
    setActiveId(id);
    setView("runs");
    if (mobile) setTab("results");
  };

  let pane;
  if (view === "watchlist" && !mobile) {
    pane = <Watchlist watchlist={watchlist} onChange={setWatchlist} onScanGroup={scanOnGroup} onSignedOut={onSignedOut} />;
  }
  else if (!runs) pane = <section className="panel notice"><p>Loading runs…</p></section>;
  else if (!active) {
    pane = (
      <section className="panel notice">
        <h2>No runs yet</h2>
        <p>Pick a scan and press Run scan. Results show up here in a minute or two.</p>
        {mobile && <p><button type="button" className="btn-primary" onClick={() => setTab("scan")}><Icon name="play" size={13} /> New scan</button></p>}
        {!mobile && !railOpen && <p><button type="button" className="btn-primary" onClick={toggleRail}><Icon name="panelOpen" size={14} /> New scan</button></p>}
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

  const wizard = (
    <Wizard onRun={startRun} runs={runs ?? []} groups={watchlist?.groups ?? []} total={watchlist?.total ?? 0}
      group={scanGroup} onGroupChange={setScanGroup} />
  );
  const history = <History runs={runs ?? []} activeId={activeId} onSelect={selectRun} />;
  const watchlistPage = <Watchlist watchlist={watchlist} onChange={setWatchlist} onScanGroup={scanOnGroup} onSignedOut={onSignedOut} />;

  if (mobile) {
    const screen = { scan: wizard, runs: history, watchlist: watchlistPage }[tab];
    // The tab bar sits outside .shell: the shell's entrance animation leaves a
    // transform on it, which would pin a fixed child to the shell, not the screen.
    return (
      <>
      <div className="shell mobile">
        <header className="topbar">
          <div className="brand"><span className="brand-mark"><BrandMark /></span>Scanner Desk</div>
          <div className="topbar-meta">
            <ThemeToggle />
            <button type="button" className="icon-btn" onClick={signOut} title="Sign out" aria-label="Sign out"><Icon name="logout" /></button>
          </div>
        </header>
        <main className="results" key={tab}>{screen ?? pane}</main>
      </div>
      <TabBar tab={tab} onTab={setTab} running={anyActive} />
      </>
    );
  }

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
          <Wizard onRun={startRun} runs={runs ?? []} groups={watchlist?.groups ?? []} total={watchlist?.total ?? 0}
            group={scanGroup} onGroupChange={setScanGroup} />
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
