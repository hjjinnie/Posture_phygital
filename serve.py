#!/usr/bin/env python3
"""Serves this folder on http://localhost:8785 (or the port given) and saves study data.

GET  serves files and tells the browser to recheck them on every load, so edits always show up on reload
     (plain `python3 -m http.server` lets Chrome keep running stale modules).
POST /data/<participant>/<file>?mode=append|write|replace  stores study data under data/<participant>/.
     append adds the request body to the end of the file; write replaces it, first moving any existing file to
     <name>.<timestamp>.bak so a re-run never destroys a recording or calibration; replace overwrites (for files
     the app regenerates, like the scored CSVs). Only accepts requests from this machine.
"""
import functools, http.server, os, re, sys, time
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")
PATH = re.compile(r"^/data/([A-Za-z0-9_-]{1,40})/([A-Za-z0-9_.-]{1,80}\.(?:jsonl|csv|json))$")
MAX_BODY = 64 << 20


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_GET(self):
        if self.path == "/__study_ping":   # lets the app check it can save study data here
            self.send_response(204)
            self.end_headers()
            return
        super().do_GET()

    def do_POST(self):
        url = urlparse(self.path)
        m = PATH.match(url.path)
        if not m or self.client_address[0] not in ("127.0.0.1", "::1"):
            return self.send_error(403 if m else 404)
        mode = parse_qs(url.query).get("mode", ["append"])[0]
        n = int(self.headers.get("Content-Length") or 0)
        if mode not in ("append", "write", "replace") or n > MAX_BODY:
            return self.send_error(400)
        body = self.rfile.read(n)
        folder = os.path.join(DATA, m.group(1))
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, m.group(2))
        if mode == "write" and os.path.exists(path):
            os.replace(path, f"{path}.{time.strftime('%Y%m%d-%H%M%S')}.bak")
        with open(path, "ab" if mode == "append" else "wb") as f:   # write and replace both start the file afresh
            f.write(body)
            f.flush()
            os.fsync(f.fileno())
        self.send_response(204)
        self.end_headers()

    def log_request(self, code="-", size="-"):
        if self.command != "POST":   # keep the console readable during a 22-minute session
            super().log_request(code, size)


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8785
print(f"Posture Buddy: http://localhost:{port}  (study data: {DATA})", flush=True)
http.server.ThreadingHTTPServer(("", port), functools.partial(Handler, directory=ROOT)).serve_forever()
