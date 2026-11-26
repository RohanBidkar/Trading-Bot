import { useEffect, useMemo, useRef, useState } from "react";
import { AuthError, api } from "../api.js";
import Icon from "./Icon.jsx";

/* ------------------------------ symbol search ----------------------------- */

/** Search Yahoo by company or symbol; Enter on plain text adds it as typed. */
function SymbolSearch({ groupName, inGroup, onAdd, busy, onSignedOut }) {
  const [draft, setDraft] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1);
  const seqRef = useRef(0);

  const term = draft.trim();
  // A list like "AAPL, MSFT" is added as typed; a single word is searched.
  const searchable = term.length >= 1 && !/[\s,;]/.test(term);

  useEffect(() => {
    if (!searchable) { setResults([]); setSearching(false); return; }
    const seq = ++seqRef.current;
    setSearching(true);
    const t = setTimeout(() => {
      api.searchSymbols(term)
        .then(res => { if (seq === seqRef.current) { setResults(res.results ?? []); setHi(-1); } })
        .catch(err => { if (err instanceof AuthError) onSignedOut(); })
        .finally(() => { if (seq === seqRef.current) setSearching(false); });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term, searchable]);

  const add = async symbols => {
    setOpen(false);
    const leftover = await onAdd(symbols);
    setDraft(leftover ?? "");
  };

  const submit = e => {
    e.preventDefault();
    if (busy) return;
    if (open && hi >= 0 && results[hi]) {
      if (!inGroup.has(results[hi].symbol)) add([results[hi].symbol]);
      return;
    }
    const symbols = draft.split(/[\s,;]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
    if (symbols.length) add(symbols);
  };

  const onKeyDown = e => {
    if (!open || !results.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setHi(i => (i + 1) % results.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi(i => (i <= 0 ? results.length - 1 : i - 1)); }
    else if (e.key === "Escape") setOpen(false);
  };

  return (
    <form className="wl-search-form" onSubmit={submit}>
      <div className="wl-combo">
        <div className="field">
          <span className="field-icon"><Icon name="search" size={15} /></span>
          <input value={draft}
            onChange={e => { setDraft(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            onKeyDown={onKeyDown}
            placeholder="Search a company or symbol"
            aria-label={`Add tickers to ${groupName}`}
            autoComplete="off" spellCheck={false}
            role="combobox" aria-expanded={open && results.length > 0} aria-controls="wl-suggest"
            aria-activedescendant={hi >= 0 ? `wl-opt-${hi}` : undefined} />
          {searching && <span className="wl-spin" aria-hidden="true" />}
        </div>
        {open && searchable && (results.length > 0 || !searching) && (
          <ul className="wl-suggest" id="wl-suggest" role="listbox">
            {results.length === 0 && <li className="wl-none">No Yahoo match for “{term}”. Press Enter to add it as typed.</li>}
            {results.map((r, i) => {
              const have = inGroup.has(r.symbol);
              return (
                <li key={r.symbol} id={`wl-opt-${i}`} role="option" aria-selected={i === hi} aria-disabled={have}
                  className={`wl-opt ${i === hi ? "hi" : ""} ${have ? "have" : ""}`}
                  onMouseEnter={() => setHi(i)}
                  onMouseDown={e => { e.preventDefault(); if (!have && !busy) add([r.symbol]); }}>
                  <span className="mono wl-sym">{r.symbol}</span>
                  <span className="wl-name">{r.name}</span>
                  <span className="wl-exch">{have ? "In group" : [r.exchange, r.type].filter(Boolean).join(" · ")}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <button type="submit" className="btn-primary" disabled={busy || !term}>
        {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="plus" size={14} />} Add
      </button>
    </form>
  );
}

/* -------------------------------- group list ------------------------------ */

function GroupList({ groups, activeId, total, onSelect, onCreate }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  const create = async e => {
    e.preventDefault();
    if (!name.trim()) return;
    const err = await onCreate(name.trim());
    if (err) setError(err);
    else { setName(""); setAdding(false); setError(""); }
  };

  return (
    <nav className="wl-groups" aria-label="Watchlist groups">
      <div className="wl-groups-head">
        <span className="eyebrow">Groups</span>
        <span className="wl-total">{total} distinct</span>
      </div>
      <ul>
        {groups.map(g => (
          <li key={g.id}>
            <button type="button" className={`wl-group ${g.id === activeId ? "active" : ""}`}
              onClick={() => onSelect(g.id)} aria-current={g.id === activeId ? "true" : undefined}>
              <span className="wl-group-name">{g.name}</span>
              <span className="wl-count">{g.tickers.length}</span>
            </button>
          </li>
        ))}
      </ul>
      {adding ? (
        <form className="wl-newgroup" onSubmit={create}>
          <input autoFocus value={name} onChange={e => { setName(e.target.value); setError(""); }}
            onKeyDown={e => e.key === "Escape" && (setAdding(false), setName(""), setError(""))}
            placeholder="Group name" maxLength={40} aria-label="New group name" />
          <div className="wl-newgroup-actions">
            <button type="submit" className="btn-primary sm" disabled={!name.trim()}>Create</button>
            <button type="button" className="btn-ghost sm" onClick={() => { setAdding(false); setName(""); setError(""); }}>Cancel</button>
          </div>
          {error && <p className="wl-field-error">{error}</p>}
        </form>
      ) : (
        <button type="button" className="wl-addgroup" onClick={() => setAdding(true)}>
          <Icon name="plus" size={14} /> New group
        </button>
      )}
    </nav>
  );
}

/* ------------------------------- group header ----------------------------- */

function GroupHeader({ group, canDelete, onRename, onDelete, onScan }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(group.name);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);

  useEffect(() => { setEditing(false); setConfirm(false); setName(group.name); setError(""); }, [group.id, group.name]);

  const save = async e => {
    e.preventDefault();
    if (name.trim() === group.name) { setEditing(false); return; }
    const err = await onRename(name.trim());
    if (err) setError(err);
    else setEditing(false);
  };

  return (
    <div className="wl-ghead">
      <div className="wl-ghead-main">
        {editing ? (
          <form className="wl-rename" onSubmit={save}>
            <input autoFocus value={name} maxLength={40} aria-label="Group name"
              onChange={e => { setName(e.target.value); setError(""); }}
              onKeyDown={e => e.key === "Escape" && setEditing(false)} />
            <button type="submit" className="btn-primary sm" disabled={!name.trim()}>Save</button>
            <button type="button" className="btn-ghost sm" onClick={() => setEditing(false)}>Cancel</button>
            {error && <p className="wl-field-error">{error}</p>}
          </form>
        ) : (
          <>
            <h2 className="wl-gtitle">{group.name}</h2>
            <span className="wl-gcount">{group.tickers.length} {group.tickers.length === 1 ? "ticker" : "tickers"}</span>
          </>
        )}
      </div>
      {!editing && (
        <div className="wl-gactions">
          {confirm ? (
            <div className="wl-confirm" role="group" aria-label="Confirm delete">
              <span>Delete “{group.name}” and its {group.tickers.length} tickers?</span>
              <button type="button" className="btn-ghost sm danger" onClick={onDelete}>Delete</button>
              <button type="button" className="btn-ghost sm" onClick={() => setConfirm(false)}>Cancel</button>
            </div>
          ) : (
            <>
              <button type="button" className="btn-primary sm" onClick={onScan} disabled={group.tickers.length === 0}
                title={group.tickers.length ? `Start a scan on ${group.name}` : "Add tickers first"}>
                <Icon name="play" size={12} /> Scan group
              </button>
              <button type="button" className="icon-btn" onClick={() => setEditing(true)} title="Rename group" aria-label="Rename group">
                <Icon name="edit" size={14} />
              </button>
              <button type="button" className="icon-btn danger" onClick={() => setConfirm(true)} disabled={!canDelete}
                title={canDelete ? "Delete group" : "Keep at least one group"} aria-label="Delete group">
                <Icon name="trash" size={14} />
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------- ticker table ----------------------------- */

function TickerTable({ group, groups, names, onRemove, onMove }) {
  const [query, setQuery] = useState("");
  useEffect(() => setQuery(""), [group.id]);

  const others = groups.filter(g => g.id !== group.id);
  const memberOf = useMemo(() => {
    const map = {};
    for (const g of groups) for (const t of g.tickers) (map[t] ??= []).push(g.name);
    return map;
  }, [groups]);

  const q = query.trim().toLowerCase();
  const rows = group.tickers.filter(t => !q || t.toLowerCase().includes(q) || (names[t] ?? "").toLowerCase().includes(q));

  if (group.tickers.length === 0) {
    return (
      <div className="wl-empty">
        <span className="wl-empty-icon"><Icon name="list" size={20} /></span>
        <strong>No tickers in {group.name} yet</strong>
        <span>Search for a company above to add the first one.</span>
      </div>
    );
  }

  return (
    <>
      <div className="wl-tablebar">
        <div className="field wl-filter">
          <span className="field-icon"><Icon name="search" size={13} /></span>
          <input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Filter by symbol or name" aria-label="Filter tickers" />
        </div>
        {q && <span className="wl-matches">{rows.length} of {group.tickers.length}</span>}
      </div>
      <div className="wl-table-wrap">
        <table className="wl-table">
          <thead>
            <tr><th>Symbol</th><th>Company</th><th className="wl-col-also">Also in</th><th aria-label="Actions" /></tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={4} className="wl-norow">No ticker matches “{query}”.</td></tr>}
            {rows.map(t => {
              const also = (memberOf[t] ?? []).filter(n => n !== group.name);
              return (
                <tr key={t}>
                  <td className="wl-tsym">
                    <span className="mono">{t}</span>
                    {names[t] && <span className="wl-tsub">{names[t]}</span>}
                  </td>
                  <td className="wl-tname">{names[t] || <span className="wl-dim">-</span>}</td>
                  <td className="wl-col-also">{also.length ? also.map(n => <span key={n} className="wl-tag">{n}</span>) : <span className="wl-dim">-</span>}</td>
                  <td className="wl-tactions">
                    {others.length > 0 && (
                      <select className="wl-move" value="" onChange={e => e.target.value && onMove(t, e.target.value)}
                        aria-label={`Move ${t} to another group`} title="Move to another group">
                        <option value="">Move to…</option>
                        {others.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                      </select>
                    )}
                    <button type="button" className="wl-remove" onClick={() => onRemove(t)} aria-label={`Remove ${t} from ${group.name}`} title="Remove">
                      <Icon name="x" size={13} sw={2.2} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* --------------------------------- page ---------------------------------- */

export default function Watchlist({ watchlist, onChange, onScanGroup, onSignedOut }) {
  const [activeId, setActiveId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null); // { tone, text }
  const [confirmReset, setConfirmReset] = useState(false);

  const groups = watchlist?.groups ?? [];
  const group = groups.find(g => g.id === activeId) ?? groups[0];

  // Fades a success message after a few seconds; errors stay until dismissed.
  useEffect(() => {
    if (message?.tone !== "ok") return;
    const t = setTimeout(() => setMessage(null), 5000);
    return () => clearTimeout(t);
  }, [message]);

  /** Run one API call; returns the error text instead of throwing. */
  const act = async (fn, ok) => {
    try {
      const res = await fn();
      onChange(res);
      if (ok) setMessage({ tone: "ok", text: typeof ok === "function" ? ok(res) : ok });
      return { res };
    } catch (err) {
      if (err instanceof AuthError) onSignedOut();
      return { error: err.message };
    }
  };

  if (!watchlist) return <section className="panel notice"><p>Loading watchlist…</p></section>;

  const add = async symbols => {
    setBusy(true);
    setMessage(null);
    const { res, error } = await act(() => api.addTickers(group.id, symbols));
    setBusy(false);
    if (error) { setMessage({ tone: "error", text: error }); return symbols.join(" "); }
    const parts = [];
    if (res.added.length) {
      parts.push(`Added ${res.added.map(a => a.ticker).join(", ")} to ${group.name}.`);
      const unchecked = res.added.filter(a => a.status === "unchecked").map(a => a.ticker);
      if (unchecked.length) parts.push(`Couldn't confirm ${unchecked.join(", ")} with Yahoo; check the next scan's log.`);
    }
    if (res.rejected.length) parts.push(`Skipped ${res.rejected.map(r => `${r.ticker} (${r.reason})`).join(", ")}.`);
    setMessage({ tone: res.rejected.length ? (res.added.length ? "warn" : "error") : "ok", text: parts.join(" ") });
    // Rejected symbols stay in the box so a typo can be fixed in place.
    return res.rejected.map(r => r.ticker).join(" ");
  };

  const fail = error => error && setMessage({ tone: "error", text: error });

  const groupName = id => groups.find(g => g.id === id)?.name ?? "";

  return (
    <section className="panel watchlist" aria-label="Watchlist">
      <header className="wl-head">
        <div>
          <span className="eyebrow">Watchlist</span>
          <h1 className="report-title">Tickers &amp; groups</h1>
          <p className="report-sub">
            {watchlist.total} distinct tickers in {groups.length} {groups.length === 1 ? "group" : "groups"}
            {watchlist.custom ? "" : " · built-in list"}. Scans run on every group or on one you pick. Changes apply from the next scan.
          </p>
        </div>
        {watchlist.custom && (
          confirmReset ? (
            <div className="wl-confirm">
              <span>Replace all groups with the built-in list?</span>
              <button type="button" className="btn-ghost sm danger"
                onClick={async () => { setConfirmReset(false); setActiveId(null); fail((await act(api.resetWatchlist, "Back to the built-in groups.")).error); }}>
                Reset
              </button>
              <button type="button" className="btn-ghost sm" onClick={() => setConfirmReset(false)}>Cancel</button>
            </div>
          ) : (
            <button type="button" className="btn-ghost sm" onClick={() => setConfirmReset(true)}>Reset to built-in</button>
          )
        )}
      </header>

      <div className="wl-body">
        <GroupList groups={groups} activeId={group?.id} total={watchlist.total}
          onSelect={id => { setActiveId(id); setMessage(null); }}
          onCreate={async name => {
            const { res, error } = await act(() => api.createGroup(name), `Created ${name}.`);
            if (res?.created) setActiveId(res.created);
            return error;
          }} />

        {group && (
          <div className="wl-main">
            <GroupHeader group={group} canDelete={groups.length > 1}
              onScan={() => onScanGroup(group.id)}
              onRename={async name => (await act(() => api.renameGroup(group.id, name), "Group renamed.")).error}
              onDelete={async () => {
                const name = group.name;
                const { error } = await act(() => api.deleteGroup(group.id), `Deleted ${name}.`);
                if (error) fail(error);
                else setActiveId(null);
              }} />

            <SymbolSearch groupName={group.name} inGroup={new Set(group.tickers)} busy={busy} onAdd={add} onSignedOut={onSignedOut} />

            {message && (
              <div className={`wl-msg ${message.tone}`} role="status">
                <span>{message.text}</span>
                <button type="button" onClick={() => setMessage(null)} aria-label="Dismiss"><Icon name="x" size={12} sw={2.2} /></button>
              </div>
            )}

            <TickerTable group={group} groups={groups} names={watchlist.names ?? {}}
              onRemove={async t => fail((await act(() => api.removeTicker(group.id, t))).error)}
              onMove={async (t, to) => fail((await act(() => api.moveTicker(t, group.id, to), `Moved ${t} to ${groupName(to)}.`)).error)} />
          </div>
        )}
      </div>
    </section>
  );
}
