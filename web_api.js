/**
 * Website API for Scanner Desk, served by the same Worker as the Telegram bot.
 *
 * Browser routes (need the session cookie from /api/login):
 *   POST /api/login           password -> session cookie
 *   POST /api/logout
 *   GET  /api/session         { authenticated }
 *   GET  /api/runs            recent runs, newest first
 *   POST /api/runs            start a scan; results stay on the website
 *   GET  /api/runs/:id        one run with the numbers its scanners sent
 *   GET  /api/watchlist       the tickers the scanners run on
 *   POST /api/watchlist       { add: [...] } - checked against Yahoo, then appended
 *   DELETE /api/watchlist/:t  drop one ticker
 *   POST /api/watchlist/reset back to the built-in list
 *   GET  /api/symbols?q=apple Yahoo Finance symbol search, for the add box
 *
 * Runner routes (GitHub Actions, Bearer RESULTS_SECRET):
 *   POST /api/results/status  the workflow started or finished
 *   POST /api/results         one scanner's numbers (see publish_result in scanner_core.py)
 *   GET  /api/results/watchlist  the tickers to scan (see load_tickers in scanner_core.py)
 *
 * Storage is D1 (binding DB). The tables are created on first use, so there is
 * no migration step.
 *
 * Secrets:
 *   WEB_PASSWORD    the password for the website
 *   RESULTS_SECRET  shared with GitHub Actions so only the runner can post results
 */

import { LABELS, newRunId, parseAsOf, parseMonth, triggerWorkflow } from "./telegram_trigger_worker.js";

const COOKIE = "sd_session";
const SESSION_SECONDS = 30 * 24 * 60 * 60;

// Wrong-password lockout, per IP.
const MAX_FAILURES = 8;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

// A dispatch GitHub never picks up would otherwise sit "queued" forever.
const STALE_AFTER_MS = 15 * 60 * 1000;
const LIST_LIMIT = 40;
const MAX_RESULT_BYTES = 256 * 1024;

// What each scanner script posts under; "both" posts oversold + overbought.
const PARTS = new Set(["oversold", "overbought", "bands", "fxbands", "first5", "last5"]);
const RUNNER_STATUSES = new Set(["running", "success", "failure", "cancelled"]);
const RUN_ID = /^[A-Za-z0-9_-]{1,48}$/;

// The built-in watchlist, used until someone edits it on the website. Keep in
// step with DEFAULT_TICKERS in scanner_core.py (the fallback when the site is
// unreachable).
const DEFAULT_TICKERS = [
  "SFST", "HBCP", "UNTY", "OBT", "PFIS", "MCBS", "CAC", "CCBG", "JBSS", "SPFI",
  "CBNK", "RBCAA", "SMBC", "THFF", "FCBC", "HWBK", "FBIZ", "CHMG", "MBWM", "GSBC",
  "PKBK", "PLBC", "FRAF", "CCB", "FCAP", "CMTV",
  "BFC", "BANF", "NBN", "BOKF", "BPOP", "CHCO", "ESQ", "EWBC", "FCNCA", "HIFS",
  "PFBC", "QCRH", "RRBI", "UMBF", "WTFC", "DPST", "KRE", "HOV",
];
// Yahoo Finance symbols: AAPL, BRK-B, RELIANCE.NS, ^GSPC, EURUSD=X, BTC-USD.
const SYMBOL = /^[A-Z0-9^][A-Z0-9.\-=^]{0,19}$/;
// Every ticker is a separate download per scanner; this keeps a run well
// inside the workflow's 20-minute timeout.
const MAX_TICKERS = 200;
const MAX_ADD = 25;

const encoder = new TextEncoder();

/* --------------------------------- helpers -------------------------------- */

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

async function readJson(request) {
  if (!(request.headers.get("Content-Type") ?? "").includes("application/json")) return null;
  const text = await request.text();
  if (text.length > MAX_RESULT_BYTES) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function sha256(text) {
  return crypto.subtle.digest("SHA-256", encoder.encode(text));
}

/** Constant-time comparison; hashing first makes the lengths equal. */
async function sameSecret(a, b) {
  const [x, y] = await Promise.all([sha256(a ?? ""), sha256(b ?? "")]);
  return crypto.subtle.timingSafeEqual(x, y);
}

const toB64url = buf =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function fromB64url(text) {
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

/* --------------------------------- schema --------------------------------- */

let schemaReady = null;

function ensureSchema(env) {
  schemaReady ??= env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      scan TEXT NOT NULL,
      as_of TEXT NOT NULL DEFAULT '',
      month TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      gh_url TEXT
    )`),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS runs_created ON runs (created_at DESC)"),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS parts (
      run_id TEXT NOT NULL,
      part TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, part)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS login_failures (
      ip TEXT PRIMARY KEY,
      failures INTEGER NOT NULL,
      window_start INTEGER NOT NULL
    )`),
  ]).catch(err => {
    schemaReady = null;
    throw err;
  });
  return schemaReady;
}

/** Record a run the Worker is about to dispatch. Used by Telegram too. */
export async function createRun(env, { id, scan, asOf = "", month = "", source }) {
  await ensureSchema(env);
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO runs (id, scan, as_of, month, source, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)",
  ).bind(id, scan, asOf, month, source, now, now).run();
  return { id, scan, asOf, month, source, status: "queued", createdAt: now, updatedAt: now, ghUrl: null, parts: [] };
}

function toRun(row) {
  const stale = row.status === "queued" && Date.now() - row.created_at > STALE_AFTER_MS;
  return {
    id: row.id,
    scan: row.scan,
    asOf: row.as_of,
    month: row.month,
    source: row.source,
    status: stale ? "stale" : row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ghUrl: row.gh_url,
    parts: row.part_names ? row.part_names.split(",") : [],
  };
}

/* --------------------------------- session -------------------------------- */

function sessionKey(env) {
  // Keyed on the password, so changing WEB_PASSWORD signs everyone out.
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(`scanner-desk-session:${env.WEB_PASSWORD}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function issueSession(env) {
  const expires = String(Date.now() + SESSION_SECONDS * 1000);
  const sig = await crypto.subtle.sign("HMAC", await sessionKey(env), encoder.encode(expires));
  return `${expires}.${toB64url(sig)}`;
}

async function hasSession(request, env) {
  if (!env.WEB_PASSWORD) return false;
  const cookie = request.headers.get("Cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!match) return false;

  const [expires, sig] = match[1].split(".");
  if (!expires || !sig || !/^\d+$/.test(expires) || Number(expires) < Date.now()) return false;
  try {
    return await crypto.subtle.verify("HMAC", await sessionKey(env), fromB64url(sig), encoder.encode(expires));
  } catch {
    return false;
  }
}

function sessionCookie(value, maxAge) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

/* --------------------------------- routes --------------------------------- */

async function login(request, env) {
  const body = await readJson(request);
  if (!body || typeof body.password !== "string") return json({ error: "Send the password as JSON." }, 400);

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const now = Date.now();
  const row = await env.DB.prepare("SELECT failures, window_start FROM login_failures WHERE ip = ?").bind(ip).first();
  const fresh = !row || now - row.window_start > FAILURE_WINDOW_MS;
  const failures = fresh ? 0 : row.failures;

  if (failures >= MAX_FAILURES) {
    const retryAfter = Math.ceil((row.window_start + FAILURE_WINDOW_MS - now) / 1000);
    return json({ error: "Too many wrong passwords.", retryAfter }, 429, { "Retry-After": String(retryAfter) });
  }

  if (await sameSecret(body.password, env.WEB_PASSWORD)) {
    await env.DB.prepare("DELETE FROM login_failures WHERE ip = ?").bind(ip).run();
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(await issueSession(env), SESSION_SECONDS) });
  }

  await env.DB.prepare(
    `INSERT INTO login_failures (ip, failures, window_start) VALUES (?, 1, ?)
     ON CONFLICT(ip) DO UPDATE SET failures = ?, window_start = ?`,
  ).bind(ip, now, failures + 1, fresh ? now : row.window_start).run();
  return json({ error: "Wrong password.", remaining: MAX_FAILURES - failures - 1 }, 401);
}

async function listRuns(env) {
  const { results } = await env.DB.prepare(
    `SELECT r.*, (SELECT group_concat(part) FROM parts p WHERE p.run_id = r.id) AS part_names
     FROM runs r ORDER BY created_at DESC LIMIT ?`,
  ).bind(LIST_LIMIT).all();
  return json({ runs: results.map(toRun) });
}

async function getRun(env, id) {
  if (!RUN_ID.test(id)) return json({ error: "Unknown run." }, 404);
  const row = await env.DB.prepare(
    `SELECT r.*, (SELECT group_concat(part) FROM parts p WHERE p.run_id = r.id) AS part_names FROM runs r WHERE id = ?`,
  ).bind(id).first();
  if (!row) return json({ error: "Unknown run." }, 404);

  const { results } = await env.DB.prepare("SELECT part, data FROM parts WHERE run_id = ?").bind(id).all();
  const parts = Object.fromEntries(results.map(p => [p.part, JSON.parse(p.data)]));
  return json({ run: toRun(row), parts });
}

async function startRun(request, env) {
  const body = await readJson(request);
  const scan = body?.scan;
  if (!LABELS[scan]) return json({ error: "Pick one of the scans on the left." }, 400);

  // Same checks as the Telegram path: the dates end up as workflow inputs.
  let asOf = "";
  let month = "";
  if (scan === "first5") {
    if (body.month) {
      const parsed = parseMonth(body.month);
      if (!parsed.ok) return json({ error: parsed.reason }, 400);
      month = parsed.value;
    }
  } else {
    const parsed = parseAsOf(body.as_of ?? "");
    if (!parsed.ok) return json({ error: parsed.reason }, 400);
    asOf = parsed.value;
  }

  const run = await createRun(env, { id: newRunId(), scan, asOf, month, source: "Web" });
  // "no": results stay on the website instead of also going to Telegram.
  const result = await triggerWorkflow(env, scan, asOf, month, run.id, "no");
  if (!result.ok) {
    console.error("workflow_dispatch failed:", result.status, result.detail);
    await env.DB.prepare("DELETE FROM runs WHERE id = ?").bind(run.id).run();
    return json({ error: `GitHub refused to start the scan (${result.status}). Check the GITHUB_TOKEN permissions.` }, 502);
  }
  return json({ run }, 201);
}

async function runnerAuthorized(request, env) {
  if (!env.RESULTS_SECRET) return false;
  const header = request.headers.get("Authorization") ?? "";
  return header.startsWith("Bearer ") && sameSecret(header.slice(7), env.RESULTS_SECRET);
}

async function runnerStatus(request, env) {
  const body = await readJson(request);
  if (!body || !RUN_ID.test(body.run_id ?? "") || !RUNNER_STATUSES.has(body.status)) {
    return json({ error: "Expected run_id and a status." }, 400);
  }
  // A run started from the Actions tab has no row yet; the first report creates it.
  const scan = LABELS[body.scan] ? body.scan : "both";
  const source = "GitHub";
  const ghUrl = typeof body.gh_url === "string" && body.gh_url.startsWith("https://github.com/") ? body.gh_url : null;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO runs (id, scan, as_of, month, source, status, created_at, updated_at, gh_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at,
       gh_url = COALESCE(excluded.gh_url, runs.gh_url)`,
  ).bind(body.run_id, scan, body.as_of ?? "", body.month ?? "", source, body.status, now, now, ghUrl).run();
  return json({ ok: true });
}

async function runnerResult(request, env) {
  const body = await readJson(request);
  if (!body || !RUN_ID.test(body.run_id ?? "") || !PARTS.has(body.part) || typeof body.data !== "object") {
    return json({ error: "Expected run_id, part and data." }, 400);
  }
  await env.DB.prepare(
    `INSERT INTO parts (run_id, part, data, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(run_id, part) DO UPDATE SET data = excluded.data, created_at = excluded.created_at`,
  ).bind(body.run_id, body.part, JSON.stringify(body.data), Date.now()).run();
  return json({ ok: true });
}

/* -------------------------------- watchlist ------------------------------- */

/** { tickers, custom } - custom is false until the list is first edited. */
async function readWatchlist(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'watchlist'").first();
  if (row) {
    try {
      const tickers = JSON.parse(row.value);
      if (Array.isArray(tickers) && tickers.length) return { tickers, custom: true };
    } catch { /* fall through to the built-in list */ }
  }
  return { tickers: [...DEFAULT_TICKERS], custom: false };
}

async function saveWatchlist(env, tickers) {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('watchlist', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(JSON.stringify(tickers), Date.now()).run();
  return { tickers, custom: true };
}

/**
 * Ask Yahoo whether a symbol exists - the same chart API yfinance reads.
 * "missing" only on a definite not-found; anything else (rate limit, Yahoo
 * refusing Cloudflare) is "unchecked" and the ticker is still added.
 */
async function lookupSymbol(symbol) {
  try {
    const resp = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`,
      { headers: { "User-Agent": "Mozilla/5.0 (compatible; ScannerDesk/1.0)", Accept: "application/json" } },
    );
    const data = await resp.json().catch(() => null);
    const meta = data?.chart?.result?.[0]?.meta;
    if (resp.ok && meta) {
      return { status: "ok", name: meta.longName || meta.shortName || "", exchange: meta.fullExchangeName || meta.exchangeName || "" };
    }
    if (resp.status === 404 || data?.chart?.error?.code === "Not Found") return { status: "missing" };
    return { status: "unchecked" };
  } catch {
    return { status: "unchecked" };
  }
}

/** Yahoo's symbol search, proxied because the browser can't call Yahoo (CORS). */
async function searchSymbols(url) {
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 40);
  if (q.length < 1) return json({ results: [] });
  try {
    const resp = await fetch(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0&listsCount=0`,
      { headers: { "User-Agent": "Mozilla/5.0 (compatible; ScannerDesk/1.0)", Accept: "application/json" } },
    );
    if (!resp.ok) return json({ results: [], error: `Yahoo search failed (${resp.status}).` });
    const data = await resp.json();
    const results = (data.quotes ?? [])
      .filter(r => r.symbol && SYMBOL.test(String(r.symbol).toUpperCase()))
      .map(r => ({
        symbol: String(r.symbol).toUpperCase(),
        name: r.longname || r.shortname || "",
        exchange: r.exchDisp || r.exchange || "",
        type: r.typeDisp || r.quoteType || "",
      }));
    return json({ results });
  } catch {
    return json({ results: [], error: "Couldn't reach Yahoo search." });
  }
}

async function addTickers(request, env) {
  const body = await readJson(request);
  const raw = Array.isArray(body?.add) ? body.add : typeof body?.add === "string" ? body.add.split(/[\s,;]+/) : null;
  if (!raw) return json({ error: "Send the tickers to add as { add: [...] }." }, 400);

  const wanted = [...new Set(raw.map(t => String(t).trim().toUpperCase()).filter(Boolean))];
  if (wanted.length === 0) return json({ error: "Type at least one ticker." }, 400);
  if (wanted.length > MAX_ADD) return json({ error: `Add at most ${MAX_ADD} tickers at a time.` }, 400);

  const list = await readWatchlist(env);
  const have = new Set(list.tickers);
  const rejected = [];
  const fresh = [];
  for (const t of wanted) {
    if (!SYMBOL.test(t)) rejected.push({ ticker: t, reason: "not a valid symbol" });
    else if (have.has(t)) rejected.push({ ticker: t, reason: "already on the list" });
    else fresh.push(t);
  }

  const checks = await Promise.all(fresh.map(lookupSymbol));
  const added = [];
  fresh.forEach((t, i) => {
    if (checks[i].status === "missing") rejected.push({ ticker: t, reason: "Yahoo Finance has no such symbol" });
    else added.push({ ticker: t, ...checks[i] });
  });

  if (list.tickers.length + added.length > MAX_TICKERS) {
    return json({ error: `The watchlist holds at most ${MAX_TICKERS} tickers; it has ${list.tickers.length}.` }, 400);
  }
  const saved = added.length ? await saveWatchlist(env, [...list.tickers, ...added.map(a => a.ticker)]) : list;
  return json({ ...saved, added, rejected });
}

async function removeTicker(env, ticker) {
  const list = await readWatchlist(env);
  const t = ticker.toUpperCase();
  if (!list.tickers.includes(t)) return json({ error: `${t} is not on the list.` }, 404);
  if (list.tickers.length === 1) return json({ error: "The watchlist needs at least one ticker." }, 400);
  return json(await saveWatchlist(env, list.tickers.filter(x => x !== t)));
}

/* --------------------------------- router --------------------------------- */

export async function handleApi(request, env, url) {
  if (!env.DB) return json({ error: "The D1 database is not bound (DB)." }, 503);
  await ensureSchema(env);

  const path = url.pathname;
  const method = request.method;

  if (path.startsWith("/api/results")) {
    if (!(await runnerAuthorized(request, env))) return json({ error: "Forbidden" }, 403);
    if (path === "/api/results/watchlist" && method === "GET") return json(await readWatchlist(env));
    if (method !== "POST") return json({ error: "Method not allowed" }, 405);
    if (path === "/api/results/status") return runnerStatus(request, env);
    if (path === "/api/results") return runnerResult(request, env);
    return json({ error: "Not found" }, 404);
  }

  if (!env.WEB_PASSWORD) return json({ error: "WEB_PASSWORD is not set." }, 503);

  if (path === "/api/login" && method === "POST") return login(request, env);
  if (path === "/api/logout" && method === "POST") {
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
  }
  if (path === "/api/session" && method === "GET") {
    return json({ authenticated: await hasSession(request, env) });
  }

  if (!(await hasSession(request, env))) return json({ error: "Signed out" }, 401);

  if (path === "/api/runs" && method === "GET") return listRuns(env);
  if (path === "/api/runs" && method === "POST") return startRun(request, env);
  const match = path.match(/^\/api\/runs\/([^/]+)$/);
  if (match && method === "GET") return getRun(env, decodeURIComponent(match[1]));

  if (path === "/api/symbols" && method === "GET") return searchSymbols(url);
  if (path === "/api/watchlist" && method === "GET") return json(await readWatchlist(env));
  if (path === "/api/watchlist" && method === "POST") return addTickers(request, env);
  if (path === "/api/watchlist/reset" && method === "POST") {
    await env.DB.prepare("DELETE FROM settings WHERE key = 'watchlist'").run();
    return json(await readWatchlist(env));
  }
  const item = path.match(/^\/api\/watchlist\/([^/]+)$/);
  if (item && method === "DELETE") return removeTicker(env, decodeURIComponent(item[1]));

  return json({ error: "Not found" }, 404);
}
