"""
One-time helper: point your Telegram bot at the Cloudflare Worker.

Usage:
    export TELEGRAM_TOKEN="..."          # from @BotFather
    export TELEGRAM_SECRET_TOKEN="..."   # same value as the Worker's secret
    export WORKER_URL="https://alert-bot.<subdomain>.workers.dev"
    python set_webhook.py

Add --info to just inspect the current webhook, or --delete to remove it
(deleting re-enables getUpdates, which a webhook otherwise blocks).
"""

import os
import sys

import requests

TOKEN = os.environ.get("TELEGRAM_TOKEN", "").strip()
SECRET = os.environ.get("TELEGRAM_SECRET_TOKEN", "").strip()
WORKER_URL = os.environ.get("WORKER_URL", "").strip()

API = f"https://api.telegram.org/bot{TOKEN}"


def require(name: str, value: str) -> None:
    if not value:
        sys.exit(f"Missing {name}. See the docstring at the top of this file.")


def show_info() -> None:
    info = requests.get(f"{API}/getWebhookInfo", timeout=15).json()
    result = info.get("result", {})
    print(f"url:                   {result.get('url') or '(none set)'}")
    print(f"pending_update_count:  {result.get('pending_update_count')}")
    print(f"has_custom_certificate:{result.get('has_custom_certificate')}")
    if result.get("last_error_message"):
        print(f"last_error_message:    {result['last_error_message']}")
    else:
        print("last_error_message:    (none)")


def main() -> None:
    require("TELEGRAM_TOKEN", TOKEN)

    if "--info" in sys.argv:
        show_info()
        return

    if "--delete" in sys.argv:
        resp = requests.get(f"{API}/deleteWebhook", timeout=15).json()
        print(resp)
        return

    require("TELEGRAM_SECRET_TOKEN", SECRET)
    require("WORKER_URL", WORKER_URL)

    resp = requests.post(
        f"{API}/setWebhook",
        data={
            "url": WORKER_URL,
            "secret_token": SECRET,
            # Only message updates matter here; skip the rest.
            "allowed_updates": '["message"]',
        },
        timeout=15,
    ).json()

    if resp.get("ok"):
        print(f"Webhook set -> {WORKER_URL}\n")
        show_info()
    else:
        print(f"Failed: {resp.get('error_code')} {resp.get('description')}")


if __name__ == "__main__":
    main()
