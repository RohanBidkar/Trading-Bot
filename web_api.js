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
 *   GET    /api/watchlist                 groups of tickers the scanners run on
 *   POST   /api/watchlist                 { add: [...], group } - checked against Yahoo, then added
 *   POST   /api/watchlist/move            { ticker, from, to } - move between groups
 *   DELETE /api/watchlist/groups/:g/:t    drop one ticker from a group
 *   POST   /api/watchlist/groups          { name } - new, empty group
 *   PATCH  /api/watchlist/groups/:g       { name } - rename
 *   DELETE /api/watchlist/groups/:g       delete a group and its tickers
 *   POST   /api/watchlist/reset           back to the built-in groups
 *   GET  /api/symbols?q=apple Yahoo Finance symbol search, for the add box
 *
 * Runner routes (GitHub Actions, Bearer RESULTS_SECRET):
 *   POST /api/results/status  the workflow started or finished
 *   POST /api/results         one scanner's numbers (see publish_result in scanner_core.py)
 *   GET  /api/results/watchlist?group=  the tickers to scan (see load_tickers in scanner_core.py)
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
const PARTS = new Set(["oversold", "overbought", "bands", "fxbands", "first5", "last5", "moves"]);
const RUNNER_STATUSES = new Set(["running", "success", "failure", "cancelled"]);
const RUN_ID = /^[A-Za-z0-9_-]{1,48}$/;

// The built-in watchlist, used until someone edits it on the website: the two
// blocks of the original hard-coded list. Keep the tickers in step with
// DEFAULT_TICKERS in scanner_core.py (the fallback when the site is unreachable).
const DEFAULT_GROUPS = [
  {
    id: "g_a",
    name: "Group A",
    tickers: [
      "SFST", "HBCP", "UNTY", "OBT", "PFIS", "MCBS", "CAC", "CCBG", "JBSS", "SPFI",
      "CBNK", "RBCAA", "SMBC", "THFF", "FCBC", "HWBK", "FBIZ", "CHMG", "MBWM", "GSBC",
      "PKBK", "PLBC", "FRAF", "CCB", "FCAP", "CMTV",
    ],
  },
  {
    id: "g_b",
    name: "Group B",
    tickers: [
      "BFC", "BANF", "NBN", "BOKF", "BPOP", "CHCO", "ESQ", "EWBC", "FCNCA", "HIFS",
      "PFBC", "QCRH", "RRBI", "UMBF", "WTFC", "DPST", "KRE", "HOV",
    ],
  },
];
const GROUP_ID = /^g_[a-z0-9]{1,12}$/;
const MAX_GROUPS = 20;
const MAX_GROUP_NAME = 40;
// Yahoo Finance symbols: AAPL, BRK-B, RELIANCE.NS, ^GSPC, EURUSD=X, BTC-USD.
const SYMBOL = /^[A-Z0-9^][A-Z0-9.\-=^]{0,19}$/;
// Distinct tickers across all groups. Every ticker is a separate download per
// scanner; this keeps a full run well inside the workflow's 20-minute timeout.
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
  ])
    // Added after launch; ALTER fails harmlessly once the column exists.
    .then(() => env.DB.prepare("ALTER TABLE runs ADD COLUMN group_name TEXT NOT NULL DEFAULT ''").run().catch(() => {}))
    .catch(err => {
      schemaReady = null;
      throw err;
    });
  return schemaReady;
}

/** Record a run the Worker is about to dispatch. Used by Telegram too. */
export async function createRun(env, { id, scan, asOf = "", month = "", source, groupName = "" }) {
  await ensureSchema(env);
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO runs (id, scan, as_of, month, source, status, created_at, updated_at, group_name) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)",
  ).bind(id, scan, asOf, month, source, now, now, groupName).run();
  return { id, scan, asOf, month, source, group: groupName, status: "queued", createdAt: now, updatedAt: now, ghUrl: null, parts: [] };
}

function toRun(row) {
  const stale = row.status === "queued" && Date.now() - row.created_at > STALE_AFTER_MS;
  return {
    id: row.id,
    scan: row.scan,
    asOf: row.as_of,
    month: row.month,
    source: row.source,
    group: row.group_name ?? "",
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

  // "" = every group. Forex runs on its own fixed pairs, so it takes none.
  let group = null;
  if (body.group && scan !== "fxbands") {
    group = (await readWatchlist(env)).groups.find(g => g.id === body.group);
    if (!group) return json({ error: "That watchlist group no longer exists." }, 400);
    if (group.tickers.length === 0) return json({ error: `“${group.name}” has no tickers yet.` }, 400);
  }

  const run = await createRun(env, { id: newRunId(), scan, asOf, month, source: "Web", groupName: group?.name ?? "" });
  // "no": results stay on the website instead of also going to Telegram.
  const result = await triggerWorkflow(env, scan, asOf, month, run.id, "no", group?.id ?? "");
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

const cloneDefaults = () => DEFAULT_GROUPS.map(g => ({ ...g, tickers: [...g.tickers] }));
const newGroupId = () => "g_" + Array.from(crypto.getRandomValues(new Uint8Array(8)), b => (b % 36).toString(36)).join("");

/** Every ticker once, in group order: what an "all groups" scan runs on. */
const allTickers = groups => [...new Set(groups.flatMap(g => g.tickers))];

/** { groups, custom } - custom is false until the list is first edited. */
async function readWatchlist(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'watchlist'").first();
  if (row) {
    try {
      const value = JSON.parse(row.value);
      // The first version stored a flat array; it becomes one group.
      if (Array.isArray(value) && value.length) return { groups: [{ id: "g_main", name: "My list", tickers: value }], custom: true };
      if (Array.isArray(value?.groups) && value.groups.length) return { groups: value.groups, custom: true };
    } catch { /* fall through to the built-in list */ }
  }
  return { groups: cloneDefaults(), custom: false };
}

async function saveWatchlist(env, groups) {
  await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('watchlist', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(JSON.stringify({ v: 2, groups }), Date.now()).run();
  return { groups, custom: true };
}

/**
 * Company names for the table, cached in settings. Names nobody has looked up
 * yet are fetched from Yahoo (at most 60 per request); a failed lookup is
 * stored as "" so it is not retried on every page load.
 */
async function symbolNames(env, tickers, known = {}) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'symbol_names'").first();
  let names = {};
  try { names = row ? JSON.parse(row.value) : {}; } catch { /* rebuild */ }
  let changed = false;
  for (const [t, name] of Object.entries(known)) {
    if (name && names[t] !== name) { names[t] = name; changed = true; }
  }
  const missing = tickers.filter(t => names[t] === undefined).slice(0, 60);
  if (missing.length) {
    const found = await Promise.all(missing.map(lookupSymbol));
    missing.forEach((t, i) => { names[t] = found[i].status === "ok" ? found[i].name : ""; });
    changed = true;
  }
  if (changed) {
    await env.DB.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('symbol_names', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(JSON.stringify(names), Date.now()).run();
  }
  return Object.fromEntries(tickers.map(t => [t, names[t] ?? ""]));
}

/** What the website gets back from every watchlist route. */
async function watchlistView(env, list, extra = {}, known = {}) {
  const tickers = allTickers(list.groups);
  return json({ ...list, total: tickers.length, names: await symbolNames(env, tickers, known), ...extra });
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

function cleanGroupName(raw, groups, exceptId = null) {
  const name = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!name) return { error: "Give the group a name." };
  if (name.length > MAX_GROUP_NAME) return { error: `Keep group names under ${MAX_GROUP_NAME} characters.` };
  const clash = groups.find(g => g.id !== exceptId && g.name.toLowerCase() === name.toLowerCase());
  if (clash) return { error: `There is already a group called “${clash.name}”.` };
  return { name };
}

async function addTickers(request, env) {
  const body = await readJson(request);
  const raw = Array.isArray(body?.add) ? body.add : typeof body?.add === "string" ? body.add.split(/[\s,;]+/) : null;
  if (!raw) return json({ error: "Send the tickers to add as { add: [...], group }." }, 400);

  const list = await readWatchlist(env);
  const group = list.groups.find(g => g.id === body.group);
  if (!group) return json({ error: "Pick a group to add to." }, 400);

  const wanted = [...new Set(raw.map(t => String(t).trim().toUpperCase()).filter(Boolean))];
  if (wanted.length === 0) return json({ error: "Type at least one ticker." }, 400);
  if (wanted.length > MAX_ADD) return json({ error: `Add at most ${MAX_ADD} tickers at a time.` }, 400);

  const inGroup = new Set(group.tickers);
  const everywhere = new Set(allTickers(list.groups));
  const rejected = [];
  const fresh = [];
  for (const t of wanted) {
    if (!SYMBOL.test(t)) rejected.push({ ticker: t, reason: "not a valid symbol" });
    else if (inGroup.has(t)) rejected.push({ ticker: t, reason: `already in ${group.name}` });
    else fresh.push(t);
  }

  // Tickers already in another group were checked when they were added.
  const checks = await Promise.all(fresh.map(t => (everywhere.has(t) ? { status: "ok", name: "" } : lookupSymbol(t))));
  const added = [];
  fresh.forEach((t, i) => {
    if (checks[i].status === "missing") rejected.push({ ticker: t, reason: "Yahoo Finance has no such symbol" });
    else added.push({ ticker: t, ...checks[i] });
  });

  const total = new Set([...everywhere, ...added.map(a => a.ticker)]).size;
  if (total > MAX_TICKERS) {
    return json({ error: `The watchlist holds at most ${MAX_TICKERS} distinct tickers; it has ${everywhere.size}.` }, 400);
  }
  let saved = list;
  if (added.length) {
    group.tickers = [...group.tickers, ...added.map(a => a.ticker)];
    saved = await saveWatchlist(env, list.groups);
  }
  const known = Object.fromEntries(added.filter(a => a.name).map(a => [a.ticker, a.name]));
  return watchlistView(env, saved, { added, rejected }, known);
}

async function removeTicker(env, groupId, ticker) {
  const list = await readWatchlist(env);
  const group = list.groups.find(g => g.id === groupId);
  const t = ticker.toUpperCase();
  if (!group || !group.tickers.includes(t)) return json({ error: `${t} is not in that group.` }, 404);
  group.tickers = group.tickers.filter(x => x !== t);
  if (allTickers(list.groups).length === 0) return json({ error: "The watchlist needs at least one ticker." }, 400);
  return watchlistView(env, await saveWatchlist(env, list.groups));
}

async function moveTicker(request, env) {
  const body = await readJson(request);
  const list = await readWatchlist(env);
  const from = list.groups.find(g => g.id === body?.from);
  const to = list.groups.find(g => g.id === body?.to);
  const t = String(body?.ticker ?? "").toUpperCase();
  if (!from || !to || from === to) return json({ error: "Pick a different group to move to." }, 400);
  if (!from.tickers.includes(t)) return json({ error: `${t} is not in ${from.name}.` }, 404);
  from.tickers = from.tickers.filter(x => x !== t);
  if (!to.tickers.includes(t)) to.tickers = [...to.tickers, t];
  return watchlistView(env, await saveWatchlist(env, list.groups));
}

async function createGroup(request, env) {
  const body = await readJson(request);
  const list = await readWatchlist(env);
  if (list.groups.length >= MAX_GROUPS) return json({ error: `At most ${MAX_GROUPS} groups.` }, 400);
  const { name, error } = cleanGroupName(body?.name, list.groups);
  if (error) return json({ error }, 400);
  const group = { id: newGroupId(), name, tickers: [] };
  return watchlistView(env, await saveWatchlist(env, [...list.groups, group]), { created: group.id });
}

async function renameGroup(request, env, groupId) {
  const body = await readJson(request);
  const list = await readWatchlist(env);
  const group = list.groups.find(g => g.id === groupId);
  if (!group) return json({ error: "That group no longer exists." }, 404);
  const { name, error } = cleanGroupName(body?.name, list.groups, groupId);
  if (error) return json({ error }, 400);
  group.name = name;
  return watchlistView(env, await saveWatchlist(env, list.groups));
}

async function deleteGroup(env, groupId) {
  const list = await readWatchlist(env);
  const rest = list.groups.filter(g => g.id !== groupId);
  if (rest.length === list.groups.length) return json({ error: "That group no longer exists." }, 404);
  if (rest.length === 0) return json({ error: "Keep at least one group." }, 400);
  if (allTickers(rest).length === 0) return json({ error: "The watchlist needs at least one ticker." }, 400);
  return watchlistView(env, await saveWatchlist(env, rest));
}

/** For the scanners: one group's tickers, or every group's when none is named. */
async function runnerWatchlist(env, url) {
  const list = await readWatchlist(env);
  const id = url.searchParams.get("group") ?? "";
  if (!id) return json({ tickers: allTickers(list.groups), group: null });
  const group = list.groups.find(g => g.id === id);
  if (!group) return json({ error: "Unknown group." }, 404);
  return json({ tickers: group.tickers, group: { id: group.id, name: group.name } });
}

/* --------------------------------- router --------------------------------- */

export async function handleApi(request, env, url) {
  if (!env.DB) return json({ error: "The D1 database is not bound (DB)." }, 503);
  await ensureSchema(env);

  const path = url.pathname;
  const method = request.method;

  if (path.startsWith("/api/results")) {
    if (!(await runnerAuthorized(request, env))) return json({ error: "Forbidden" }, 403);
    if (path === "/api/results/watchlist" && method === "GET") return runnerWatchlist(env, url);
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
  if (path.startsWith("/api/watchlist")) {
    const seg = path.split("/").slice(3).map(decodeURIComponent); // after /api/watchlist
    if (seg.length === 0) {
      if (method === "GET") return watchlistView(env, await readWatchlist(env));
      if (method === "POST") return addTickers(request, env);
    }
    if (seg[0] === "move" && seg.length === 1 && method === "POST") return moveTicker(request, env);
    if (seg[0] === "reset" && seg.length === 1 && method === "POST") {
      await env.DB.prepare("DELETE FROM settings WHERE key = 'watchlist'").run();
      return watchlistView(env, await readWatchlist(env));
    }
    if (seg[0] === "groups") {
      if (seg.length === 1 && method === "POST") return createGroup(request, env);
      if (seg.length >= 2 && !GROUP_ID.test(seg[1])) return json({ error: "Unknown group." }, 404);
      if (seg.length === 2 && method === "PATCH") return renameGroup(request, env, seg[1]);
      if (seg.length === 2 && method === "DELETE") return deleteGroup(env, seg[1]);
      if (seg.length === 3 && method === "DELETE") return removeTicker(env, seg[1], seg[2]);
    }
    return json({ error: "Not found" }, 404);
  }

  return json({ error: "Not found" }, 404);
}
