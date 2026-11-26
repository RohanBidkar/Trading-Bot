import { useEffect, useMemo, useRef, useState } from "react";
import { AuthError, api } from "../api.js";
import Icon from "./Icon.jsx";

/** The tickers every scan runs on. Edits apply from the next scan. */
export default function Watchlist({ onSignedOut }) {
  const [list, setList] = useState(null); // { tickers, custom }
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null); // { tone: "ok" | "error" | "warn", text }
  const [confirmReset, setConfirmReset] = useState(false);
  const [recent, setRecent] = useState({}); // ticker -> name, for this session's additions
  const [results, setResults] = useState([]); // Yahoo search matches for the typed text
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(-1); // highlighted suggestion
  const searchSeq = useRef(0);

  // Search Yahoo while a single word is typed; a list like "AAPL, MSFT" is
  // added as typed instead.
  const term = draft.trim();
  const searchable = term.length >= 1 && !/[\s,;]/.test(term);
  useEffect(() => {
    if (!searchable) { setResults([]); setSearching(false); return; }
    const seq = ++searchSeq.current;
    setSearching(true);
    const t = setTimeout(() => {
      api.searchSymbols(term)
        .then(res => { if (seq === searchSeq.current) { setResults(res.results ?? []); setHi(-1); } })
        .catch(err => { if (err instanceof AuthError) onSignedOut(); })
        .finally(() => { if (seq === searchSeq.current) setSearching(false); });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term, searchable]);

  const fail = err => {
    if (err instanceof AuthError) onSignedOut();
    else setMessage({ tone: "error", text: err.message });
  };

  useEffect(() => {
    api.watchlist().then(setList).catch(fail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = e => {
    e.preventDefault();
    if (open && hi >= 0 && results[hi]) return add([results[hi].symbol]);
    add(draft.split(/[\s,;]+/));
  };

  const onKeyDown = e => {
    if (!open || !results.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setHi(i => (i + 1) % results.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHi(i => (i <= 0 ? results.length - 1 : i - 1)); }
    else if (e.key === "Escape") setOpen(false);
  };

  const add = async raw => {
    const symbols = raw.map(s => s.trim().toUpperCase()).filter(Boolean);
    if (!symbols.length || busy) return;
    setOpen(false);
    setBusy(true);
    setMessage(null);
    try {
      const res = await api.addTickers(symbols);
      setList({ tickers: res.tickers, custom: res.custom });
      setRecent(r => ({ ...r, ...Object.fromEntries(res.added.map(a => [a.ticker, a.name || ""])) }));
      const parts = [];
      if (res.added.length) {
        parts.push(`Added ${res.added.map(a => (a.name ? `${a.ticker} (${a.name})` : a.ticker)).join(", ")}.`);
        const unchecked = res.added.filter(a => a.status === "unchecked").map(a => a.ticker);
        if (unchecked.length) parts.push(`Couldn't reach Yahoo to confirm ${unchecked.join(", ")}, so check the next scan's log.`);
      }
      if (res.rejected.length) parts.push(`Skipped ${res.rejected.map(r => `${r.ticker}: ${r.reason}`).join("; ")}.`);
      setMessage({ tone: res.rejected.length ? (res.added.length ? "warn" : "error") : "ok", text: parts.join(" ") });
      // Keep the rejected ones in the box so a typo can be fixed in place.
      setDraft(res.rejected.map(r => r.ticker).join(" "));
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async ticker => {
    setMessage(null);
    try {
      setList(await api.removeTicker(ticker));
    } catch (err) {
      fail(err);
    }
  };

  const reset = async () => {
    setConfirmReset(false);
    setMessage(null);
    try {
      setList(await api.resetWatchlist());
      setMessage({ tone: "ok", text: "Back to the built-in list." });
    } catch (err) {
      fail(err);
    }
  };

  const shown = useMemo(() => {
    const q = query.trim().toUpperCase();
    return (list?.tickers ?? []).filter(t => t.includes(q));
  }, [list, query]);

  if (!list) {
    return (
      <section className="panel notice">
        {message ? <p className="wl-msg error">{message.text}</p> : <p>Loading watchlist…</p>}
      </section>
    );
  }

  return (
    <section className="panel watchlist" aria-label="Watchlist">
      <div className="report-head">
        <div>
          <span className="eyebrow">Watchlist</span>
          <h2 className="report-title">{list.tickers.length} tickers</h2>
          <div className="report-sub">
            {list.custom ? "Custom list." : "Built-in list."} Every scan runs on these. Changes apply from the next scan.
          </div>
        </div>
        {list.custom && (
          confirmReset ? (
            <div className="wl-confirm">
              <span>Replace with the built-in list?</span>
              <button type="button" className="btn-ghost danger" onClick={reset}>Reset</button>
              <button type="button" className="btn-ghost" onClick={() => setConfirmReset(false)}>Cancel</button>
            </div>
          ) : (
            <button type="button" className="btn-ghost" onClick={() => setConfirmReset(true)}>Reset to built-in</button>
          )
        )}
      </div>

      <form className="wl-add" onSubmit={submit}>
        <label className="field-label" htmlFor="wl-input">Add tickers</label>
        <div className="wl-row">
          <div className="wl-combo">
            <div className="field">
              <span className="field-icon"><Icon name="search" size={15} /></span>
              <input id="wl-input" value={draft}
                onChange={e => { setDraft(e.target.value); setOpen(true); }}
                onFocus={() => setOpen(true)}
                onBlur={() => setTimeout(() => setOpen(false), 150)}
                onKeyDown={onKeyDown}
                placeholder="Search a company or type symbols: apple, RELIANCE.NS"
                autoComplete="off" spellCheck={false}
                role="combobox" aria-expanded={open && results.length > 0} aria-controls="wl-suggest"
                aria-activedescendant={hi >= 0 ? `wl-opt-${hi}` : undefined} />
              {searching && <span className="wl-spin" aria-hidden="true" />}
            </div>
            {open && searchable && (results.length > 0 || !searching) && (
              <ul className="wl-suggest" id="wl-suggest" role="listbox">
                {results.length === 0 && <li className="wl-none">No Yahoo match for “{term}”.</li>}
                {results.map((r, i) => {
                  const have = list.tickers.includes(r.symbol);
                  return (
                    <li key={r.symbol} id={`wl-opt-${i}`} role="option" aria-selected={i === hi}
                      className={`wl-opt ${i === hi ? "hi" : ""} ${have ? "have" : ""}`}
                      onMouseEnter={() => setHi(i)}
                      onMouseDown={e => { e.preventDefault(); if (!have) add([r.symbol]); }}>
                      <span className="mono wl-sym">{r.symbol}</span>
                      <span className="wl-name">{r.name}</span>
                      <span className="wl-exch">{have ? "On list" : [r.exchange, r.type].filter(Boolean).join(" · ")}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <button type="submit" className="btn-primary" disabled={busy || !draft.trim()}>
            {busy ? "Checking…" : "Add"}
          </button>
        </div>
        <p className="wl-hint">
          Type a company name and pick a match from Yahoo Finance. You can also paste several symbols separated by commas. Each one is checked against Yahoo before it's added.
        </p>
        {message && <p className={`wl-msg ${message.tone}`} role="status">{message.text}</p>}
      </form>

      <div className="wl-tools">
        <div className="field wl-search">
          <span className="field-icon"><Icon name="search" size={14} /></span>
          <input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Filter" aria-label="Filter watchlist" />
        </div>
      </div>

      {shown.length === 0 ? (
        <p className="empty">No ticker matches “{query}”.</p>
      ) : (
        <ul className="wl-list">
          {shown.map(t => (
            <li key={t} className="wl-chip" title={recent[t] || undefined}>
              <span className="mono">{t}</span>
              <button type="button" onClick={() => remove(t)} aria-label={`Remove ${t}`} title={`Remove ${t}`}
                disabled={list.tickers.length === 1}>
                <Icon name="x" size={12} sw={2.2} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
