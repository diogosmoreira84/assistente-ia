"""Relay a local PhoneBox agent to the authenticated Assistente IA portal."""
import argparse
import getpass
import hashlib
import http.client
import ssl
import json
import os
import re
import time
from datetime import datetime
from pathlib import Path, PureWindowsPath
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

HISTORY_AGE = 7 * 86400
_history_files = {}
_history_rows = {}


# The agent sends permission prompts to a phone only while one polls /api/state with this header. The portal relays
# prompts, so the connector presents itself that way while the portal reports a device that can answer. The value is
# a version above any PhoneBox app release, so the agent never offers that "phone" an app update.
PHONE_HEADER = {"X-PhoneBox-App": "999.0.0"}


PINS = {}


class PinnedHTTPS(http.client.HTTPSConnection):
    """HTTPS to a portal with a self-signed certificate: accepted only when its SHA-256 matches the expected pin."""
    def __init__(self, host, pin, **kwargs):
        context = ssl.create_default_context()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        super().__init__(host, context=context, **kwargs)
        self.pin = pin

    def connect(self):
        super().connect()
        der = self.sock.getpeercert(binary_form=True)
        if not der or hashlib.sha256(der).hexdigest() != self.pin:
            self.close()
            raise ssl.SSLError("The portal certificate does not match the fingerprint.")


def request(origin, path, token="", body=None, extra=None):
    headers = {"Accept": "application/json", **(extra or {})}
    if token:
        headers["Authorization"] = "Bearer " + token
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    pin = PINS.get(origin)
    if pin:
        connection = PinnedHTTPS(urlsplit(origin).netloc, pin, timeout=5)
        try:
            connection.request("POST" if data is not None else "GET", path, body=data, headers={**headers, "Origin": origin})
            response = connection.getresponse()
            raw = response.read(400000)
            if response.status >= 400:
                raise HTTPError(origin + path, response.status, response.reason, response.headers, None)
            return json.loads(raw) if raw else {}
        except (OSError, http.client.HTTPException) as error:
            if isinstance(error, HTTPError):
                raise
            raise URLError(error)
        finally:
            connection.close()
    with urlopen(Request(origin + path, data=data, headers=headers), timeout=5) as response:
        raw = response.read(400000)
        return json.loads(raw) if raw else {}


def session_status(session, now_ms):
    if session.get("tool") != "codex" or session.get("status") != "idle":
        return session
    if session.get("outcome") or not session.get("turnStartedAt"):
        return session
    age = now_ms - max(session["turnStartedAt"], session.get("since") or 0)
    return {**session, "status": "busy" if -30000 <= age <= 180000 else "unknown"}


def fields(item, keys):
    return {key: item[key] for key in keys if key in item}


def records(raw):
    for line in raw.splitlines():
        try:
            item = json.loads(line)
        except (ValueError, UnicodeError):
            continue
        if isinstance(item, dict):
            yield item


def history_session(path, provider, modified):
    try:
        with path.open("rb") as file:
            head = list(records(file.read(131072)))
            size = file.seek(0, 2)
            file.seek(max(0, size - 393216))
            if size > 393216:
                file.readline(393216)
            tail = list(records(file.read(393216)))
    except OSError:
        return None

    lifecycle = None
    if provider == "codex":
        meta = next((item.get("payload") for item in head if item.get("type") == "session_meta"), None)
        if not isinstance(meta, dict):
            return None
        directory = meta.get("cwd")
        model = None
        for event in tail:
            payload = event.get("payload")
            if not isinstance(payload, dict):
                continue
            if event.get("type") == "turn_context":
                model = payload.get("model") or model
            elif event.get("type") == "event_msg" and payload.get("type") in ("task_started", "task_complete", "turn_aborted"):
                lifecycle = payload["type"]
        session_id = "codex:" + path.name
    else:
        directory = next((event["cwd"] for event in head + tail if isinstance(event.get("cwd"), str)), None)
        if not directory:
            return None
        model = next((event["message"].get("model") for event in reversed(tail)
                      if event.get("type") == "assistant" and isinstance(event.get("message"), dict)
                      and event["message"].get("model")), None)
        session_id = "claude:" + path.stem

    modified_age = time.time() - modified
    if provider == "codex" and lifecycle == "task_started":
        status = "busy" if 0 <= modified_age <= 180 else "unknown"
    elif provider == "codex" and lifecycle is None:
        status = "unknown"
    else:
        status = "idle"
    project = PureWindowsPath(directory.rstrip("/\\")).name if isinstance(directory, str) else ""
    return {"id": session_id, "tool": provider, "project": project[:100],
            "model": model if isinstance(model, str) else None, "status": status,
            "lastActive": int(modified * 1000)}


def recent_sessions():
    current = time.time()
    sources = (
        ("codex", Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex") / "sessions", "rollout-*.jsonl"),
        ("claude", Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude") / "projects", "*.jsonl"),
    )
    result = []
    for provider, directory, glob in sources:
        seen, files = _history_files.get(provider, (0, []))
        if current - seen >= 30:
            candidates = []
            try:
                for path in directory.rglob(glob):
                    if provider == "claude" and (path.parent.parent != directory or "subagents" in path.parts):
                        continue
                    try:
                        modified = path.stat().st_mtime
                    except OSError:
                        continue
                    if current - modified <= HISTORY_AGE:
                        candidates.append((modified, path))
            except OSError:
                pass
            files = [file for _, file in sorted(candidates, reverse=True)[:12]]
            _history_files[provider] = (current, files)
        for file in files:
            try:
                stat = file.stat()
            except OSError:
                continue
            key = (str(file), stat.st_mtime_ns, stat.st_size, provider,
                   current - stat.st_mtime <= 180)
            if key not in _history_rows:
                if len(_history_rows) >= 80:
                    _history_rows.clear()
                _history_rows[key] = history_session(file, provider, stat.st_mtime)
            if _history_rows[key]:
                result.append(_history_rows[key])
    return result


_transcripts = {}
TOOL_KEYS = {"Run a command": ("command",), "Use PowerShell": ("command",), "Edit a file": ("file_path",), "Write a file": ("file_path",),
             "Read a file": ("file_path",), "Edit a notebook": ("notebook_path",), "Fetch a web page": ("url",),
             "Search the web": ("query",)}


def _timestamp(value):
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp() * 1000
    except ValueError:
        return 0


def answered_in_terminal(approval):
    """True when Claude Code already recorded a result for the tool this request is about.

    Answering in the terminal does not end the hook's curl process on Windows, so the agent keeps listing the request.
    The session transcript is the reliable signal: the tool's result is written as soon as it is allowed or denied.
    """
    session, created = str(approval.get("session") or ""), approval.get("createdAt") or 0
    if "claude" not in str(approval.get("source", "")).lower() or not re.fullmatch(r"[A-Za-z0-9-]{8,80}", session) or not created:
        return False
    path = _transcripts.get(session)
    if path is None or not path.exists():
        root = Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude") / "projects"
        path = next(root.glob("*/" + session + ".jsonl"), None)
        if path is None:
            return False
        _transcripts[session] = path
    try:
        if path.stat().st_mtime * 1000 < created:
            return False
        with path.open("rb") as file:
            size = file.seek(0, 2)
            file.seek(max(0, size - 524288))
            tail = list(records(file.read()))
    except OSError:
        return False
    keys = TOOL_KEYS.get(str(approval.get("tool")))
    detail = str(approval.get("detail") or "")
    if not keys:
        return False
    wanted = detail if keys == ("command",) else detail.split(chr(10), 1)[0].strip()
    use_id = None
    for item in tail:
        message = item.get("message") if isinstance(item.get("message"), dict) else {}
        content = message.get("content") if isinstance(message.get("content"), list) else []
        for part in content:
            if not isinstance(part, dict):
                continue
            if item.get("type") == "assistant" and part.get("type") == "tool_use" and isinstance(part.get("input"), dict):
                if any(str(part["input"].get(key, "")).strip() == wanted.strip() for key in keys):
                    use_id = part.get("id")
            elif item.get("type") == "user" and part.get("type") == "tool_result" and use_id and part.get("tool_use_id") == use_id:
                if _timestamp(item.get("timestamp")) >= created - 2000:
                    return True
    return False


def collect(origin, answering=False):
    current = request(origin, "/api/state", extra=PHONE_HEADER if answering else None)
    work = request(origin, "/api/work")
    quotas = request(origin, "/api/quotas")
    approvals = request(origin, "/api/approvals")
    approvals = [fields(item, ("id", "source", "session", "project", "tool", "detail", "description", "createdAt", "expiresAt", "kind"))
                 for item in approvals.get("items", []) if item.get("kind") == "permission"]
    for item in approvals:
        # Tools without a friendly summary arrive as their JSON input; show the command or path instead.
        detail = str(item.get("detail") or "")
        if detail.lstrip().startswith("{"):
            try:
                data = json.loads(detail)
            except ValueError:
                data = None
            if isinstance(data, dict):
                summary = next((data[key] for key in ("command", "file_path", "notebook_path", "url", "query", "pattern")
                                if isinstance(data.get(key), str)), None)
                if summary:
                    item["detail"] = summary
        if answered_in_terminal(item):
            item["resolved"] = True
    sessions = []
    for candidate in work.get("sessions", [])[:50]:
        if candidate.get("tool") not in ("claude", "codex"):
            continue
        item = session_status(candidate, int(time.time() * 1000))
        raw = item.get("status")
        # A pending request makes the session show as waiting, unless the agent already sees it working again: then
        # the request was answered in the terminal and only the hook process is still lingering.
        if raw != "busy" and any(a.get("session") and a["session"] in str(item.get("id", "")) for a in approvals):
            item = {**item, "status": "waiting"}
        row = fields(item, SESSION_FIELDS)
        row["agentStatus"] = raw
        if isinstance(item.get("since"), (int, float)):
            row["lastActive"] = item["since"]
        sessions.append(row)
    existing = {item["id"] for item in sessions if item.get("id")}
    for item in recent_sessions():
        if item["id"] not in existing:
            if any(a.get("session") and a["session"] in item["id"] for a in approvals):
                item = {**item, "status": "waiting"}
            sessions.append(item)
    github = work.get("github") if isinstance(work.get("github"), dict) else {}
    pull = ("repo", "number", "title", "author", "draft", "review", "ci", "updated")
    github = {"user": github.get("user"), "notifications": github.get("notifications") or 0,
              "reviewRequests": [fields(pr, pull) for pr in (github.get("reviewRequests") or [])[:20] if isinstance(pr, dict)],
              "myPrs": [fields(pr, pull) for pr in (github.get("myPrs") or [])[:20] if isinstance(pr, dict)],
              "updatedAt": github.get("updatedAt"), "error": github.get("error")} if github else {}
    return {"state": {"host": current.get("host"), "os": current.get("os"),
                      "pc": fields(current.get("pc") or {}, ("cpu", "cpuName", "cpuTemp", "ramTotalGb", "ramUsedGb"))},
            "sessions": sessions, "quotas": quotas.get("providers", []), "approvals": approvals, "github": github}


SESSION_FIELDS = ("id", "tool", "project", "name", "title", "model", "effort", "status", "waitingFor", "startedAt",
                  "totalTokens", "inputTokens", "outputTokens", "cachedInputTokens", "lastInputTokens", "contextWindow",
                  "lastTool")


def deliver(agent, portal, key, decisions, delivered):
    for item in decisions:
        approval, choice = item.get("approval", ""), item.get("choice")
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", approval) or choice not in ("allow", "deny"):
            continue
        status = delivered.get(approval)
        if not status:
            try:
                request(agent, "/api/approvals/" + approval + "?" + urlencode({"decision": choice}), body={})
                status = "sent"
            except HTTPError as error:
                status = "expired" if error.code == 404 else "failed"
            except (TimeoutError, URLError):
                continue
            delivered[approval] = status
        request(portal, "/api/agent/result", key, {"id": approval, "status": status})
        delivered.pop(approval, None)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--portal", default="http://127.0.0.1:8780")
    parser.add_argument("--agent-port", type=int, default=8765)
    parser.add_argument("--once", action="store_true", help="Send one snapshot and exit")
    parser.add_argument("--fingerprint", help="SHA-256 of a portal's self-signed certificate (shown in Devices)")
    args = parser.parse_args()
    portal = args.portal.rstrip("/")
    if args.fingerprint:
        pin = args.fingerprint.replace(":", "").strip().lower()
        if not re.fullmatch(r"[0-9a-f]{64}", pin):
            parser.error("The fingerprint must be 64 hexadecimal characters.")
        PINS[portal] = pin
    url = urlsplit(portal)
    if (not url.hostname or url.path or url.query or url.fragment or url.username
            or (url.scheme != "https" and not (url.scheme == "http" and url.hostname in ("localhost", "127.0.0.1")))):
        parser.error("Use HTTPS for a network portal.")
    # The key can come from the environment, so the connector can also run unattended (service, scheduled task).
    key = (os.environ.get("ASSISTENTE_AGENT_KEY") or getpass.getpass("Portal agent key: ")).strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{40,64}", key):
        parser.error("Invalid agent key format.")
    agent = f"http://127.0.0.1:{args.agent_port}"
    delivered, reported, answering = {}, False, False
    while True:
        try:
            data = request(portal, "/api/agent/sync", key, collect(agent, answering))
            answering = bool(data.get("answering"))
            deliver(agent, portal, key, data.get("decisions", []), delivered)
            if not reported:
                print("Connected. Relaying local agent data.", flush=True)
                reported = True
        except (HTTPError, TimeoutError, URLError, ValueError) as error:
            if args.once or isinstance(error, HTTPError) and error.code in (401, 403):
                raise SystemExit(f"Connector failed ({type(error).__name__}). Check the agent, portal and key.")
            if reported:
                print("The agent or portal is unavailable. Retrying.", flush=True)
            reported = False
        if args.once:
            return
        time.sleep(2)


if __name__ == "__main__":
    main()
