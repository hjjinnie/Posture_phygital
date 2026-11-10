#!/usr/bin/env python3
"""Serves this folder on http://localhost:8785 (or the port given) and tells the browser to recheck files on every
load, so edits always show up on reload. Plain `python3 -m http.server` lets Chrome keep running stale modules."""
import functools, http.server, os, sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8785
handler = functools.partial(NoCacheHandler, directory=os.path.dirname(os.path.abspath(__file__)))
print(f"Posture Buddy: http://localhost:{port}", flush=True)
http.server.ThreadingHTTPServer(("", port), handler).serve_forever()
