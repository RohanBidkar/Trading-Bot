"""
Tell the website that this workflow run started or finished.

Called by .github/workflows/daily_scan.yml as the first and last step:

    python report_status.py running
    python report_status.py "$JOB_STATUS"     # success / failure / cancelled

Standard library only, so it runs before `pip install`. Everything comes from
the environment the workflow sets (RESULTS_URL, RESULTS_SECRET, RUN_ID, SCAN,
AS_OF, MONTH, GITHUB_*). Unset RESULTS_URL/SECRET means no website: it exits
quietly, and any failure is logged without failing the job.
"""

import json
import os
import sys
import urllib.request


def main() -> None:
    status = sys.argv[1] if len(sys.argv) > 1 else ""
    url = os.environ.get("RESULTS_URL", "").strip().rstrip("/")
    secret = os.environ.get("RESULTS_SECRET", "").strip()
    run_id = os.environ.get("RUN_ID", "").strip()
    if not (url and secret and run_id):
        print("Website not configured (RESULTS_URL / RESULTS_SECRET): skipping status report")
        return

    server = os.environ.get("GITHUB_SERVER_URL", "https://github.com")
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    gh_run = os.environ.get("GITHUB_RUN_ID", "")
    payload = {
        "run_id": run_id,
        "status": status,
        "scan": os.environ.get("SCAN", ""),
        "as_of": os.environ.get("AS_OF", ""),
        "month": os.environ.get("MONTH", ""),
        "event": os.environ.get("GITHUB_EVENT_NAME", ""),
        "gh_url": f"{server}/{repo}/actions/runs/{gh_run}" if repo and gh_run else None,
    }
    request = urllib.request.Request(
        f"{url}/api/results/status",
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {secret}",
            "User-Agent": "alert-bot-workflow",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as resp:
            print(f"Website told: {status} (run {run_id}) [{resp.status}]")
    except Exception as exc:
        print(f"Could not report status to the website: {exc}")


if __name__ == "__main__":
    main()
