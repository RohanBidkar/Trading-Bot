import { relTime } from "../lib/dates.js";
import { ACTIVE, FAILED, SCANS, runLabel } from "../lib/scans.js";
import Icon from "./Icon.jsx";

const STATUS_TEXT = { queued: "Queued", running: "Running", success: "Done", failure: "Failed", cancelled: "Cancelled", stale: "No start" };

export default function History({ runs, activeId, onSelect }) {
  return (
    <section className="panel" aria-label="Recent runs">
      <div className="panel-head">
        <span className="eyebrow">Recent runs</span>
        <span className="chip">{runs.length}</span>
      </div>
      {runs.length === 0 ? (
        <p className="empty">Nothing yet. Runs from the website, Telegram and the 4:30pm daily scan all show up here.</p>
      ) : (
        <ul className="hist-list">
          {runs.map(r => {
            const scan = SCANS[r.scan] ?? {};
            const tone = ACTIVE.has(r.status) ? "running" : FAILED.has(r.status) ? "failed" : "";
            return (
              <li key={r.id} className="hist-li">
                <button type="button" className={`hist-item ${r.id === activeId ? "active" : ""}`} onClick={() => onSelect(r.id)}>
                  <span className={`spot-icon ${scan.tone ?? ""}`}><Icon name={scan.icon ?? "bands"} size={15} /></span>
                  <span style={{ minWidth: 0 }}>
                    <div className="hist-title">{runLabel(r)}</div>
                    <div className="hist-meta"><span className="src">{r.source}</span><span>{relTime(r.createdAt)}</span></div>
                  </span>
                  <span className={`status ${tone}`}><i className="s-dot" />{STATUS_TEXT[r.status] ?? r.status}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
