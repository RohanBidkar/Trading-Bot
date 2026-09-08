"""
Oversold (long-side) scanner.

Setup A - Below SMA20:
  - Close < SMA20
  - far enough below, scaled by price: >$100 needs 5%, <=$100 needs 4%
  - RSI(14) <= 40

Setup B - Sharp drop:
  - Close is >= 10% below where it was 10 trading days ago

Usage:
    python oversold_scanner.py
    python oversold_scanner.py --as-of 2026-09-01          # print only
    python oversold_scanner.py --as-of 2026-09-01 --send   # and send
"""

from scanner_core import SMA_LEN, Setup, run, tier_threshold

# ---------------- CONFIG ----------------
PCT_DROP_ABOVE_TIER = -5.0   # close > $100 must be this far below SMA20
PCT_DROP_BELOW_TIER = -4.0   # close <= $100 must be this far below SMA20
RSI_OVERSOLD = 40
DROP_THRESHOLD = -10.0       # % over the 10-day window
# -----------------------------------------


def below_sma(m: dict) -> bool:
    needed = tier_threshold(m["close"], PCT_DROP_ABOVE_TIER, PCT_DROP_BELOW_TIER)
    return m["close"] < m["sma"] and m["diff"] <= needed and m["rsi"] <= RSI_OVERSOLD


def sharp_drop(m: dict) -> bool:
    return m["move"] <= DROP_THRESHOLD


SETUPS = [
    Setup(
        title=(
            f"\U0001F4C9 <b>Below SMA{SMA_LEN}</b> (RSI≤{RSI_OVERSOLD}, "
            f"{abs(PCT_DROP_BELOW_TIER):.0f}%/{abs(PCT_DROP_ABOVE_TIER):.0f}% over $100)"
        ),
        column="DIFF",
        key="diff",
        predicate=below_sma,
    ),
    Setup(
        title=f"⚡ <b>Down {abs(DROP_THRESHOLD):.0f}%+ in 10 days</b>",
        column="D10",
        key="move",
        predicate=sharp_drop,
    ),
]


if __name__ == "__main__":
    run("Oversold scan", SETUPS)
