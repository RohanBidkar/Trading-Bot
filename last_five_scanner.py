"""
Last-five-trading-days scanner - the mirror of first_five_scanner.py.

Same ranking, a rolling window instead of a calendar one: every ticker sorted
by its return over the most recent sessions, rather than the opening sessions
of a month. Nothing is filtered - all 44 names appear, split into an up table
and a down table.

The return is measured from the close of the session BEFORE the window to the
latest close, so five sessions of change are counted, not four.

Usage:
    python last_five_scanner.py                      # the latest 5 sessions
    python last_five_scanner.py --days 10            # a longer window
    python last_five_scanner.py --as-of 2026-09-01          # print only
    python last_five_scanner.py --as-of 2026-09-01 --send   # and send
"""

from datetime import date
from html import escape

import pandas as pd

from scanner_core import (
    LOOKBACK,
    LOOKBACK_HISTORICAL,
    NOTIFY_WHEN_EMPTY,
    TICKERS,
    build_parser,
    format_return_table,
    get_close,
    plain,
    send_telegram,
)

# ---------------- CONFIG ----------------
DEFAULT_DAYS = 5          # trading sessions in the window
STRONG_MOVE = 5.0         # % that earns a ticker a spot in the "movers" summary
# -----------------------------------------


def window_for(prices: pd.Series, days: int, as_of: date = None):
    """Return over the last `days` sessions, versus the close before them.

    Returns None when the series does not reach back far enough - the window
    plus one earlier bar to measure from.
    """
    if as_of is not None:
        # Truncate to what was knowable that day; a weekend or holiday rolls
        # back to the previous trading session.
        prices = prices[prices.index.date <= as_of]

    if len(prices) < days + 1:
        return None

    window = prices.iloc[-days:]
    base = float(prices.iloc[-(days + 1)])
    last = float(window.iloc[-1])
    if base == 0:
        return None

    return {
        "base": base,
        "base_date": prices.index[-(days + 1)].date(),
        "last": last,
        "start": window.index[0].date(),
        "end": window.index[-1].date(),
        "sessions": len(window),
        "ret": (last - base) / base * 100.0,
    }


def parse_args():
    parser = build_parser("Performance over the most recent trading days")
    parser.add_argument(
        "--days",
        type=int,
        default=DEFAULT_DAYS,
        help=f"how many recent sessions to count (default {DEFAULT_DAYS})",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    if args.days < 1:
        raise SystemExit("--days must be at least 1")

    as_of = date.fromisoformat(args.as_of) if args.as_of else None
    period = LOOKBACK_HISTORICAL if as_of else LOOKBACK
    name = f"Last {args.days} days"
    quiet = as_of is not None and not args.send

    rows = []
    for ticker in TICKERS:
        try:
            prices = get_close(ticker, period)
        except Exception as exc:
            print(f"Error checking {ticker}: {exc}")
            continue

        result = window_for(prices, args.days, as_of)
        if result is None:
            print(f"Skipping {ticker}: not enough history for a {args.days}-day window")
            continue
        rows.append({"ticker": ticker, **result})

    if not rows:
        print("No usable data for any ticker.")
        if NOTIFY_WHEN_EMPTY and not quiet:
            send_telegram(
                f"⚠️ <b>{escape(name)}</b> — no usable price data for any ticker. "
                "The data source may be down."
            )
        return

    # Tickers can differ by a session (a halt, a late listing); report the span
    # the bulk of them actually cover.
    sessions = max(r["sessions"] for r in rows)
    span = f"{min(r['start'] for r in rows)} → {max(r['end'] for r in rows)}"

    title = f"<b>Last {sessions} trading day{'s' if sessions != 1 else ''}</b>"
    subtitle = f"{span} — measured from the prior close"

    up = sorted([r for r in rows if r["ret"] > 0], key=lambda r: r["ret"], reverse=True)
    down = sorted([r for r in rows if r["ret"] <= 0], key=lambda r: r["ret"])
    average = sum(r["ret"] for r in rows) / len(rows)

    print(f"\n{plain(title)}\n{subtitle}")

    sections = []
    for heading, group in (("🟢 <b>Up</b>", up), ("🔴 <b>Down</b>", down)):
        if not group:
            continue
        table = format_return_table(group)
        print(f"\n{plain(heading)}")
        print(table)
        sections.append(f"{heading}\n<pre>{escape(table)}</pre>")

    movers = len([r for r in rows if abs(r["ret"]) >= STRONG_MOVE])
    summary = (
        f"{len(up)} up / {len(down)} down of {len(rows)} — "
        f"average {average:+.1f}%, {movers} moved {STRONG_MOVE:.0f}%+"
    )
    print(f"\n{summary}")

    body = "\n\n".join([f"{title}\n{escape(subtitle)}", *sections, escape(summary)])

    if quiet:
        print("\n(--as-of set without --send: not sending to Telegram)")
        return

    send_telegram(body)


if __name__ == "__main__":
    main()
