"""
Year movement - how far every ticker has moved over ten lookbacks.

Not a screen: no ticker is filtered out. For each one it prints the % change
in the close over the last 400, 350, 300, 250, 200, 150, 100, 50, 35, 22 and
15 trading days (D400 ... D15, longest first), measured from the close N
sessions back, then the close itself. A ticker without enough history for a
window (a recent listing) shows "-" there instead of being dropped.

Rows are split under/over $100 like the other reports, each tier sorted by
D15, biggest gain first. The website table can re-sort on any column.

    python year_move_scanner.py                       # latest bar
    python year_move_scanner.py --as-of 2026-03-02    # a past session (local only)
    python year_move_scanner.py --as-of 2026-03-02 --send
"""

from datetime import date
from html import escape

from scanner_core import (
    NOTIFY_WHEN_EMPTY,
    TICKERS,
    build_parser,
    get_close,
    plain,
    publish_error,
    publish_result,
    send_telegram,
    sort_by_tier,
    stk_width,
)

# ---------------- CONFIG ----------------
# Trading days back, in column order: longest first, Close after the last.
MOVE_DAYS = (400, 350, 300, 250, 200, 150, 100, 50, 35, 22, 15)
SORT_BY = "d15"

# D400 needs 401 sessions (~1.6 years). Backdated runs go up to 24 months
# back, so they download more.
PERIOD = "2y"
PERIOD_HISTORICAL = "5y"

# Telegram caps a message at 4096 characters; long lists split into several.
MAX_MESSAGE_CHARS = 3500
# -----------------------------------------


def moves_for(ticker: str, as_of: date = None, period: str = PERIOD):
    """Close and the % change over each lookback, or None with no usable data."""
    prices = get_close(ticker, period)
    if as_of is not None:
        # Truncate to what was knowable that day; a weekend or holiday rolls
        # back to the previous session.
        prices = prices[prices.index.date <= as_of]
    if len(prices) < 2:
        print(f"Skipping {ticker}: only {len(prices)} bars of usable history")
        return None

    close = float(prices.iloc[-1])
    row = {"ticker": ticker, "date": prices.index[-1].date(), "close": close}
    for n in MOVE_DAYS:
        base = float(prices.iloc[-(n + 1)]) if len(prices) > n else 0.0
        row[f"d{n}"] = (close - base) / base * 100.0 if base else None
    return row


def fmt_pct(value, width: int) -> str:
    return f"{'-':>{width}}" if value is None else f"{value:>{width - 1}.1f}%"


def format_table(rows: list) -> str:
    """Fixed-width table so the columns line up in a monospace block."""
    w = stk_width(rows)
    header = f"{'STK':<{w}}" + "".join(f"{f'D{n}':>7}" for n in MOVE_DAYS) + f"{'CLOSE':>9}"
    lines = [header, "-" * len(header)]
    for m in rows:
        lines.append(
            f"{m['ticker']:<{w}}"
            + "".join(fmt_pct(m[f"d{n}"], 7) for n in MOVE_DAYS)
            + f"{m['close']:>9.2f}"
        )
    return "\n".join(lines)


def chunk_rows(rows: list) -> list:
    """Split into as many tables as it takes to stay under Telegram's cap."""
    tables, batch = [], []
    for row in rows:
        candidate = batch + [row]
        if batch and len(format_table(candidate)) > MAX_MESSAGE_CHARS:
            tables.append(format_table(batch))
            batch = [row]
        else:
            batch = candidate
    if batch:
        tables.append(format_table(batch))
    return tables


def main() -> None:
    args = build_parser("Year movement: D400 to D15 for every ticker").parse_args()
    as_of = date.fromisoformat(args.as_of) if args.as_of else None
    period = PERIOD_HISTORICAL if as_of else PERIOD
    name = "Year movement"

    rows = []
    for ticker in TICKERS:
        try:
            m = moves_for(ticker, as_of=as_of, period=period)
            if m is not None:
                rows.append(m)
        except Exception as exc:
            print(f"Error checking {ticker}: {exc}")

    if not rows:
        print("No usable data for any ticker.")
        publish_error("moves", name, "No usable price data for any ticker. The data source may be down.")
        if NOTIFY_WHEN_EMPTY and not (as_of and not args.send):
            send_telegram(
                f"⚠️ <b>{escape(name)}</b> — no usable price data for any ticker. "
                "The data source may be down."
            )
        return

    # Missing values sort last within their tier.
    for m in rows:
        m["_sort"] = m[SORT_BY] if m[SORT_BY] is not None else float("-inf")
    rows = sort_by_tier(rows, "_sort", descending=True)

    bar_date = max(m["date"] for m in rows)
    up_15 = len([m for m in rows if (m["d15"] or 0) > 0])
    up_200 = len([m for m in rows if (m["d200"] or 0) > 0])
    short = len([m for m in rows if m["d400"] is None])

    title = f"<b>{escape(name)}</b> — bar {bar_date}"
    subtitle = (
        f"% change in the close over N trading days. {up_15} of {len(rows)} up over 15 days, "
        f"{up_200} up over 200 days."
        + (f" {short} without 400 days of history (shown as -)." if short else "")
    )

    columns = ("ticker", *(f"d{n}" for n in MOVE_DAYS), "close")
    publish_result("moves", {
        "kind": "moves",
        "title": name,
        "bar": bar_date,
        "moves": list(MOVE_DAYS),
        "sort": SORT_BY,
        "rows": [{k: m[k] for k in columns} for m in rows],
    })

    tables = chunk_rows(rows)
    print(f"\n{plain(title)}\n{subtitle}\n")
    for table in tables:
        print(table)

    if as_of and not args.send:
        print("\n(--as-of set without --send: not sending to Telegram)")
        return

    # One message per table; only the first carries the explanation.
    for index, table in enumerate(tables):
        part = f" ({index + 1}/{len(tables)})" if len(tables) > 1 else ""
        head = f"{title}{part}\n{escape(subtitle)}\n\n" if index == 0 else f"{title}{part}\n\n"
        send_telegram(f"{head}<pre>{escape(table)}</pre>")


if __name__ == "__main__":
    main()
