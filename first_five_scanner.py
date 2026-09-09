"""
First-five-trading-days scanner.

Ranks every ticker by how it performed over the opening sessions of a month -
the classic "first five days" read. The return is measured from the previous
month's closing price to the close of the 5th trading day, so a gap on the
first session counts.

If the month is still young, whatever sessions exist so far are used and the
report says how many (a partial read, clearly labelled).

Usage:
    python first_five_scanner.py                     # latest complete window
    python first_five_scanner.py --month 2026-03     # print only
    python first_five_scanner.py --month 2026-03 --send
    python first_five_scanner.py --days 3            # first three sessions
"""

import argparse
from datetime import date
from html import escape

import pandas as pd

from scanner_core import (
    NOTIFY_WHEN_EMPTY,
    TICKERS,
    get_close,
    plain,
    send_telegram,
)

# ---------------- CONFIG ----------------
DEFAULT_DAYS = 5          # trading sessions counted from the start of the month
PERIOD = "3y"             # covers the worker's 24-month reach, plus the prior close
STRONG_MOVE = 5.0         # % that earns a ticker a spot in the "movers" summary
# -----------------------------------------

MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]


def parse_month(raw: str) -> tuple:
    """'YYYY-MM' -> (year, month), rejecting anything else."""
    try:
        year, month = raw.split("-")
        year, month = int(year), int(month)
    except ValueError:
        raise ValueError(f"'{raw}' is not a month in YYYY-MM form")
    if not 1 <= month <= 12 or not 1900 <= year <= 2999:
        raise ValueError(f"'{raw}' is not a real month")
    return year, month


def month_label(year: int, month: int) -> str:
    return f"{MONTH_NAMES[month - 1]} {year}"


def previous_month(year: int, month: int) -> tuple:
    return (year - 1, 12) if month == 1 else (year, month - 1)


def window_for(prices: pd.Series, year: int, month: int, days: int):
    """Return over the first `days` sessions of a month, vs the prior close.

    Returns None when the month has no bars yet, or when there is no earlier
    bar to measure from (the series does not reach back far enough).
    """
    in_month = prices[(prices.index.year == year) & (prices.index.month == month)]
    if in_month.empty:
        return None

    before = prices[prices.index < in_month.index[0]]
    if before.empty:
        return None

    window = in_month.iloc[:days]
    base = float(before.iloc[-1])
    last = float(window.iloc[-1])
    if base == 0:
        return None

    return {
        "base": base,
        "base_date": before.index[-1].date(),
        "last": last,
        "start": window.index[0].date(),
        "end": window.index[-1].date(),
        "sessions": len(window),
        "ret": (last - base) / base * 100.0,
    }


def sessions_available(prices: pd.Series, year: int, month: int) -> int:
    """How many sessions of that month this series has printed so far."""
    return int(((prices.index.year == year) & (prices.index.month == month)).sum())


def resolve_month(price_data: dict, days: int) -> tuple:
    """Default month: this one if it has `days` sessions, else the last one.

    Uses the widest session count across the downloaded tickers, so one symbol
    that halted trading cannot drag the whole report back a month.
    """
    today = date.today()
    have = max(
        (sessions_available(p, today.year, today.month) for p in price_data.values()),
        default=0,
    )
    if have >= days:
        return today.year, today.month
    return previous_month(today.year, today.month)


def format_table(rows: list) -> str:
    """Fixed-width table so the columns line up in a monospace block."""
    header = f"{'STK':<6}{'PREV':>9}{'LAST':>9}{'RET':>8}"
    lines = [header, "-" * len(header)]
    for m in rows:
        lines.append(
            f"{m['ticker']:<6}"
            f"{m['base']:>9.2f}"
            f"{m['last']:>9.2f}"
            f"{m['ret']:>7.1f}%"
        )
    return "\n".join(lines)


def parse_args():
    parser = argparse.ArgumentParser(
        description="Performance over the first trading days of a month"
    )
    parser.add_argument(
        "--month",
        metavar="YYYY-MM",
        help="which month to measure (default: the latest one with enough sessions)",
    )
    parser.add_argument(
        "--days",
        type=int,
        default=DEFAULT_DAYS,
        help=f"how many opening sessions to count (default {DEFAULT_DAYS})",
    )
    parser.add_argument(
        "--send",
        action="store_true",
        help="send to Telegram even when --month is used",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    if args.days < 1:
        raise SystemExit("--days must be at least 1")

    requested = parse_month(args.month) if args.month else None

    price_data = {}
    for ticker in TICKERS:
        try:
            price_data[ticker] = get_close(ticker, PERIOD)
        except Exception as exc:
            print(f"Error checking {ticker}: {exc}")

    name = f"First {args.days} days"

    if not price_data:
        print("No usable data for any ticker.")
        if NOTIFY_WHEN_EMPTY and (requested is None or args.send):
            send_telegram(
                f"⚠️ <b>{escape(name)}</b> — no usable price data for any ticker. "
                "The data source may be down."
            )
        return

    year, month = requested or resolve_month(price_data, args.days)

    rows = []
    for ticker, prices in price_data.items():
        result = window_for(prices, year, month, args.days)
        if result is None:
            print(f"Skipping {ticker}: no usable {month_label(year, month)} window")
            continue
        rows.append({"ticker": ticker, **result})

    label = month_label(year, month)

    if not rows:
        print(f"No {label} data for any ticker.")
        if NOTIFY_WHEN_EMPTY and (requested is None or args.send):
            send_telegram(
                f"⚠️ <b>{escape(name)} — {escape(label)}</b>\n\n"
                "No ticker has data for that window."
            )
        return

    # Tickers can differ by a session (a halt, a late listing); report the span
    # the bulk of them actually cover.
    sessions = max(r["sessions"] for r in rows)
    span = f"{min(r['start'] for r in rows)} → {max(r['end'] for r in rows)}"
    partial = " (partial)" if sessions < args.days else ""

    title = f"<b>First {sessions} trading day{'s' if sessions != 1 else ''} of {escape(label)}</b>{partial}"
    subtitle = f"{span} — measured from the prior close"

    up = sorted([r for r in rows if r["ret"] > 0], key=lambda r: r["ret"], reverse=True)
    down = sorted([r for r in rows if r["ret"] <= 0], key=lambda r: r["ret"])
    average = sum(r["ret"] for r in rows) / len(rows)

    print(f"\n{plain(title)}\n{subtitle}")

    sections = []
    for heading, group in (("🟢 <b>Up</b>", up), ("🔴 <b>Down</b>", down)):
        if not group:
            continue
        table = format_table(group)
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

    if requested is not None and not args.send:
        print("\n(--month set without --send: not sending to Telegram)")
        return

    send_telegram(body)


if __name__ == "__main__":
    main()
