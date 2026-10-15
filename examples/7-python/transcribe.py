r"""
Transcribe one audio file with the Transcribe API. Needs Python 3.8+ and the "requests" package.

    python transcribe.py                          -> transcribes ..\sample\clip.mp3
    python transcribe.py C:\calls\call.mp3        -> your own file
    python transcribe.py call.mp3 --language auto -> let Whisper detect the language
    python transcribe.py --help                   -> all options

Steps: 1. upload the file  2. check the status every 3 s  3. print the text  4. save output\<name>.srt

engine=worker: your PC worker transcribes the file, so we poll until the job is completed or failed.
engine=cloud with --wait: the server transcribes inside the upload request and answers with the result.

Settings come from ..\.env: TRANSCRIBE_API_URL, TRANSCRIBE_API_KEY, TRANSCRIBE_ENGINE, TRANSCRIBE_LANGUAGE.
"""

import argparse
import json
import mimetypes
import sys
import time
from pathlib import Path

try:
    import requests
except ImportError:
    sys.exit("The 'requests' package is missing. Run:  pip install -r requirements.txt")

from env import key_hint, require_setting, setting  # reads ..\.env

HERE = Path(__file__).resolve().parent
DEFAULT_FILE = HERE.parent / "sample" / "clip.mp3"
OUTPUT_DIR = HERE / "output"

POLL_SECONDS = 3           # how often we ask for the status
TIMEOUT_SECONDS = 15 * 60  # stop waiting after 15 minutes (the job keeps running on the server)
DONE = ("completed", "failed")


# --- API client (copy this part into your project) -------------------------------------------

class TranscribeError(Exception):
    """An error answer from the API: {"error": {"code": "...", "message": "..."}}."""

    def __init__(self, message, status=0, code="error"):
        super().__init__(message)
        self.status = status  # HTTP status code (0 = no answer, e.g. the server is offline)
        self.code = code      # e.g. invalid_api_key, validation_error, file_too_large, engine_unavailable


class TranscribeClient:
    """Small client for the public REST API. base_url is the install URL WITHOUT /api/v1."""

    def __init__(self, base_url, api_key, timeout=120):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout  # seconds to wait for an answer
        self.session = requests.Session()
        self.session.headers.update({
            "Authorization": "Bearer " + api_key,  # or the header  X-API-Key: tk_...
            "Accept": "application/json",
        })

    def create(self, audio_path, **fields):
        """POST /api/v1/transcriptions (multipart/form-data). Returns the transcription object.

        fields (all optional): engine ("worker" | "cloud"), language ("en", ... or "auto"),
        task ("transcribe" | "translate"), prompt (cloud only), webhook_url, metadata (a dict),
        wait (True: cloud only, the answer is the finished job).
        Answer: 202 with status "queued", or 200 with "completed"/"failed" when wait=True did the work.
        """
        data = {}
        for name, value in fields.items():
            if value is None or value == "" or value is False:
                continue  # not sent = the server uses the project default
            if isinstance(value, dict):
                value = json.dumps(value)  # metadata must be a JSON object string (max 4 KB)
            data[name] = "true" if value is True else str(value)

        audio_path = Path(audio_path)
        mime = mimetypes.guess_type(audio_path.name)[0] or "application/octet-stream"
        # wait=true: the server transcribes inside this request (up to 10 minutes), so wait longer.
        timeout = max(self.timeout, 660) if data.get("wait") == "true" else self.timeout
        with audio_path.open("rb") as audio:
            # The server checks the file name extension (only .mp3 by default).
            files = {"file": (audio_path.name, audio, mime)}
            response = self._request("POST", "/api/v1/transcriptions", data=data, files=files, timeout=timeout)
        return self._json(response)

    def get(self, transcription_id):
        """GET /api/v1/transcriptions/{id}: status, progress (0-100), and text + segments when completed."""
        return self._json(self._request("GET", "/api/v1/transcriptions/" + transcription_id))

    def download(self, transcription_id, fmt="srt"):
        """GET /api/v1/transcriptions/{id}?format=txt|srt|vtt|json -> file content as bytes (UTF-8).
        The server answers 409 not_ready until the job is completed."""
        return self._request("GET", "/api/v1/transcriptions/" + transcription_id, params={"format": fmt}).content

    def list(self, status=None, limit=20, offset=0):
        """GET /api/v1/transcriptions -> {"object": "list", "data": [...], "total", "limit", "offset"}.
        Newest first. List items have no "segments"."""
        params = {"limit": limit, "offset": offset}
        if status:
            params["status"] = status  # queued | processing | completed | failed
        return self._json(self._request("GET", "/api/v1/transcriptions", params=params))

    def delete(self, transcription_id):
        """DELETE /api/v1/transcriptions/{id} -> {"id": "tr_...", "deleted": true} (also deletes the audio)."""
        return self._json(self._request("DELETE", "/api/v1/transcriptions/" + transcription_id))

    def _request(self, method, path, timeout=None, **kwargs):
        try:
            # No automatic redirects: a redirected POST silently becomes a GET and loses the upload.
            response = self.session.request(method, self.base_url + path, allow_redirects=False,
                                            timeout=(10, timeout or self.timeout), **kwargs)
        except requests.RequestException as exc:
            raise TranscribeError(f"Cannot reach the API at {self.base_url} ({exc})", 0, "network_error")

        if 300 <= response.status_code < 400:
            # Typical case: http:// -> https://. Use the new address (without /api/v1) as the base URL.
            raise TranscribeError(f"The server redirected to {response.headers.get('Location')}. "
                                  "Fix TRANSCRIBE_API_URL.", response.status_code, "redirect")
        if response.status_code >= 400:
            try:
                error = response.json().get("error")
            except (ValueError, AttributeError):
                error = None  # not JSON, e.g. an HTML error page from the web host
            if not isinstance(error, dict):
                error = {}
            raise TranscribeError(error.get("message") or f"HTTP {response.status_code}",
                                  response.status_code, error.get("code") or f"http_{response.status_code}")
        return response

    def _json(self, response):
        try:
            data = response.json()
        except ValueError:
            data = None
        if not isinstance(data, dict):
            # Usually TRANSCRIBE_API_URL is wrong. It must be the base URL, without /api/v1.
            raise TranscribeError(f"The API did not answer with JSON. Check TRANSCRIBE_API_URL ({self.base_url}).",
                                  response.status_code, "bad_response")
        return data


# --- Command line demo ------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Transcribe an audio file with the Transcribe API.")
    parser.add_argument("file", nargs="?", default=str(DEFAULT_FILE),
                        help="audio file (default: ..\\sample\\clip.mp3)")
    parser.add_argument("--engine", choices=("worker", "cloud"),
                        help="default: TRANSCRIBE_ENGINE from .env, else worker")
    parser.add_argument("--language",
                        help='"en", "de", ... or "auto" to detect it (default: TRANSCRIBE_LANGUAGE from .env; '
                             "empty = project default)")
    parser.add_argument("--wait", action="store_true",
                        help="cloud only: the server answers with the finished job (no polling)")
    parser.add_argument("--webhook-url", help="public URL that gets the result by POST (see webhook_receiver.py)")
    parser.add_argument("--out", default=str(OUTPUT_DIR), help="folder for the .srt file (default: output)")
    args = parser.parse_args()

    base_url = require_setting("TRANSCRIBE_API_URL")
    api_key = require_setting("TRANSCRIBE_API_KEY")
    engine = (args.engine or setting("TRANSCRIBE_ENGINE", "worker")).strip().lower()
    language = (args.language if args.language is not None else setting("TRANSCRIBE_LANGUAGE")).strip()
    # Not sent -> the server uses the project's default language. "auto" -> Whisper detects it.
    wait = args.wait and engine == "cloud"

    audio = Path(args.file)
    if not audio.is_file():
        fail(f"File not found: {audio}")
    audio = audio.resolve()

    print("Transcribe API - Python demo")
    print(f"  Server:   {base_url}")
    print(f"  Key:      {key_hint(api_key)}")
    print(f"  File:     {audio} ({audio.stat().st_size / 1048576:.1f} MB)")
    print(f"  Engine:   {engine}    Language: {language or 'project default'}" + ("    wait: yes" if wait else ""))
    print()
    if args.wait and not wait:
        print("Note: --wait only works with --engine cloud. Polling instead.\n")

    api = TranscribeClient(base_url, api_key)

    # 1. Upload -----------------------------------------------------------------------------------
    print("Uploading and transcribing (cloud, wait=true)..." if wait else "Uploading...")
    try:
        job = api.create(
            audio,
            engine=engine,
            language=language,
            wait=wait,
            webhook_url=args.webhook_url,
            metadata={"demo": "7-python", "file": audio.name},  # comes back unchanged in results and webhooks
        )
    except TranscribeError as exc:
        fail(f"Upload failed: {exc} ({exc.code}){hint(exc)}")
    print(f"  Created {job['id']}  (status: {job['status']})\n")

    # 2. Poll until the job is completed or failed (wait=true may have finished it already) -------
    if job["status"] not in DONE:
        job = wait_for_result(api, job)

    if job["status"] == "failed":
        fail("Transcription failed: " + (job.get("error") or "unknown error"))

    # 3. Print the text with timestamps -----------------------------------------------------------
    print(f"\nDone. Audio length: {job.get('duration') or '?'} s, language: {job.get('detected_language') or '?'}\n")
    segments = job.get("segments") or []
    for segment in segments:
        print(f"[{clock(segment['start'])}] {segment['text'].strip()}")
    if not segments:
        print(job.get("text") or "(no speech found)")

    # 4. Save the subtitles (the server builds the SRT file for us) -------------------------------
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    srt_file = out_dir / (audio.stem + ".srt")
    try:
        srt_file.write_bytes(api.download(job["id"], "srt"))
    except TranscribeError as exc:
        fail(f"Download failed: {exc}")

    print(f"\nSaved {srt_file.resolve()}")
    print(f"Transcription id: {job['id']} (you can also see it in the dashboard)")
    return 0


def wait_for_result(api, job):
    """Asks for the status every POLL_SECONDS until the job is completed or failed."""
    print(f"Waiting for the result (checking every {POLL_SECONDS} s, Ctrl+C to stop)...")
    started = time.monotonic()
    last_line, last_print, failures, warned = "", -1, 0, False

    while job["status"] not in DONE:
        time.sleep(POLL_SECONDS)
        elapsed = int(time.monotonic() - started)
        if elapsed > TIMEOUT_SECONDS:
            fail(f"Still not done after {TIMEOUT_SECONDS // 60} minutes. "
                 f"The job keeps running on the server: {job['id']}")
        try:
            job = api.get(job["id"])
            failures = 0
        except TranscribeError as exc:
            # A short network problem or server restart: try again. Other errors (401, 404): stop.
            failures += 1
            if failures >= 5 or not (exc.status == 0 or exc.status == 429 or exc.status >= 500):
                fail(f"Status check failed: {exc} ({exc.code})")
            print(f"  (status check failed, trying again: {exc})")
            continue

        line = job["status"] if job.get("progress") is None else f"{job['status']} {job['progress']}%"
        # Print when something changed, or every 30 s so you can see it is still alive.
        if line != last_line or elapsed - last_print >= 30:
            print(f"  [{elapsed:4d} s] {line}", flush=True)
            last_line, last_print = line, elapsed
        if job["status"] == "queued" and job["engine"] == "worker" and elapsed >= 60 and not warned:
            print("  Still queued. Is the PC worker running? (It does one job at a time.)")
            warned = True
    return job


def hint(error):
    """A next step for the most common upload errors."""
    if error.code in ("invalid_api_key", "unauthorized"):
        return "\n  Check TRANSCRIBE_API_KEY in ..\\.env (Dashboard -> project -> API keys)."
    if error.code == "engine_unavailable":
        return "\n  This server cannot use that engine. Try:  python transcribe.py --engine worker"
    if error.code == "file_too_large":
        return "\n  For big files use the worker engine:  --engine worker"
    if error.code == "network_error":
        return "\n  Is the server running? Check TRANSCRIBE_API_URL in ..\\.env."
    return ""


def clock(seconds):
    """75.5 -> '01:15.5'"""
    seconds = round(seconds, 1)  # round first, so 59.97 becomes 01:00.0 and not 00:60.0
    minutes = int(seconds // 60)
    return f"{minutes:02d}:{seconds - minutes * 60:04.1f}"


def fail(message):
    print(f"\nERROR: {message}", file=sys.stderr)
    sys.exit(1)


if __name__ == "__main__":
    # Some Windows consoles cannot show every character; replace those instead of crashing.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit("\nStopped. The job keeps running on the server.")
