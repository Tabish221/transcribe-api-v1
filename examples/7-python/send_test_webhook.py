"""
Sends a signed test event to webhook_receiver.py, the same way the Transcribe API server does.
Use it to test your receiver on your own PC (the real server only calls public URLs).

    python send_test_webhook.py                  -> expect: HTTP 200 {"ok":true}
    python send_test_webhook.py --bad-signature  -> expect: HTTP 401 {"error":"invalid signature"}
"""

import argparse
import hashlib
import hmac
import json
import sys
from datetime import datetime, timezone

try:
    import requests
except ImportError:
    sys.exit("The 'requests' package is missing. Run:  pip install -r requirements.txt")

from env import require_setting, setting  # same secret and port as the receiver (from ..\.env)


def main():
    port = setting("WEBHOOK_PORT", "4000")
    parser = argparse.ArgumentParser(description="Send a signed test webhook to webhook_receiver.py.")
    parser.add_argument("--url", default=f"http://127.0.0.1:{port}/webhook", help="receiver URL")
    parser.add_argument("--bad-signature", action="store_true", help="sign with a wrong secret (expect 401)")
    args = parser.parse_args()

    # A completed transcription object, with the same fields the server sends.
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    job = {
        "id": "tr_000000000000000000000000", "object": "transcription", "project_id": "prj_test",
        "status": "completed", "engine": "worker", "language": "en", "detected_language": "en",
        "task": "transcribe", "filename": "test.mp3", "file_size": 1234, "duration": 2.5, "progress": 100,
        "text": "This is a test webhook.",
        "segments": [{"id": 0, "start": 0.0, "end": 2.5, "text": "This is a test webhook."}],
        "error": None, "metadata": {"demo": "7-python"}, "webhook_status": "pending",
        "created_at": now, "started_at": now, "completed_at": now,
    }
    body = json.dumps({"event": "transcription.completed", "created_at": now, "data": job},
                      separators=(",", ":"), ensure_ascii=False).encode("utf-8")

    secret = b"wrong-secret" if args.bad_signature else require_setting("TRANSCRIBE_WEBHOOK_SECRET").encode("utf-8")
    signature = "sha256=" + hmac.new(secret, body, hashlib.sha256).hexdigest()

    response = requests.post(args.url, data=body, timeout=10, headers={
        "Content-Type": "application/json",
        "User-Agent": "TranscribeAPI/1.0",
        "X-Transcribe-Event": "transcription.completed",
        "X-Transcribe-Delivery": job["id"],
        "X-Transcribe-Signature": signature,
    })
    print(f"POST {args.url} -> HTTP {response.status_code} {response.text.strip()}")
    return 0 if response.ok == (not args.bad_signature) else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except requests.RequestException as exc:
        sys.exit(f"ERROR: cannot reach the receiver. Is webhook_receiver.py running?  ({exc})")
