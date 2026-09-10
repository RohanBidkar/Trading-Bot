"""
SMA20 band levels - the whole watchlist at once.

Not a screen: no ticker is filtered out. For every ticker it prints the two
prices that sit BAND_PCT either side of SMA20, so you can see at a glance
where each name would have to trade to reach the band:

    LOW  = SMA20 * (1 - BAND_PCT/100)   the level a pullback would hit
    HIGH = SMA20 * (1 + BAND_PCT/100)   the level a run-up would hit

DIFF is where the close sits today, relative to SMA20: at -BAND_PCT or lower
the low band is already taken out, at +BAND_PCT or higher the high one is.

Usage:
    python sma_band_scanner.py
    python sma_band_scanner.py --as-of 2026-09-01          # print only
    python sma_band_scanner.py --as-of 2026-09-01 --send   # and send
    python sma_band_scanner.py --band 3.0                  # a different band
"""

from datetime import date
from html import escape

from scanner_core import (
    LOOKBACK,
    LOOKBACK_HISTORICAL,
    NOTIFY_WHEN_EMPTY,
    SMA_LEN,
    TICKERS,
    build_parser,
    evaluate,
    plain,
    send_telegram,
)

# ---------------- CONFIG ----------------
BAND_PCT = 2.8            # distance either side of SMA20, in percent
# Telegram rejects anything over 4096 characters, so a long table goes out in
# several messages rather than failing as one.
MAX_MESSAGE_CHARS = 3500
# -----------------------------------------


def levels(m: dict, band: float) -> dict:
    """The two band prices for one ticker's metrics."""
    return {
        **m,
        "low": m["sma"] * (1 - band / 100.0),
        "high": m["sma"] * (1 + band / 100.0),
    }


def format_table(rows: list, band: float) -> str:
    """Fixed-width table so the columns line up in a monospace block."""
    header = (
        f"{'STK':<6}{'CLOSE':>8}{f'SMA{SMA_LEN}':>8}"
        f"{f'-{band:.1f}%':>9}{f'+{band:.1f}%':>9}{'DIFF':>7}"
    )
    lines = [header, "-" * len(header)]
    for m in rows:
        lines.append(
            f"{m['ticker']:<6}"
            f"{m['close']:>8.2f}"
            f"{m['sma']:>8.2f}"
            f"{m['low']:>9.2f}"
            f"{m['high']:>9.2f}"
            f"{m['diff']:>7.1f}%"
        )
    return "\n".join(lines)


def chunk_rows(rows: list, band: float) -> list:
    """Split into as many tables as it takes to stay under Telegram's cap."""
    tables, batch = [], []
    for row in rows:
        candidate = batch + [row]
        if batch and len(format_table(candidate, band)) > MAX_MESSAGE_CHARS:
            tables.append(format_table(batch, band))
            batch = [row]
        else:
            batch = candidate
    if batch:
        tables.append(format_table(batch, band))
    return tables


def parse_args():
    parser = build_parser(f"SMA{SMA_LEN} band levels for every ticker")
    parser.add_argument(
        "--band",
        type=float,
        default=BAND_PCT,
        help=f"distance either side of SMA{SMA_LEN}, in percent (default {BAND_PCT})",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    band = args.band
    if band <= 0:
        raise SystemExit("--band must be greater than 0")

    as_of = date.fromisoformat(args.as_of) if args.as_of else None
    period = LOOKBACK_HISTORICAL if as_of else LOOKBACK
    name = f"SMA{SMA_LEN} bands ±{band:.1f}%"

    rows = []
    for ticker in TICKERS:
        try:
            m = evaluate(ticker, as_of=as_of, period=period)
            if m is not None:
                rows.append(levels(m, band))
        except Exception as exc:
            print(f"Error checking {ticker}: {exc}")

    if not rows:
        print("No usable data for any ticker.")
        if NOTIFY_WHEN_EMPTY and not (as_of and not args.send):
            send_telegram(
                f"⚠️ <b>{escape(name)}</b> — no usable price data for any ticker. "
                "The data source may be down."
            )
        return

    # Most stretched below SMA20 first, so the names nearest the low band -
    # or already through it - are at the top.
    rows.sort(key=lambda m: m["diff"])

    bar_date = max(m["date"] for m in rows)
    below = len([m for m in rows if m["diff"] <= -band])
    above = len([m for m in rows if m["diff"] >= band])

    title = f"<b>{escape(name)}</b> — bar {bar_date}"
    subtitle = (
        f"LOW/HIGH are SMA{SMA_LEN} ∓{band:.1f}%. "
        f"{below} at or below the low band, {above} at or above the high, "
        f"of {len(rows)} scanned."
    )

    tables = chunk_rows(rows, band)

    print(f"\n{plain(title)}\n{subtitle}\n")
    for table in tables:
        print(table)

    if as_of and not args.send:
        print("\n(--as-of set without --send: not sending to Telegram)")
        return

    # One message per table; only the first carries the heading.
    for index, table in enumerate(tables):
        part = f" ({index + 1}/{len(tables)})" if len(tables) > 1 else ""
        head = f"{title}{part}\n{escape(subtitle)}\n\n" if index == 0 else f"{title}{part}\n\n"
        send_telegram(f"{head}<pre>{escape(table)}</pre>")


if __name__ == "__main__":
    main()
