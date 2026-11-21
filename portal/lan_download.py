"""Serve the Android APK on the local network so a phone can install it by scanning a QR code.

Accounts and the API stay on the HTTPS portal; this listener only serves a download page and the APK.
Assistente IA by Diogo Moreira. MIT License.
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import hashlib
import html
import shutil
import sys

ROOT = Path(__file__).resolve().parent
APK = ROOT / "downloads" / "AssistenteIA-Android.apk"
LOGO = ROOT / "public" / "assets" / "logo.svg"


def page():
    if APK.is_file():
        size = f"{APK.stat().st_size / 1048576:.1f} MB"
        digest = hashlib.sha256(APK.read_bytes()).hexdigest()
        action = (f'<a class="button" href="/{APK.name}" download>Download for Android</a>'
                  f'<p class="meta">{size} &middot; Android 4.4 or newer</p>')
        check = f'<details><summary>Verify the file</summary><p>SHA-256</p><code>{html.escape(digest)}</code></details>'
    else:
        action, check = '<p class="meta">The Android app is not available yet.</p>', ""
    return f"""<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Assistente IA for Android</title>
<link rel="icon" href="/logo.svg">
<style>
:root{{color-scheme:dark}}*{{box-sizing:border-box}}
body{{margin:0;min-height:100vh;background:radial-gradient(80% 50% at 80% 0%,rgba(144,133,233,.18),transparent),radial-gradient(70% 50% at 0% 100%,rgba(217,89,38,.16),transparent),#0f1014;color:#eceef2;font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;flex-direction:column}}
main{{width:100%;max-width:460px;margin:0 auto;padding:48px 24px 24px;flex:1}}
.brand{{display:flex;align-items:center;gap:12px;font-weight:700;font-size:20px;margin-bottom:28px}}
.brand img{{width:44px;height:44px}}
.brand b{{background:linear-gradient(90deg,#d95926,#9085e9);-webkit-background-clip:text;background-clip:text;color:transparent}}
h1{{font-size:30px;line-height:1.15;margin:0 0 10px;letter-spacing:-.02em}}
p{{color:#b4b9c3;margin:0 0 14px}}
.button{{display:block;text-align:center;background:#8fa8ff;color:#0f1430;text-decoration:none;border-radius:12px;font-weight:700;padding:15px 18px;margin:26px 0 8px}}
.meta{{font-size:13px;color:#8a909c;text-align:center}}
ol{{color:#b4b9c3;padding-left:20px;margin:26px 0}}li{{margin-bottom:8px}}
details{{background:#16171d;border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:12px 14px;font-size:13px;color:#8a909c}}
summary{{cursor:pointer}}code{{display:block;word-break:break-all;color:#eceef2;font-size:12px}}
footer{{text-align:center;font-size:12.5px;color:#8a909c;padding:24px}}footer a{{color:#b4b9c3}}
</style>
<main>
<div class="brand"><img src="/logo.svg" alt=""><span>Assistente <b>IA</b></span></div>
<h1>Your coding agents, in your pocket.</h1>
<p>Follow Claude Code and Codex sessions and answer their requests from your phone or tablet.</p>
{action}
<ol>
<li>Open the downloaded file. If Android asks, allow installs from your browser.</li>
<li>Open Assistente IA and tap <strong>Connect to PC</strong>.</li>
<li>In the portal, open <strong>Devices</strong> and scan the pairing code.</li>
</ol>
{check}
</main>
<footer>Assistente IA &middot; Created by <a href="https://github.com/diogosmoreira84">Diogo Moreira</a> &middot; MIT License</footer>
</html>""".encode()


class Download(BaseHTTPRequestHandler):
    timeout = 12
    server_version = "AssistenteIA"

    def log_message(self, *_):
        pass

    def headers_for(self, kind, length, extra=None):
        self.send_response(200)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()

    def route(self, body):
        path = self.path.split("?", 1)[0]
        try:
            if path == "/":
                content = page()
                self.headers_for("text/html; charset=utf-8", len(content))
                if body:
                    self.wfile.write(content)
            elif path == "/logo.svg" and LOGO.is_file():
                content = LOGO.read_bytes()
                self.headers_for("image/svg+xml", len(content))
                if body:
                    self.wfile.write(content)
            elif path == "/" + APK.name and APK.is_file():
                self.headers_for("application/vnd.android.package-archive", APK.stat().st_size,
                                 {"Content-Disposition": f'attachment; filename="{APK.name}"'})
                if body:
                    with APK.open("rb") as file:
                        shutil.copyfileobj(file, self.wfile)
            else:
                self.send_error(404)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def do_GET(self):
        self.route(True)

    def do_HEAD(self):
        self.route(False)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python lan_download.py <LAN_IP>")
    ThreadingHTTPServer((sys.argv[1], 8782), Download).serve_forever()
