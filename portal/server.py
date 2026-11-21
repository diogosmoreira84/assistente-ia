import argparse
import fnmatch
import hashlib
import hmac
import io
import json
import mimetypes
import re
import secrets
import shutil
import sqlite3
import ssl
import subprocess
import sys
import threading
import time
from contextlib import closing
from datetime import date, timedelta
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import URLError
from urllib.parse import parse_qs, quote, urlencode, urlsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
sys.path.insert(0, str(ROOT / ".deps"))
sys.path.insert(0, str(ROOT))
import qrcode
import qrcode.image.svg
import connector
import webpush

STATIC_TYPES = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
                ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
                ".ico": "image/x-icon", ".webmanifest": "application/manifest+json"}
SCHEMA = """
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  salt TEXT NOT NULL, password TEXT NOT NULL, github TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS tickets(token TEXT PRIMARY KEY, owner INTEGER NOT NULL REFERENCES users(id), kind TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '', expires INTEGER NOT NULL, seen INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS snapshots(owner INTEGER PRIMARY KEY REFERENCES users(id), updated INTEGER NOT NULL, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS decisions(owner INTEGER NOT NULL REFERENCES users(id), approval TEXT NOT NULL,
  source TEXT NOT NULL, choice TEXT NOT NULL, created INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
  PRIMARY KEY(owner, approval));
CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY, owner INTEGER NOT NULL REFERENCES users(id),
  time INTEGER NOT NULL, agent TEXT NOT NULL, project TEXT NOT NULL, event TEXT NOT NULL, result TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS attempts(key TEXT PRIMARY KEY, count INTEGER NOT NULL, until INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS local_binding(slot INTEGER PRIMARY KEY CHECK(slot=1),
  owner INTEGER NOT NULL REFERENCES users(id), device TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS activity(owner INTEGER NOT NULL REFERENCES users(id), day TEXT NOT NULL, tool TEXT NOT NULL,
  project TEXT NOT NULL, seconds REAL NOT NULL, PRIMARY KEY(owner, day, tool, project));
CREATE TABLE IF NOT EXISTS quota_samples(owner INTEGER NOT NULL REFERENCES users(id), time INTEGER NOT NULL,
  provider TEXT NOT NULL, label TEXT NOT NULL, percent REAL NOT NULL);
CREATE INDEX IF NOT EXISTS quota_samples_owner ON quota_samples(owner, time);
CREATE TABLE IF NOT EXISTS rules(id INTEGER PRIMARY KEY, owner INTEGER NOT NULL REFERENCES users(id), choice TEXT NOT NULL,
  agent TEXT NOT NULL, project TEXT NOT NULL, tool TEXT NOT NULL, pattern TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  created INTEGER NOT NULL, hits INTEGER NOT NULL DEFAULT 0, last_hit INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS user_prefs(owner INTEGER PRIMARY KEY REFERENCES users(id), body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS push_subs(endpoint TEXT PRIMARY KEY, owner INTEGER NOT NULL REFERENCES users(id), created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS notices(id INTEGER PRIMARY KEY, owner INTEGER NOT NULL REFERENCES users(id), time INTEGER NOT NULL,
  kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, url TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS alerts_sent(owner INTEGER NOT NULL REFERENCES users(id), key TEXT NOT NULL, time INTEGER NOT NULL,
  PRIMARY KEY(owner, key));
CREATE TABLE IF NOT EXISTS summaries(owner INTEGER NOT NULL REFERENCES users(id), day TEXT NOT NULL, body TEXT NOT NULL,
  created INTEGER NOT NULL, PRIMARY KEY(owner, day));
"""
OWNED_TABLES = ("tickets", "snapshots", "decisions", "logs", "activity", "quota_samples", "rules", "local_binding",
                "user_prefs", "push_subs", "notices", "alerts_sent", "summaries")
DEFAULT_PREFS = {"quotaAlert": 80, "dailySummary": True, "summaryHour": 19, "pushApprovals": True,
                 "pushFinished": False, "pushQuota": True, "pushSummary": True}
PUSH_PREF = {"approval": "pushApprovals", "finished": "pushFinished", "quota": "pushQuota", "summary": "pushSummary", "test": None}
NAMES = {"claude": "Claude Code", "codex": "Codex"}
RUNTIME = {"database": "", "subject": "https://github.com/diogosmoreira84"}
MIGRATIONS = (
    ("logs", "kind", "ALTER TABLE logs ADD COLUMN kind TEXT NOT NULL DEFAULT 'session'",
     "UPDATE logs SET kind='approval' WHERE event LIKE 'Approval%'; UPDATE logs SET kind='device' WHERE event LIKE 'Device%'"),
    ("logs", "detail", "ALTER TABLE logs ADD COLUMN detail TEXT NOT NULL DEFAULT ''", ""),
    ("decisions", "origin", "ALTER TABLE decisions ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'", ""),
)
DOWNLOADS = {
    "/downloads/windows": (ROOT.parent / "assistente-release" / "AssistenteIA-Windows-x64.zip", "application/zip"),
    "/downloads/connector": (ROOT / "connector.py", "application/octet-stream"),
    "/downloads/android": (ROOT / "downloads" / "AssistenteIA-Android.apk", "application/vnd.android.package-archive"),
}
LIFETIMES = {"session": 86400 * 7, "pair": 300, "agent": 86400 * 365, "device": 86400 * 365}
LOG_DAYS, LOG_ROWS, QUOTA_EVERY = 30, 3000, 300
# Commands joined, piped, redirected or substituted are never allowed by a wildcard rule.
SHELL_META = re.compile(r"[;&|`$<>\r\n]")
PROVIDERS = ("claude", "codex")
APP_VERSION = "1.2.0"
# The agent reports friendly action titles; raw tool names are accepted too.
COMMAND = "run a command"
COMMAND_TOOLS = (COMMAND, "use powershell")
TOOL_ALIASES = {"bash": COMMAND, "shell": COMMAND, "powershell": "use powershell", "edit": "edit a file", "multiedit": "edit a file",
                "write": "write a file", "read": "read a file", "webfetch": "fetch a web page",
                "websearch": "search the web", "notebookedit": "edit a notebook"}
LOW_RISK = ("read a file", "search the web")
APK_CACHE = {}

CHANGES = threading.Condition()
VERSIONS = {}
LAST_SYNC = {}
MAINTENANCE = [0]


def now():
    return int(time.time())


def bump(owner):
    with CHANGES:
        VERSIONS[owner] = VERSIONS.get(owner, 0) + 1
        CHANGES.notify_all()


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def password_hash(value, salt):
    return hashlib.scrypt(value.encode(), salt=bytes.fromhex(salt), n=32768, r=8, p=1, maxmem=64 * 1024 * 1024).hex()


def provider_id(value):
    value = re.sub(r"[\s_-]", "", str(value or "").lower())
    return "claude" if value in ("claude", "claudecode") else "codex" if value == "codex" else ""


def issue(db, owner, kind, name=""):
    token = secrets.token_urlsafe(32)
    db.execute("INSERT INTO tickets(token,owner,kind,name,expires,seen) VALUES(?,?,?,?,?,?)",
               (digest(token), owner, kind, name, now() + LIFETIMES[kind], now()))
    return token


def add_log(db, owner, agent, project, event, result, kind="session", detail=""):
    db.execute("INSERT INTO logs(owner,time,agent,project,event,result,kind,detail) VALUES(?,?,?,?,?,?,?,?)",
               (owner, now(), agent[:48], project[:100], event[:100], result[:48], kind, detail[:400]))


def get_prefs(db, owner):
    row = db.execute("SELECT body FROM user_prefs WHERE owner=?", (owner,)).fetchone()
    return {**DEFAULT_PREFS, **(json.loads(row[0]) if row else {})}


def vapid_keys(db):
    rows = dict(db.execute("SELECT key,value FROM settings WHERE key IN ('vapid_private','vapid_public')").fetchall())
    if len(rows) < 2:
        private, public = webpush.generate_keys()
        db.execute("INSERT OR IGNORE INTO settings VALUES('vapid_private',?)", (private,))
        db.execute("INSERT OR IGNORE INTO settings VALUES('vapid_public',?)", (public,))
        db.commit()
        rows = dict(db.execute("SELECT key,value FROM settings WHERE key IN ('vapid_private','vapid_public')").fetchall())
    return rows["vapid_private"], rows["vapid_public"]


def push_owner(owner):
    """Wakes every subscribed browser of an account. Runs in its own thread."""
    time.sleep(0.6)  # let the notice commit before service workers fetch it
    try:
        with closing(sqlite3.connect(RUNTIME["database"], timeout=10)) as db:
            private, public = vapid_keys(db)
            for (endpoint,) in db.execute("SELECT endpoint FROM push_subs WHERE owner=?", (owner,)).fetchall():
                if webpush.send(endpoint, private, public, RUNTIME["subject"]) == "gone":
                    db.execute("DELETE FROM push_subs WHERE endpoint=?", (endpoint,))
            db.commit()
    except sqlite3.Error:
        pass


def notify(db, owner, kind, title, body, url="/#/overview"):
    """Stores a notice for the service worker and wakes the account's devices when the user wants that kind."""
    db.execute("INSERT INTO notices(owner,time,kind,title,body,url) VALUES(?,?,?,?,?,?)",
               (owner, now(), kind, title[:120], body[:240], url))
    db.execute("DELETE FROM notices WHERE owner=? AND id NOT IN (SELECT id FROM notices WHERE owner=? ORDER BY id DESC LIMIT 50)",
               (owner, owner))
    key = PUSH_PREF.get(kind)
    if key is None or get_prefs(db, owner).get(key):
        threading.Thread(target=push_owner, args=(owner,), daemon=True).start()


def answering_device(db, owner):
    """True when someone can answer a request away from the terminal: a phone app polling in the background,
    a device with push notifications, or a portal tab open right now. The agent only routes requests to the
    portal while this holds; otherwise they stay in the terminal without delay."""
    return bool(db.execute("SELECT 1 FROM tickets WHERE owner=? AND kind IN ('device','session') AND seen>? LIMIT 1",
                           (owner, now() - 45)).fetchone()
                or db.execute("SELECT 1 FROM push_subs WHERE owner=? LIMIT 1", (owner,)).fetchone())


def fmt_duration(seconds):
    minutes = int(seconds // 60)
    return f"{minutes // 60}h {minutes % 60:02d}m" if minutes >= 60 else f"{minutes}m"


def build_summary(db, owner, day):
    start = int(time.mktime(day.timetuple()))
    end = start + 86400
    seconds, projects = {"claude": 0.0, "codex": 0.0}, {}
    for row in db.execute("SELECT tool,project,seconds FROM activity WHERE owner=? AND day=?", (owner, day.isoformat())):
        if row[0] in seconds:
            seconds[row[0]] += row[2]
            projects[row[1] or "Unknown project"] = projects.get(row[1] or "Unknown project", 0) + row[2]
    decided = {"allow": 0, "deny": 0, "auto": 0}
    for choice, origin, count in db.execute("SELECT choice,origin,COUNT(*) FROM decisions WHERE owner=? AND created>=? AND created<? "
                                            "GROUP BY choice,origin", (owner, start, end)):
        decided[choice] = decided.get(choice, 0) + count
        if origin == "rule":
            decided["auto"] += count
    count = lambda event: db.execute("SELECT COUNT(*) FROM logs WHERE owner=? AND time>=? AND time<? AND event=?",
                                     (owner, start, end, event)).fetchone()[0]
    peaks = [{"provider": p, "label": l, "percent": round(v)} for p, l, v in db.execute(
        "SELECT provider,label,MAX(percent) FROM quota_samples WHERE owner=? AND time>=? AND time<? GROUP BY provider,label",
        (owner, start, end))]
    total = seconds["claude"] + seconds["codex"]
    projects = {name: value for name, value in projects.items() if value >= 60}
    top = sorted(projects.items(), key=lambda item: item[1], reverse=True)[:5]
    parts = []
    if total >= 60:
        parts.append(f"{fmt_duration(total)} of agent time" +
                     (f" across {len(projects)} project{'s' if len(projects) != 1 else ''}" if projects else ""))
    if decided["allow"] + decided["deny"]:
        parts.append(f"{decided['allow']} allowed, {decided['deny']} blocked")
    headline = " · ".join(parts) if parts else "A quiet day: no agent work recorded."
    return {"day": day.isoformat(), "seconds": seconds, "total": total, "projects": [{"project": p, "seconds": s} for p, s in top],
            "approvals": {**decided, "requested": count("Approval requested")}, "sessionsStarted": count("Session started"),
            "peaks": peaks, "headline": headline, "quiet": total < 60 and not decided["allow"] + decided["deny"]}


def summary_loop():
    while True:
        try:
            with closing(sqlite3.connect(RUNTIME["database"], timeout=10)) as db:
                today, hour = date.today(), time.localtime().tm_hour
                for (owner,) in db.execute("SELECT id FROM users").fetchall():
                    prefs = get_prefs(db, owner)
                    if not prefs["dailySummary"] or hour < prefs["summaryHour"] or db.execute(
                            "SELECT 1 FROM summaries WHERE owner=? AND day=?", (owner, today.isoformat())).fetchone():
                        continue
                    body = build_summary(db, owner, today)
                    if db.execute("INSERT OR IGNORE INTO summaries VALUES(?,?,?,?)",
                                  (owner, today.isoformat(), json.dumps(body), now())).rowcount:
                        add_log(db, owner, "Portal", "", "Daily summary", "Ready", "summary", body["headline"])
                        if not body["quiet"]:
                            notify(db, owner, "summary", "Your day with your agents", body["headline"], "/#/insights")
                    db.commit()
        except sqlite3.Error:
            pass
        time.sleep(60)


def check_quota_alerts(db, owner, quotas):
    threshold = get_prefs(db, owner).get("quotaAlert") or 0
    if not threshold:
        return
    for provider in quotas:
        pid = provider_id(provider.get("id"))
        for limit in provider.get("limits") or []:
            percent = limit.get("percent") if isinstance(limit, dict) else None
            if not pid or not isinstance(percent, (int, float)) or percent < threshold:
                continue
            label = str(limit.get("label") or "limit")
            resets = limit.get("resetsAt") if isinstance(limit.get("resetsAt"), (int, float)) else None
            window = str(round(resets / 3600000)) if resets else date.today().isoformat()
            if not db.execute("INSERT OR IGNORE INTO alerts_sent VALUES(?,?,?)",
                              (owner, f"{pid}|{label}|{threshold}|{window}", now())).rowcount:
                continue
            when = f" Resets in {fmt_duration(max(0, resets / 1000 - time.time()))}." if resets else ""
            add_log(db, owner, NAMES[pid], "", "Usage alert", f"{round(percent)}%", "alert", f"{label} at {round(percent)}%")
            notify(db, owner, "quota", f"{NAMES[pid]} is at {round(percent)}% of its {label.lower()} limit",
                   f"You set alerts at {threshold}%.{when}")


def maintain(db):
    if now() - MAINTENANCE[0] < 3600:
        return
    MAINTENANCE[0] = now()
    db.execute("DELETE FROM alerts_sent WHERE time<?", (now() - 14 * 86400,))
    db.execute("DELETE FROM summaries WHERE created<?", (now() - 120 * 86400,))
    db.execute("DELETE FROM tickets WHERE expires<?", (now(),))
    db.execute("DELETE FROM attempts WHERE until<?", (now(),))
    db.execute("DELETE FROM logs WHERE time<?", (now() - LOG_DAYS * 86400,))
    db.execute("DELETE FROM logs WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER "
               "(PARTITION BY owner ORDER BY id DESC) AS n FROM logs) WHERE n>?)", (LOG_ROWS,))
    db.execute("DELETE FROM quota_samples WHERE time<?", (now() - 35 * 86400,))
    db.execute("DELETE FROM activity WHERE day<?", ((date.today() - timedelta(days=120)).isoformat(),))
    db.execute("DELETE FROM decisions WHERE created<? AND status<>'queued'", (now() - LOG_DAYS * 86400,))


def snapshot(db, owner):
    row = db.execute("SELECT updated,body FROM snapshots WHERE owner=?", (owner,)).fetchone()
    if not row:
        return {"online": False, "state": {}, "sessions": [], "approvals": [], "quotas": [], "github": {}, "now": now()}
    result = json.loads(row["body"])
    result.setdefault("github", {})
    result["updated"] = row["updated"]
    result["now"] = now()
    result["online"] = now() - row["updated"] <= 20
    if not result["online"]:
        result["approvals"] = []
    decided = {row[0] for row in db.execute("SELECT approval FROM decisions WHERE owner=? AND created>?", (owner, now() - 900))}
    waited = set(result.pop("waited", []))
    answered = set(result.pop("answered", []))
    result["approvals"] = [item for item in result["approvals"] if item.get("id") not in decided and item.get("id") not in answered
                           and item.get("resolved") is not True
                           and not answered_elsewhere(item, waited, result["sessions"])]
    return result


def tool_key(value):
    value = str(value or "").strip().lower()
    return TOOL_ALIASES.get(value.replace(" ", ""), value)


def session_of(item, sessions):
    session = str(item.get("session") or "")
    return next((row for row in sessions if session and session in str(row.get("id", ""))), None) if session else None


def answered_elsewhere(item, waited, sessions):
    """A request whose session was seen waiting for permission and no longer is was answered in the terminal.
    On Windows the hook's curl keeps running after Claude Code moves on, so the agent still lists it until it expires."""
    if item.get("id") not in waited:
        return False
    row = session_of(item, sessions)
    return row is None or row.get("agentStatus", row.get("status")) != "waiting"


def rule_matches(rule, item):
    if not rule["enabled"]:
        return False
    if rule["agent"] != "*" and provider_id(item.get("source")) != rule["agent"]:
        return False
    if rule["project"] and rule["project"].lower() != str(item.get("project", "")).lower():
        return False
    if rule["tool"] and tool_key(rule["tool"]) != tool_key(item.get("tool")):
        return False
    command = tool_key(item.get("tool")) in COMMAND_TOOLS
    detail = str(item.get("detail") or "")
    # File requests carry the path on the first line, followed by a preview of the content.
    subject = detail if command else detail.split("\n", 1)[0].strip()
    pattern = rule["pattern"]
    if pattern and pattern == subject:
        return True
    if rule["choice"] == "allow" and command and SHELL_META.search(subject):
        return False
    return not pattern or fnmatch.fnmatchcase(subject, pattern)


def first_rule(db, owner, item):
    rules = db.execute("SELECT * FROM rules WHERE owner=? AND enabled=1 ORDER BY choice='allow', id", (owner,)).fetchall()
    return next((rule for rule in rules if rule_matches(rule, item)), None)


def github_cli(path, body=None):
    if not shutil.which("gh"):
        raise Rejection(503, "GitHub CLI is not installed on this PC.")
    command = ["gh", "api", path]
    if body is not None:
        command += ["--method", "POST", "--input", "-"]
    try:
        result = subprocess.run(command, input=json.dumps(body) if body is not None else None,
                                capture_output=True, encoding="utf-8", timeout=15, check=False,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.TimeoutExpired):
        raise Rejection(503, "Could not reach GitHub.")
    if result.returncode:
        if "HTTP 422" in result.stderr:
            raise Rejection(409, "GitHub rejected the repository name or a repository already exists.")
        if "HTTP 401" in result.stderr or "gh auth login" in result.stderr.lower():
            raise Rejection(401, "Sign in to GitHub CLI on the Windows PC.")
        raise Rejection(502, "GitHub did not accept the request. Check the CLI account and permissions.")
    return json.loads(result.stdout)


def github_repository(item):
    return {"name": item.get("full_name"), "private": item.get("private"),
            "description": item.get("description"), "url": item.get("html_url"),
            "updated": item.get("updated_at"), "language": item.get("language"),
            "stars": item.get("stargazers_count")}


def text(data, key, limit, required=False):
    value = data.get(key, "")
    if not isinstance(value, str):
        raise Rejection(400, "Invalid " + key + ".")
    value = value.strip()
    if len(value) > limit or (required and not value):
        raise Rejection(400, "Invalid " + key + ".")
    return value


class Rejection(Exception):
    def __init__(self, status, detail):
        self.status = status
        self.detail = detail


class Handler(BaseHTTPRequestHandler):
    server_version = "AssistenteIA"
    timeout = 12

    def log_message(self, fmt, *args):
        # Keep temporary credentials and user input out of access logs.
        pass

    def security_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; "
                                                    "base-uri 'none'; form-action 'self'")

    def respond(self, status, body, kind="application/json; charset=utf-8", headers=None):
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.security_headers()
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def reply(self, body, status=200, headers=None):
        self.respond(status, json.dumps(body, ensure_ascii=False).encode(), headers=headers)

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 < length <= 384000:
            raise Rejection(400, "Invalid request size.")
        if self.headers.get_content_type() != "application/json":
            raise Rejection(415, "JSON request required.")
        data = json.loads(self.rfile.read(length))
        if not isinstance(data, dict):
            raise Rejection(400, "Expected a JSON object.")
        return data

    def query(self):
        return {key: values[0] for key, values in parse_qs(urlsplit(self.path).query).items()}

    def cookie(self, token, age):
        secure = "; Secure" if self.server.secure else ""
        return {"Set-Cookie": f"assistente={token}; Path=/; Max-Age={age}; HttpOnly; SameSite=Strict{secure}"}

    def token(self, kind):
        if kind == "session":
            jar = SimpleCookie(self.headers.get("Cookie", ""))
            value = jar.get("assistente")
            return value.value if value else ""
        auth = self.headers.get("Authorization", "")
        return auth[7:] if auth.startswith("Bearer ") else ""

    def authorize(self, db, kind="session"):
        token = self.token(kind)
        row = db.execute("SELECT owner FROM tickets WHERE token=? AND kind=? AND expires>?",
                         (digest(token), kind, now())).fetchone() if token else None
        if row is None:
            raise Rejection(401, "Sign in or reconnect this device.")
        return row["owner"]

    def client(self):
        # Behind a local HTTPS proxy every connection comes from loopback; the proxy names the real client.
        if self.server.behind_proxy:
            forwarded = self.headers.get("X-Forwarded-For", "").split(",")[0].strip()
            if forwarded:
                return forwarded[:64]
        return self.client_address[0]

    def throttle(self, db, category, limit, seconds):
        key = category + ":" + self.client()
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT count,until FROM attempts WHERE key=?", (key,)).fetchone()
        if row and row["until"] > now() and row["count"] >= limit:
            db.rollback()
            raise Rejection(429, "Too many attempts. Try again in a few minutes.")
        count, until = (row["count"] + 1, row["until"]) if row and row["until"] > now() else (1, now() + seconds)
        db.execute("INSERT OR REPLACE INTO attempts VALUES(?,?,?)", (key, count, until))
        db.commit()

    def check_password(self, db, owner, password):
        user = db.execute("SELECT salt,password FROM users WHERE id=?", (owner,)).fetchone()
        if not isinstance(password, str) or not hmac.compare_digest(password_hash(password, user["salt"]), user["password"]):
            raise Rejection(403, "Current password is incorrect.")

    def auth(self, db, path):
        self.throttle(db, path, 15, 300)
        data = self.read_json()
        email = str(data.get("email", "")).strip().lower()
        password = str(data.get("password", ""))
        if len(email) > 254 or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email) or not 10 <= len(password) <= 128:
            raise Rejection(400, "Use a valid email and a password of 10 to 128 characters.")
        if path == "/api/signup":
            name = str(data.get("name", "")).strip()
            if not 1 <= len(name) <= 60:
                raise Rejection(400, "Enter a display name of up to 60 characters.")
            salt = secrets.token_hex(16)
            try:
                owner = db.execute("INSERT INTO users(email,name,salt,password) VALUES(?,?,?,?)",
                                   (email, name, salt, password_hash(password, salt))).lastrowid
            except sqlite3.IntegrityError:
                raise Rejection(409, "Account already exists. Sign in instead.")
        else:
            user = db.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
            candidate = password_hash(password, user["salt"] if user else "00" * 16)
            if not user or not hmac.compare_digest(candidate, user["password"]):
                raise Rejection(401, "Email or password is incorrect.")
            owner = user["id"]
        token = issue(db, owner, "session")
        db.commit()
        self.reply({"ok": True}, headers=self.cookie(token, LIFETIMES["session"]))

    def pair_claim(self, db):
        if not self.server.tls:
            raise Rejection(409, "Tablet pairing requires the HTTPS portal.")
        self.throttle(db, "pair", 35, 300)
        data = self.read_json()
        code = data.get("code", "")
        if not isinstance(code, str) or not re.fullmatch(r"[A-Za-z0-9_-]{40,64}", code):
            raise Rejection(400, "Invalid pairing code.")
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT owner FROM tickets WHERE token=? AND kind='pair' AND expires>?",
                         (digest(code), now())).fetchone()
        if not row:
            raise Rejection(410, "This code expired or was already used.")
        owner = row["owner"]
        db.execute("DELETE FROM tickets WHERE token=?", (digest(code),))
        name = str(data.get("name", "Android device")).strip()[:60] or "Android device"
        device = issue(db, owner, "device", name)
        label = db.execute("SELECT name FROM users WHERE id=?", (owner,)).fetchone()["name"]
        add_log(db, owner, "Mobile", "", "Device paired", "Connected", "device", name)
        db.commit()
        bump(owner)
        self.reply({"token": device, "profile": label, "fingerprint": self.server.pin})

    def record_activity(self, db, owner, sessions):
        current = time.time()
        previous = LAST_SYNC.get(owner)
        LAST_SYNC[owner] = current
        if previous is None or not 0 < current - previous <= 30:
            return
        elapsed = current - previous
        day = date.today().isoformat()
        for row in sessions:
            tool = provider_id(row.get("tool"))
            if row.get("status") == "busy" and tool:
                db.execute("INSERT INTO activity VALUES(?,?,?,?,?) ON CONFLICT(owner,day,tool,project) "
                           "DO UPDATE SET seconds=seconds+excluded.seconds",
                           (owner, day, tool, str(row.get("project") or "")[:100], elapsed))

    def record_quotas(self, db, owner, quotas):
        last = db.execute("SELECT MAX(time) FROM quota_samples WHERE owner=?", (owner,)).fetchone()[0] or 0
        if now() - last < QUOTA_EVERY:
            return
        for provider in quotas:
            pid = provider_id(provider.get("id"))
            for limit in provider.get("limits") or []:
                if pid and isinstance(limit, dict) and isinstance(limit.get("percent"), (int, float)):
                    db.execute("INSERT INTO quota_samples VALUES(?,?,?,?,?)",
                               (owner, now(), pid, str(limit.get("label", ""))[:40], float(limit["percent"])))

    def agent_route(self, db, path):
        owner = self.authorize(db, "agent")
        data = self.read_json()
        if path == "/api/agent/sync":
            old = snapshot(db, owner)
            clean = {key: data.get(key, default) for key, default in
                     (("state", {}), ("sessions", []), ("approvals", []), ("quotas", []), ("github", {}))}
            if not all(isinstance(clean[key], dict) for key in ("state", "github")) or \
                    not all(isinstance(clean[key], list) for key in ("sessions", "approvals", "quotas")):
                raise Rejection(400, "Invalid snapshot.")
            if any(not isinstance(item, dict) for key in ("sessions", "approvals", "quotas") for item in clean[key]):
                raise Rejection(400, "Invalid snapshot entry.")
            for key in ("sessions", "approvals", "quotas"):
                clean[key] = clean[key][:50]
            body = db.execute("SELECT body FROM snapshots WHERE owner=?", (owner,)).fetchone()
            raw = json.loads(body[0]) if body else {}
            previous = set(raw.get("waited", []))
            # Compare with the unfiltered list: answered requests are hidden from snapshot() but still listed by the agent.
            listed_before = {item.get("id") for item in raw.get("approvals", [])}
            clean["waited"] = [item.get("id") for item in clean["approvals"] if item.get("id") in previous or (
                session_of(item, clean["sessions"]) or {}).get("agentStatus") == "waiting"]
            # Once answered in the terminal, a request stays answered even if its session waits again for a new one.
            answered_before = set(raw.get("answered", []))
            clean["answered"] = [item.get("id") for item in clean["approvals"] if item.get("id") in answered_before
                                 or item.get("resolved") is True or answered_elsewhere(item, previous, clean["sessions"])]
            newly_answered = [item for item in clean["approvals"]
                              if item.get("id") in clean["answered"] and item.get("id") not in answered_before]
            db.execute("BEGIN IMMEDIATE")
            maintain(db)
            existing = {item.get("id"): item for item in old.get("sessions", [])}
            old_approvals = listed_before
            if old.get("updated"):
                for row in clean["sessions"]:
                    prior = existing.get(row.get("id"), {})
                    if row.get("status") != prior.get("status") and row.get("status") in ("busy", "waiting", "idle"):
                        event = {"busy": "Session started", "waiting": "Session waiting", "idle": "Session idle"}[row["status"]]
                        add_log(db, owner, str(row.get("tool", "")), str(row.get("project", "")), event, "", "session",
                                str(row.get("waitingFor") or row.get("title") or ""))
                        if prior.get("status") == "busy" and row["status"] == "idle":
                            name = NAMES.get(provider_id(row.get("tool")), "Your agent")
                            notify(db, owner, "finished", f"{row.get('project') or 'A session'} is done",
                                   f"{name} finished and is ready for your next instruction.")
            for item in clean["approvals"]:
                if item.get("kind") != "permission" or item.get("id") in old_approvals or not isinstance(item.get("id"), str):
                    continue
                source, project = str(item.get("source", "")), str(item.get("project", ""))
                detail = str(item.get("tool") or "") + ": " + str(item.get("detail") or item.get("description") or "")
                add_log(db, owner, source, project, "Approval requested", "Waiting", "approval", detail)
                rule = first_rule(db, owner, item)
                if rule and item.get("expiresAt", 0) > now() * 1000:
                    try:
                        db.execute("INSERT INTO decisions(owner,approval,source,choice,created,origin) VALUES(?,?,?,?,?,?)",
                                   (owner, item["id"], source or "Agent", rule["choice"], now(), "rule"))
                    except sqlite3.IntegrityError:
                        continue
                    db.execute("UPDATE rules SET hits=hits+1, last_hit=? WHERE id=?", (now(), rule["id"]))
                    add_log(db, owner, source, project, "Auto-" + ("allowed" if rule["choice"] == "allow" else "denied"),
                            "Rule #" + str(rule["id"]), "rule", detail)
                else:
                    notify(db, owner, "approval", f"{NAMES.get(provider_id(source), source or 'An agent')} needs your approval",
                           (project + ": " if project else "") + detail[:180])
            for item in newly_answered:
                add_log(db, owner, str(item.get("source", "")), str(item.get("project", "")), "Answered in the terminal", "Done",
                        "approval", str(item.get("tool") or "") + ": " + str(item.get("detail") or ""))
            self.record_activity(db, owner, clean["sessions"])
            self.record_quotas(db, owner, clean["quotas"])
            check_quota_alerts(db, owner, clean["quotas"])
            db.execute("INSERT OR REPLACE INTO snapshots VALUES(?,?,?)", (owner, now(), json.dumps(clean)))
            db.execute("UPDATE tickets SET seen=? WHERE token=?", (now(), digest(self.token("agent"))))
            queue = db.execute("SELECT approval,choice FROM decisions WHERE owner=? AND status='queued' AND created>?",
                               (owner, now() - 120)).fetchall()
            answering = answering_device(db, owner)
            db.commit()
            bump(owner)
            self.reply({"decisions": [dict(row) for row in queue], "answering": answering})
        elif path == "/api/agent/result":
            approval, status = data.get("id"), data.get("status")
            if not isinstance(approval, str) or status not in ("sent", "expired", "failed"):
                raise Rejection(400, "Invalid decision receipt.")
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT source,choice,origin FROM decisions WHERE owner=? AND approval=? AND status='queued'",
                             (owner, approval)).fetchone()
            if row:
                db.execute("UPDATE decisions SET status=? WHERE owner=? AND approval=?", (status, owner, approval))
                if row["origin"] == "user":
                    add_log(db, owner, row["source"], "", "Approval " + row["choice"], status, "approval")
            db.commit()
            bump(owner)
            self.reply({"ok": True})

    def decision(self, db, owner):
        data = self.read_json()
        approval, choice = data.get("id"), data.get("choice")
        if not isinstance(approval, str) or choice not in ("allow", "deny"):
            raise Rejection(400, "Invalid decision.")
        allowed = next((row for row in snapshot(db, owner)["approvals"]
                        if row.get("id") == approval and row.get("kind") == "permission"
                        and row.get("expiresAt", 0) > now() * 1000), None)
        if not allowed:
            raise Rejection(410, "This request expired or was already answered.")
        try:
            db.execute("INSERT INTO decisions(owner,approval,source,choice,created) VALUES(?,?,?,?,?)",
                       (owner, approval, str(allowed.get("source", "Agent")), choice, now()))
        except sqlite3.IntegrityError:
            raise Rejection(409, "A decision was already submitted.")
        db.commit()
        bump(owner)
        self.reply({"status": "queued"})

    def recent_logs(self, db, owner):
        rows = db.execute("SELECT id,time,agent,project,event,result FROM logs WHERE owner=? ORDER BY id DESC LIMIT 30", (owner,))
        return [dict(row) for row in rows]

    def list_logs(self, db, owner):
        params = self.query()
        where, args = ["owner=?"], [owner]
        if params.get("before", "").isdigit():
            where.append("id<?")
            args.append(int(params["before"]))
        if params.get("kind") in ("session", "approval", "rule", "device", "alert", "summary"):
            where.append("kind=?")
            args.append(params["kind"])
        agent = params.get("agent")
        if agent in PROVIDERS:
            where.append("(lower(replace(agent,' ','')) IN (?, ?))")
            args += [agent, agent + "code"]
        if params.get("project"):
            where.append("project=?")
            args.append(params["project"][:100])
        if params.get("q"):
            where.append("(event LIKE ? OR project LIKE ? OR detail LIKE ? OR agent LIKE ?)")
            args += ["%" + params["q"][:80] + "%"] * 4
        limit = max(1, min(100, int(params.get("limit", "50") or 50)))
        rows = db.execute("SELECT id,time,agent,project,event,result,kind,detail FROM logs WHERE " + " AND ".join(where) +
                          " ORDER BY id DESC LIMIT ?", (*args, limit + 1)).fetchall()
        projects = [row[0] for row in db.execute(
            "SELECT DISTINCT project FROM logs WHERE owner=? AND project<>'' ORDER BY project LIMIT 200", (owner,))]
        self.reply({"items": [dict(row) for row in rows[:limit]], "more": len(rows) > limit, "projects": projects})

    def delete_logs(self, db, owner):
        event = self.read_json().get("id")
        if event == "all":
            db.execute("DELETE FROM logs WHERE owner=?", (owner,))
        elif isinstance(event, int) or (isinstance(event, str) and event.isdigit()):
            db.execute("DELETE FROM logs WHERE owner=? AND id=?", (owner, int(event)))
        else:
            raise Rejection(400, "Invalid log entry.")
        db.commit()
        self.reply({"ok": True})

    def stats(self, db, owner):
        days = 30 if self.query().get("days") == "30" else 7
        first = date.today() - timedelta(days=days - 1)
        since = int(time.mktime(first.timetuple()))
        daily = {(first + timedelta(days=i)).isoformat(): {"claude": 0, "codex": 0} for i in range(days)}
        projects = {}
        for row in db.execute("SELECT day,tool,project,seconds FROM activity WHERE owner=? AND day>=?", (owner, first.isoformat())):
            if row["day"] in daily and row["tool"] in PROVIDERS:
                daily[row["day"]][row["tool"]] += row["seconds"]
                item = projects.setdefault(row["project"] or "Unknown project", {"claude": 0, "codex": 0})
                item[row["tool"]] += row["seconds"]
        top = sorted(({"project": key, **value} for key, value in projects.items()),
                     key=lambda item: item["claude"] + item["codex"], reverse=True)[:8]
        decisions = {"allow": 0, "deny": 0, "auto": 0}
        for row in db.execute("SELECT choice,origin,COUNT(*) AS n FROM decisions WHERE owner=? AND created>=? GROUP BY choice,origin",
                              (owner, since)):
            decisions[row["choice"]] = decisions.get(row["choice"], 0) + row["n"]
            if row["origin"] == "rule":
                decisions["auto"] += row["n"]
        requested = db.execute("SELECT COUNT(*) FROM logs WHERE owner=? AND time>=? AND event='Approval requested'",
                               (owner, since)).fetchone()[0]
        started = db.execute("SELECT COUNT(*) FROM logs WHERE owner=? AND time>=? AND event='Session started'",
                             (owner, since)).fetchone()[0]
        quota = {}
        for row in db.execute("SELECT time,provider,label,percent FROM quota_samples WHERE owner=? AND time>=? ORDER BY time",
                              (owner, since)):
            quota.setdefault(row["provider"] + "|" + row["label"], []).append([row["time"], row["percent"]])
        self.reply({"days": days, "daily": [{"day": key, **value} for key, value in daily.items()], "projects": top,
                    "approvals": {**decisions, "requested": requested}, "sessionsStarted": started,
                    "quota": [{"provider": key.split("|", 1)[0], "label": key.split("|", 1)[1], "points": value}
                              for key, value in quota.items()]})

    def rule_input(self, data):
        choice = data.get("choice")
        agent = data.get("agent", "*")
        if choice not in ("allow", "deny") or agent not in ("*",) + PROVIDERS:
            raise Rejection(400, "Choose an action and an agent.")
        tool, project, pattern = text(data, "tool", 60), text(data, "project", 100), text(data, "pattern", 1000)
        if choice == "allow" and not tool:
            raise Rejection(400, "Choose what the agent wants to do, such as run a command or edit a file.")
        if choice == "allow" and pattern.strip("*? ") == "" and not project and tool_key(tool) not in LOW_RISK:
            raise Rejection(400, "To allow everything of this kind, limit the rule to one project.")
        return choice, agent, project, tool, pattern

    def download_info(self):
        apk = DOWNLOADS["/downloads/android"][0]
        if not apk.is_file():
            self.reply({"android": None})
            return
        stat = apk.stat()
        key = (stat.st_mtime_ns, stat.st_size)
        if APK_CACHE.get("key") != key:
            APK_CACHE.update(key=key, sha256=hashlib.sha256(apk.read_bytes()).hexdigest())
        url = self.server.download_origin + "/" + apk.name if self.server.download_origin else ""
        reachable = False
        # The published address may be a port mapping (Docker), so the local listener counts too.
        for probe in filter(None, (self.server.download_origin, "http://127.0.0.1:8782")):
            try:
                with urlopen(Request(probe + "/", method="HEAD"), timeout=1.5):
                    reachable = bool(url)
                    break
            except (URLError, TimeoutError, OSError, ValueError):
                continue
        qr = ""
        if url:
            buffer = io.BytesIO()
            qrcode.make(url, image_factory=qrcode.image.svg.SvgPathImage).save(buffer)
            qr = "data:image/svg+xml," + quote(buffer.getvalue().decode())
        self.reply({"android": {"url": url, "qr": qr, "reachable": reachable, "size": stat.st_size,
                                "sha256": APK_CACHE["sha256"], "updated": int(stat.st_mtime)}})

    def rules_route(self, db, owner, path, method):
        if path == "/api/rules" and method == "GET":
            rows = db.execute("SELECT id,choice,agent,project,tool,pattern,enabled,created,hits,last_hit FROM rules "
                              "WHERE owner=? ORDER BY choice='allow', id", (owner,))
            projects = {row[0] for row in db.execute(
                "SELECT DISTINCT project FROM logs WHERE owner=? AND project<>'' LIMIT 200", (owner,))}
            projects |= {str(s.get("project")) for s in snapshot(db, owner).get("sessions", []) if s.get("project")}
            self.reply({"items": [dict(row) for row in rows], "projects": sorted(projects, key=str.lower)})
        elif path == "/api/rules" and method == "POST":
            fields = self.rule_input(self.read_json())
            if db.execute("SELECT COUNT(*) FROM rules WHERE owner=?", (owner,)).fetchone()[0] >= 200:
                raise Rejection(409, "You can keep up to 200 rules.")
            rule = db.execute("INSERT INTO rules(owner,choice,agent,project,tool,pattern,created) VALUES(?,?,?,?,?,?,?)",
                              (owner, *fields, now())).lastrowid
            add_log(db, owner, "Portal", fields[2], "Rule created", "#" + str(rule), "rule",
                    " ".join(filter(None, (fields[0], fields[3], fields[4]))))
            db.commit()
            self.reply({"id": rule}, 201)
        elif path == "/api/rules/update" and method == "POST":
            data = self.read_json()
            if not isinstance(data.get("id"), int) or not isinstance(data.get("enabled"), bool):
                raise Rejection(400, "Invalid rule.")
            db.execute("UPDATE rules SET enabled=? WHERE owner=? AND id=?", (int(data["enabled"]), owner, data["id"]))
            db.commit()
            self.reply({"ok": True})
        elif path == "/api/rules/delete" and method == "POST":
            rule = self.read_json().get("id")
            if not isinstance(rule, int):
                raise Rejection(400, "Invalid rule.")
            db.execute("DELETE FROM rules WHERE owner=? AND id=?", (owner, rule))
            db.commit()
            self.reply({"ok": True})
        elif path == "/api/rules/test" and method == "POST":
            data = self.read_json()
            item = {"source": data.get("agent", ""), "project": text(data, "project", 100), "tool": text(data, "tool", 60),
                    "detail": text(data, "detail", 2000)}
            rule = first_rule(db, owner, item)
            self.reply({"rule": dict(rule) if rule else None})
        else:
            raise Rejection(404, "Page not found.")

    def account_route(self, db, owner, path):
        data = self.read_json()
        current = digest(self.token("session"))
        if path == "/api/account/profile":
            name = text(data, "name", 60, True)
            db.execute("UPDATE users SET name=? WHERE id=?", (name, owner))
            db.commit()
            self.reply({"name": name})
        elif path == "/api/account/password":
            self.throttle(db, "password", 10, 300)
            self.check_password(db, owner, data.get("current"))
            new = data.get("password")
            if not isinstance(new, str) or not 10 <= len(new) <= 128:
                raise Rejection(400, "Use a new password of 10 to 128 characters.")
            salt = secrets.token_hex(16)
            db.execute("UPDATE users SET salt=?, password=? WHERE id=?", (salt, password_hash(new, salt), owner))
            db.execute("DELETE FROM tickets WHERE owner=? AND kind='session' AND token<>?", (owner, current))
            db.commit()
            self.reply({"ok": True})
        elif path == "/api/account/sessions":
            count = db.execute("DELETE FROM tickets WHERE owner=? AND kind='session' AND token<>?", (owner, current)).rowcount
            db.commit()
            self.reply({"signedOut": count})
        elif path == "/api/account/delete":
            self.throttle(db, "password", 10, 300)
            self.check_password(db, owner, data.get("password"))
            db.execute("BEGIN IMMEDIATE")
            for table in OWNED_TABLES:
                db.execute("DELETE FROM " + table + " WHERE owner=?", (owner,))
            db.execute("DELETE FROM users WHERE id=?", (owner,))
            db.commit()
            self.reply({"ok": True}, headers=self.cookie("", 0))
        else:
            raise Rejection(404, "Page not found.")

    def features_route(self, db, owner, path, method):
        if path == "/api/prefs" and method == "GET":
            self.reply(get_prefs(db, owner))
        elif path == "/api/prefs" and method == "POST":
            data, prefs = self.read_json(), get_prefs(db, owner)
            for key, default in DEFAULT_PREFS.items():
                if key not in data:
                    continue
                value = data[key]
                if isinstance(default, bool) and isinstance(value, bool):
                    prefs[key] = value
                elif key == "quotaAlert" and value in (0, 50, 70, 80, 90, 95):
                    prefs[key] = value
                elif key == "summaryHour" and isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 23:
                    prefs[key] = value
                else:
                    raise Rejection(400, "Invalid value for " + key + ".")
            db.execute("INSERT OR REPLACE INTO user_prefs VALUES(?,?)", (owner, json.dumps(prefs)))
            db.commit()
            self.reply(prefs)
        elif path == "/api/push/key" and method == "GET":
            self.reply({"key": vapid_keys(db)[1]})
        elif path in ("/api/push/subscribe", "/api/push/unsubscribe") and method == "POST":
            endpoint = self.read_json().get("endpoint")
            if not webpush.valid_endpoint(endpoint):
                raise Rejection(400, "This browser returned an unsupported push address.")
            if path.endswith("unsubscribe"):
                db.execute("DELETE FROM push_subs WHERE endpoint=? AND owner=?", (endpoint, owner))
            else:
                if db.execute("SELECT COUNT(*) FROM push_subs WHERE owner=?", (owner,)).fetchone()[0] >= 20:
                    raise Rejection(409, "Up to 20 devices can receive notifications. Turn one off first.")
                db.execute("INSERT OR REPLACE INTO push_subs VALUES(?,?,?)", (endpoint, owner, now()))
            db.commit()
            self.reply({"ok": True, "devices": db.execute("SELECT COUNT(*) FROM push_subs WHERE owner=?", (owner,)).fetchone()[0]})
        elif path == "/api/push/test" and method == "POST":
            self.read_json()
            if not db.execute("SELECT 1 FROM push_subs WHERE owner=?", (owner,)).fetchone():
                raise Rejection(409, "No device has notifications turned on yet.")
            notify(db, owner, "test", "Notifications are working", "This is how Assistente IA will reach you.")
            db.commit()
            self.reply({"ok": True})
        elif path == "/api/notices" and method == "GET":
            rows = db.execute("SELECT id,time,kind,title,body,url FROM notices WHERE owner=? AND time>? ORDER BY id DESC LIMIT 3",
                              (owner, now() - 600))
            self.reply({"items": [dict(row) for row in rows]})
        elif path == "/api/summaries" and method == "GET":
            rows = db.execute("SELECT body FROM summaries WHERE owner=? ORDER BY day DESC LIMIT 14", (owner,))
            self.reply({"items": [json.loads(row[0]) for row in rows]})
        elif path == "/api/summaries/now" and method == "POST":
            self.read_json()
            self.reply(build_summary(db, owner, date.today()))
        elif path == "/api/remote" and method == "GET":
            origin = self.server.public_origin
            qr = ""
            if origin:
                buffer = io.BytesIO()
                qrcode.make(origin, image_factory=qrcode.image.svg.SvgPathImage).save(buffer)
                qr = "data:image/svg+xml," + quote(buffer.getvalue().decode())
            self.reply({"origin": origin, "qr": qr, "secure": self.server.secure})
        else:
            raise Rejection(404, "Page not found.")

    def events(self, db, owner):
        db.close()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("X-Accel-Buffering", "no")
        self.security_headers()
        self.end_headers()
        self.close_connection = True
        self.wfile.write(b"retry: 3000\n\n")
        sent, version, last_write, last_seen = None, -1, 0, 0
        while True:
            with CHANGES:
                if VERSIONS.get(owner, 0) == version:
                    # The HTTPS listener runs in another process, so changes also arrive by re-reading the database.
                    CHANGES.wait(2.5)
                version = VERSIONS.get(owner, 0)
            with closing(sqlite3.connect(self.server.database, timeout=10)) as conn:
                conn.row_factory = sqlite3.Row
                try:
                    self.authorize(conn)
                except Rejection:
                    self.wfile.write(b"event: signout\ndata: {}\n\n")
                    return
                if time.time() - last_seen > 15:
                    # An open portal tab can answer requests, so it counts as an answering device.
                    conn.execute("UPDATE tickets SET seen=? WHERE token=?", (now(), digest(self.token("session"))))
                    conn.commit()
                    last_seen = time.time()
                data = snapshot(conn, owner)
            body = json.dumps({key: value for key, value in data.items() if key != "now"}, ensure_ascii=False)
            if body != sent:
                data_line = json.dumps(data, ensure_ascii=False)
                self.wfile.write(("event: dashboard\ndata: " + data_line + "\n\n").encode())
                sent, last_write = body, time.time()
            elif time.time() - last_write > 15:
                self.wfile.write(b": keepalive\n\n")
                last_write = time.time()
            self.wfile.flush()

    def private_route(self, db, path, method):
        owner = self.authorize(db)
        if path == "/api/me" and method == "GET":
            user = dict(db.execute("SELECT name,email FROM users WHERE id=?", (owner,)).fetchone())
            linked = bool(db.execute("SELECT 1 FROM local_binding WHERE owner=?", (owner,)).fetchone())
            self.reply({**user, "localAgent": bool(self.server.local_agent), "localLinked": linked,
                        "pairing": bool(self.server.pair_origin), "version": APP_VERSION,
                        "publicOrigin": self.server.public_origin, "secure": self.server.secure})
        elif path == "/api/downloads/info" and method == "GET":
            self.download_info()
        elif path == "/api/dashboard" and method == "GET":
            self.reply(snapshot(db, owner))
        elif path == "/api/events" and method == "GET":
            self.events(db, owner)
        elif path == "/api/logout" and method == "POST":
            db.execute("DELETE FROM tickets WHERE token=?", (digest(self.token("session")),))
            db.commit()
            self.reply({"ok": True}, headers=self.cookie("", 0))
        elif path == "/api/logs" and method == "GET":
            self.list_logs(db, owner)
        elif path == "/api/logs/delete" and method == "POST":
            self.delete_logs(db, owner)
        elif path == "/api/stats" and method == "GET":
            self.stats(db, owner)
        elif path.startswith("/api/rules"):
            self.rules_route(db, owner, path, method)
        elif path.startswith("/api/account/") and method == "POST":
            self.account_route(db, owner, path)
        elif path.startswith(("/api/prefs", "/api/push/", "/api/notices", "/api/summaries", "/api/remote")):
            self.features_route(db, owner, path, method)
        elif path == "/api/devices" and method == "GET":
            rows = db.execute("SELECT token AS id, name, kind, seen FROM tickets WHERE owner=? AND kind IN ('agent','device') AND expires>?",
                              (owner, now()))
            self.reply({"items": [dict(row) for row in rows], "now": now()})
        elif path == "/api/devices/revoke" and method == "POST":
            device = self.read_json().get("id")
            if not isinstance(device, str):
                raise Rejection(400, "Invalid device.")
            db.execute("BEGIN IMMEDIATE")
            ticket = db.execute("SELECT kind,name FROM tickets WHERE owner=? AND token=?", (owner, device)).fetchone()
            db.execute("DELETE FROM local_binding WHERE owner=? AND device=?", (owner, device))
            db.execute("DELETE FROM tickets WHERE owner=? AND token=? AND kind IN ('agent','device')", (owner, device))
            if ticket and ticket["kind"] == "agent":
                db.execute("DELETE FROM snapshots WHERE owner=?", (owner,))
                db.execute("DELETE FROM decisions WHERE owner=? AND status='queued'", (owner,))
            if ticket:
                add_log(db, owner, "Portal", "", "Device disconnected", "Revoked", "device", ticket["name"])
            db.commit()
            bump(owner)
            self.reply({"ok": True})
        elif path == "/api/connect/local" and method == "POST":
            if not self.server.local_agent:
                raise Rejection(404, "Open the portal on the Windows PC with the local agent.")
            self.read_json()
            db.execute("BEGIN IMMEDIATE")
            local = db.execute("SELECT owner FROM local_binding WHERE slot=1").fetchone()
            if local and local["owner"] != owner:
                raise Rejection(409, "This PC is already linked to another portal account.")
            if not local:
                db.execute("DELETE FROM tickets WHERE owner=? AND kind='agent'", (owner,))
                db.execute("DELETE FROM snapshots WHERE owner=?", (owner,))
                db.execute("DELETE FROM decisions WHERE owner=? AND status='queued'", (owner,))
                db.execute("INSERT INTO local_binding VALUES(1,?,?)", (owner, ""))
                add_log(db, owner, "Portal", "", "Device paired", "This PC", "device", "Local desktop agent")
            db.commit()
            self.reply({"ok": True})
        elif path == "/api/connect/agent" and method == "POST":
            data = self.read_json()
            name = str(data.get("name", "Desktop agent")).strip()[:60] or "Desktop agent"
            db.execute("DELETE FROM local_binding WHERE owner=?", (owner,))
            db.execute("DELETE FROM tickets WHERE owner=? AND kind='agent'", (owner,))
            db.execute("DELETE FROM snapshots WHERE owner=?", (owner,))
            db.execute("DELETE FROM decisions WHERE owner=? AND status='queued'", (owner,))
            token = issue(db, owner, "agent", name)
            db.commit()
            self.reply({"token": token, "origin": self.server.public_origin or self.server.origin,
                        "fingerprint": "" if self.server.public_origin else self.server.pin})
        elif path == "/api/connect/tablet" and method == "POST":
            if not self.server.pair_origin:
                raise Rejection(409, "Mobile pairing needs an HTTPS listener. See the setup guide.")
            db.execute("DELETE FROM tickets WHERE owner=? AND kind='pair'", (owner,))
            token = issue(db, owner, "pair")
            db.commit()
            name = db.execute("SELECT name FROM users WHERE id=?", (owner,)).fetchone()["name"]
            link = "assistenteia://pair?" + urlencode({"url": self.server.pair_origin, "pin": self.server.pair_pin, "code": token, "profile": name})
            image = qrcode.make(link, image_factory=qrcode.image.svg.SvgPathImage)
            buffer = io.BytesIO()
            image.save(buffer)
            self.reply({"qr": "data:image/svg+xml," + quote(buffer.getvalue().decode()),
                        "expires": now() + LIFETIMES["pair"], "profile": name, "link": link})
        elif path == "/api/approval" and method == "POST":
            self.decision(db, owner)
        elif path in ("/api/github/account", "/api/github/repos", "/api/github/repos/create"):
            if not self.server.local_agent or not db.execute(
                    "SELECT 1 FROM local_binding WHERE owner=?", (owner,)).fetchone():
                raise Rejection(403, "Link this Windows PC to your account to use its GitHub CLI session.")
            if path == "/api/github/account" and method == "GET":
                self.reply({"login": github_cli("user").get("login")})
            elif path == "/api/github/repos" and method == "GET":
                page = max(1, min(500, int(self.query().get("page", "1") or 1)))
                data = github_cli("user/repos?sort=updated&per_page=30&page=" + str(page))
                self.reply({"items": [github_repository(item) for item in data], "page": page, "more": len(data) == 30})
            elif path == "/api/github/repos/create" and method == "POST":
                data = self.read_json()
                name = str(data.get("name", "")).strip()
                description = str(data.get("description", "")).strip()
                private = data.get("private", True)
                if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,99}", name) or len(description) > 350 or not isinstance(private, bool):
                    raise Rejection(400, "Enter a valid repository name and description.")
                created = github_cli("user/repos", {"name": name, "description": description, "private": private})
                self.reply({"repository": github_repository(created)}, 201)
            else:
                raise Rejection(405, "Method not allowed.")
        else:
            raise Rejection(404, "Page not found.")

    def static(self, path):
        if path == "/" or not path.startswith("/api/") and "." not in path.rsplit("/", 1)[-1]:
            path = "/index.html"
        file = (PUBLIC / path.lstrip("/")).resolve()
        if PUBLIC.resolve() not in file.parents or any(part.startswith(".") for part in file.relative_to(PUBLIC.resolve()).parts):
            return False
        kind = STATIC_TYPES.get(file.suffix.lower())
        if not kind or not file.is_file():
            return False
        self.respond(200, file.read_bytes(), kind)
        return True

    def dispatch(self, method):
        path = urlsplit(self.path).path
        hosts = {urlsplit(self.server.origin).netloc.lower()}
        if self.server.behind_proxy:
            hosts.add(f"127.0.0.1:{self.server.server_address[1]}")
        if self.headers.get("Host", "").lower() not in hosts:
            raise Rejection(421, "Open the configured portal address.")
        if method == "POST" and self.headers.get("Origin") not in (None, self.server.origin):
            raise Rejection(403, "Invalid request origin.")
        if method == "GET" and not path.startswith(("/api/", "/downloads/")):
            if not self.static(path):
                raise Rejection(404, "File not found.")
            return
        with closing(sqlite3.connect(self.server.database, timeout=10)) as db:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA foreign_keys=ON")
            if method == "POST" and path in ("/api/login", "/api/signup"):
                self.auth(db, path)
            elif method == "POST" and path == "/api/pair/claim":
                self.pair_claim(db)
            elif method == "POST" and path in ("/api/agent/sync", "/api/agent/result"):
                self.agent_route(db, path)
            elif method == "GET" and path in DOWNLOADS:
                self.authorize(db)
                file, kind = DOWNLOADS[path]
                if not file.is_file():
                    raise Rejection(404, "This download is not available yet.")
                with file.open("rb") as content:
                    self.send_response(200)
                    self.send_header("Content-Type", kind)
                    self.send_header("Content-Disposition", 'attachment; filename="' + file.name + '"')
                    self.send_header("Content-Length", str(file.stat().st_size))
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("X-Content-Type-Options", "nosniff")
                    self.end_headers()
                    shutil.copyfileobj(content, self.wfile)
            elif path.startswith("/api/tablet/"):
                owner = self.authorize(db, "device")
                if method == "GET" and path == "/api/tablet/dashboard":
                    data = snapshot(db, owner)
                    data["profile"] = db.execute("SELECT name FROM users WHERE id=?", (owner,)).fetchone()["name"]
                    data["logs"] = self.recent_logs(db, owner)
                    db.execute("UPDATE tickets SET seen=? WHERE token=?", (now(), digest(self.token("device"))))
                    db.commit()
                    self.reply(data)
                elif method == "GET" and path == "/api/tablet/pending":
                    # Small, frequent poll for the app's background service: open requests and recent notices only.
                    data = snapshot(db, owner)
                    approvals = [{key: item.get(key) for key in ("id", "source", "project", "tool", "detail", "expiresAt", "decision")}
                                 for item in data["approvals"] if item.get("kind") == "permission"]
                    notices = db.execute("SELECT id,time,kind,title,body FROM notices WHERE owner=? AND kind<>'approval' "
                                         "AND time>? ORDER BY id DESC LIMIT 5", (owner, now() - 900)).fetchall()
                    prefs = get_prefs(db, owner)
                    db.execute("UPDATE tickets SET seen=? WHERE token=?", (now(), digest(self.token("device"))))
                    db.commit()
                    self.reply({"online": data["online"], "approvals": approvals, "notices": [dict(row) for row in notices],
                                "prefs": {key: prefs[key] for key in ("pushApprovals", "pushFinished", "pushQuota", "pushSummary")},
                                "now": now()})
                elif method == "POST" and path == "/api/tablet/approval":
                    self.decision(db, owner)
                elif method == "POST" and path == "/api/tablet/logs/delete":
                    self.delete_logs(db, owner)
                else:
                    raise Rejection(404, "Page not found.")
            else:
                self.private_route(db, path, method)

    def handle_method(self, method):
        try:
            if method == "POST" and self.headers.get("Sec-Fetch-Site") not in (None, "same-origin", "none"):
                raise Rejection(403, "Invalid request origin.")
            self.dispatch(method)
        except Rejection as e:
            self.reply({"error": e.detail}, e.status)
        except (ValueError, TypeError, json.JSONDecodeError):
            self.reply({"error": "Invalid request."}, 400)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, TimeoutError):
            pass

    def do_GET(self):
        self.handle_method("GET")

    def do_POST(self):
        self.handle_method("POST")


def relay_local(server):
    token, previous, delivered, answering = "", "", {}, False
    agent = f"http://127.0.0.1:{server.local_agent}"
    while True:
        try:
            with closing(sqlite3.connect(server.database, timeout=10)) as db:
                db.execute("BEGIN IMMEDIATE")
                binding = db.execute("SELECT owner,device FROM local_binding WHERE slot=1").fetchone()
                if not binding:
                    token, previous, delivered = "", "", {}
                elif not token or previous != binding[1]:
                    owner, old_device = binding
                    db.execute("DELETE FROM tickets WHERE owner=? AND token=?", (owner, old_device))
                    token = issue(db, owner, "agent", "This Windows PC")
                    previous, delivered = digest(token), {}
                    db.execute("UPDATE local_binding SET device=? WHERE slot=1", (previous,))
                db.commit()
            if token:
                snapshot_data = connector.collect(agent, answering)
                host = snapshot_data["state"].get("host")
                if isinstance(host, str) and host:
                    with closing(sqlite3.connect(server.database, timeout=10)) as db:
                        db.execute("UPDATE tickets SET name=? WHERE token=? AND name<>?", (host[:60], previous, host[:60]))
                        db.commit()
                result = connector.request(server.origin, "/api/agent/sync", token, snapshot_data)
                answering = bool(result.get("answering"))
                connector.deliver(agent, server.origin, token, result.get("decisions", []), delivered)
        except (sqlite3.Error, URLError, TimeoutError, ValueError, OSError):
            pass
        time.sleep(2)


def migrate(db):
    db.executescript(SCHEMA)
    for table, column, statement, backfill in MIGRATIONS:
        if column not in {row[1] for row in db.execute("PRAGMA table_info(" + table + ")")}:
            db.execute(statement)
            if backfill:
                db.executescript(backfill)
    db.execute("CREATE INDEX IF NOT EXISTS logs_owner ON logs(owner, id)")
    db.execute("PRAGMA journal_mode=WAL")
    db.commit()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8780)
    parser.add_argument("--origin")
    parser.add_argument("--database", type=Path, default=ROOT / "data" / "portal.sqlite3")
    parser.add_argument("--cert", type=Path)
    parser.add_argument("--key", type=Path)
    parser.add_argument("--pair-origin")
    parser.add_argument("--pair-cert", type=Path)
    parser.add_argument("--local-agent-port", type=int)
    parser.add_argument("--download-origin", help="Address of lan_download.py, e.g. http://192.168.1.20:8782 "
                                                  "(defaults to the pairing host on port 8782)")
    parser.add_argument("--behind-proxy", action="store_true",
                        help="Serve HTTP on loopback for a local HTTPS proxy such as 'tailscale serve'; requires an https --origin")
    parser.add_argument("--public-origin", help="HTTPS address for use away from home (for example a Tailscale name)")
    args = parser.parse_args()
    if bool(args.cert) != bool(args.key) or (args.host not in ("127.0.0.1", "localhost") and not args.cert):
        parser.error("Network access requires a TLS certificate and key.")
    if args.behind_proxy and (args.cert or args.host not in ("127.0.0.1", "localhost") or not args.origin or args.local_agent_port):
        parser.error("--behind-proxy needs a loopback host, an https --origin and no certificate or local agent.")
    scheme = "https" if args.cert or args.behind_proxy else "http"
    origin = args.origin or f"{scheme}://{args.host}:{args.port}"
    site = urlsplit(origin)
    if site.scheme != scheme or not site.hostname or site.path or site.query or site.fragment or site.username:
        parser.error("Origin must be the exact browser origin with the correct scheme.")
    if args.local_agent_port and (args.host not in ("127.0.0.1", "localhost") or args.cert
                                  or not 1 <= args.local_agent_port <= 65535):
        parser.error("Local agent linking is available only on the loopback portal.")
    if bool(args.pair_origin) != bool(args.pair_cert):
        parser.error("Pairing origin and certificate must be specified together.")
    if args.pair_origin:
        pair_site = urlsplit(args.pair_origin)
        if pair_site.scheme != "https" or not pair_site.hostname or pair_site.path or pair_site.query or pair_site.fragment or pair_site.username:
            parser.error("Pairing origin must be an exact HTTPS origin.")
    args.database.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(args.database)) as db:
        migrate(db)
    ThreadingHTTPServer.request_queue_size = 64
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    server.database, server.origin, server.tls, server.pin = str(args.database), origin, bool(args.cert), ""
    server.behind_proxy, server.secure = args.behind_proxy, bool(args.cert or args.behind_proxy)
    public = args.public_origin or (origin if args.behind_proxy else "")
    if public and (urlsplit(public).scheme != "https" or not urlsplit(public).hostname or urlsplit(public).path.strip("/")):
        parser.error("Public origin must be an HTTPS origin.")
    server.public_origin = public.rstrip("/")
    RUNTIME["database"] = str(args.database)
    if public:
        RUNTIME["subject"] = server.public_origin

    def certificate_pin(path):
        certificate = path.read_text()
        first = certificate.split("-----END CERTIFICATE-----", 1)[0] + "-----END CERTIFICATE-----"
        return hashlib.sha256(ssl.PEM_cert_to_DER_cert(first)).hexdigest()
    if args.cert:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        # KitKat supports TLS 1.2 with ECDHE, but its platform provider may offer only CBC suites.
        context.set_ciphers("ECDHE+AESGCM:ECDHE+CHACHA20:ECDHE-RSA-AES128-SHA256:ECDHE-RSA-AES128-SHA")
        context.load_cert_chain(args.cert, args.key)
        server.pin = certificate_pin(args.cert)
        server.socket = context.wrap_socket(server.socket, server_side=True)
    server.pair_origin = args.pair_origin or (origin if args.cert else "")
    server.pair_pin = certificate_pin(args.pair_cert) if args.pair_cert else server.pin
    server.local_agent = args.local_agent_port
    download = args.download_origin or (f"http://{urlsplit(server.pair_origin).hostname}:8782" if server.pair_origin else "")
    if download:
        site = urlsplit(download)
        if site.scheme not in ("http", "https") or not site.hostname or site.path.strip("/") or site.query or site.username:
            parser.error("Download origin must be an origin such as http://192.168.1.20:8782.")
    server.download_origin = download.rstrip("/")
    if server.local_agent:
        threading.Thread(target=relay_local, args=(server,), daemon=True).start()
    threading.Thread(target=summary_loop, daemon=True).start()
    print("Assistente IA:", origin, flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
