r"""
Receives Transcribe API webhooks with Flask and checks the signature.

    python webhook_receiver.py     -> listens on http://127.0.0.1:4000/webhook  (Ctrl+C to stop)

When a job is completed or failed, the server sends:
    POST <your webhook URL>
    Content-Type: application/json
    X-Transcribe-Event: transcription.completed            (or transcription.failed)
    X-Transcribe-Delivery: tr_...                          (the transcription id)
    X-Transcribe-Signature: sha256=<hex HMAC-SHA256 of the raw body, key = project webhook secret>

    {"event": "transcription.completed", "created_at": "2026-10-15T12:00:00Z", "data": {transcription object}}

Any 2xx answer = delivered. Any other answer (or no answer in 10 s) = the server tries again later.
The server only calls PUBLIC http(s) URLs: to test on your PC use a tunnel (ngrok, cloudflared),
or run send_test_webhook.py, which sends a signed test event to this receiver.

Settings come from ..\.env: TRANSCRIBE_WEBHOOK_SECRET (the project's "whsec_..." secret).
Port: WEBHOOK_PORT (default 4000).
"""

import hashlib
import hmac
import json
import re
import sys
from pathlib import Path

try:
    from flask import Flask, jsonify, request
except ImportError:
    sys.exit("The 'flask' package is missing. Run:  pip install -r requirements.txt")

from env import require_setting, setting  # reads ..\.env

WEBHOOK_SECRET = require_setting("TRANSCRIBE_WEBHOOK_SECRET").encode("utf-8")  # never print it
PORT = int(setting("WEBHOOK_PORT", "4000"))
RESULTS_DIR = Path(__file__).resolve().parent / "results"
TRANSCRIPTION_ID = re.compile(r"^tr_[a-f0-9]{24}$")

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024  # long recordings have many segments


def signature_is_valid(raw_body, header):
    """True when the header is "sha256=" + HMAC-SHA256(raw body, secret) of the exact bytes we got."""
    expected = "sha256=" + hmac.new(WEBHOOK_SECRET, raw_body, hashlib.sha256).hexdigest()
    received = (header or "").strip()
    # compare_digest takes the same time for every input, so it does not leak the right signature.
    return hmac.compare_digest(expected.encode("utf-8"), received.encode("utf-8"))


@app.route("/webhook", methods=["POST"])
def webhook():
    # 1. Check the signature over the RAW body. Read it before request.json / request.form,
    #    and never hash re-encoded JSON: one different byte gives a different signature.
    raw_body = request.get_data()
    if not signature_is_valid(raw_body, request.headers.get("X-Transcribe-Signature")):
        print(f"Rejected a request with a missing or wrong signature (from {request.remote_addr})")
        return jsonify(error="invalid signature"), 401

    # 2. Read the event.
    try:
        payload = json.loads(raw_body)
    except ValueError:
        return jsonify(error="invalid JSON"), 400
    job = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(job, dict) or not TRANSCRIPTION_ID.match(str(job.get("id", ""))):
        return jsonify(error="payload has no valid transcription id"), 400
    event = payload.get("event")

    # 3. Handle it. Answer quickly (the server waits 10 s). The same event can arrive twice
    #    (retries), so save it by transcription id: overwrite, do not add a second copy.
    if event == "transcription.completed":
        RESULTS_DIR.mkdir(exist_ok=True)
        saved = RESULTS_DIR / (job["id"] + ".json")  # TODO: save to your database instead
        saved.write_text(json.dumps(job, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"\n[completed] {job['id']}  ({job.get('filename')}, {job.get('duration')} s, "
              f"language: {job.get('detected_language')})")
        if job.get("metadata"):
            print(f"  metadata: {json.dumps(job['metadata'])}")  # what you sent with the upload
        print(f"  {job.get('text') or ''}")
        print(f"  Saved {saved}")
    elif event == "transcription.failed":
        print(f"\n[failed] {job['id']}  ({job.get('filename')}): {job.get('error')}")
    else:
        print(f"\nIgnored unknown event: {event}")  # still answer 2xx, so the server does not retry

    return jsonify(ok=True)


@app.route("/", methods=["GET"])
def index():
    return jsonify(ok=True, message="Webhook receiver is running. The API posts to /webhook.")


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    print(f"Webhook receiver: http://127.0.0.1:{PORT}/webhook  (Ctrl+C to stop)")
    print(f"Results are saved in {RESULTS_DIR}")
    # Flask's built-in server is for development. In production use a real server, for example:
    #   pip install waitress
    #   waitress-serve --host=127.0.0.1 --port=4000 webhook_receiver:app
    app.run(host="127.0.0.1", port=PORT)
