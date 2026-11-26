// Thin client for the Worker's /api routes. The session lives in an HttpOnly
// cookie, so nothing secret is ever stored in the page.

export class AuthError extends Error {}

async function call(path, { method = "GET", body } = {}) {
  const resp = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (resp.status === 401 && path !== "/api/login") throw new AuthError(data.error || "Signed out");
  if (!resp.ok) {
    const err = new Error(data.error || `Request failed (${resp.status})`);
    err.status = resp.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  session: () => call("/api/session"),
  login: password => call("/api/login", { method: "POST", body: { password } }),
  logout: () => call("/api/logout", { method: "POST", body: {} }),
  runs: () => call("/api/runs"),
  run: id => call(`/api/runs/${encodeURIComponent(id)}`),
  start: ({ scan, asOf, month, group }) => call("/api/runs", { method: "POST", body: { scan, as_of: asOf, month, group } }),
  searchSymbols: q => call(`/api/symbols?q=${encodeURIComponent(q)}`),
  watchlist: () => call("/api/watchlist"),
  addTickers: (group, tickers) => call("/api/watchlist", { method: "POST", body: { group, add: tickers } }),
  removeTicker: (group, ticker) => call(`/api/watchlist/groups/${group}/${encodeURIComponent(ticker)}`, { method: "DELETE" }),
  moveTicker: (ticker, from, to) => call("/api/watchlist/move", { method: "POST", body: { ticker, from, to } }),
  createGroup: name => call("/api/watchlist/groups", { method: "POST", body: { name } }),
  renameGroup: (group, name) => call(`/api/watchlist/groups/${group}`, { method: "PATCH", body: { name } }),
  deleteGroup: group => call(`/api/watchlist/groups/${group}`, { method: "DELETE" }),
  resetWatchlist: () => call("/api/watchlist/reset", { method: "POST", body: {} }),
};
