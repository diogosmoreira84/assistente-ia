"""Minimal Web Push sender: VAPID (RFC 8292) wake-up messages without a payload, standard library only.

The push carries no content. The service worker fetches the notice from the portal when it wakes up, so no
message encryption is needed and push services only ever see an empty request.
Assistente IA by Diogo Moreira. MIT License.
"""
import base64
import hashlib
import ipaddress
import json
import secrets
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

# NIST P-256 domain parameters.
P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF
A = P - 3
N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
G = (0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296,
     0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5)


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _add(p, q):
    if p is None:
        return q
    if q is None:
        return p
    if p[0] == q[0] and (p[1] + q[1]) % P == 0:
        return None
    if p == q:
        slope = (3 * p[0] * p[0] + A) * pow(2 * p[1], -1, P) % P
    else:
        slope = (q[1] - p[1]) * pow(q[0] - p[0], -1, P) % P
    x = (slope * slope - p[0] - q[0]) % P
    return x, (slope * (p[0] - x) - p[1]) % P


def _multiply(k, point):
    result = None
    while k:
        if k & 1:
            result = _add(result, point)
        point = _add(point, point)
        k >>= 1
    return result


def generate_keys():
    """Returns (private scalar as hex, public key as base64url uncompressed point)."""
    d = secrets.randbelow(N - 1) + 1
    x, y = _multiply(d, G)
    return format(d, "064x"), b64url(b"\x04" + x.to_bytes(32, "big") + y.to_bytes(32, "big"))


def sign(private_hex, message):
    """ES256 signature (raw r||s) of message bytes."""
    d = int(private_hex, 16)
    z = int.from_bytes(hashlib.sha256(message).digest(), "big")
    while True:
        k = secrets.randbelow(N - 1) + 1
        r = _multiply(k, G)[0] % N
        s = pow(k, -1, N) * (z + r * d) % N
        if r and s:
            return r.to_bytes(32, "big") + s.to_bytes(32, "big")


def vapid_header(endpoint, private_hex, public_b64, subject):
    site = urlsplit(endpoint)
    claims = {"aud": f"{site.scheme}://{site.netloc}", "exp": int(time.time()) + 12 * 3600, "sub": subject}
    head = b64url(json.dumps({"typ": "JWT", "alg": "ES256"}, separators=(",", ":")).encode())
    body = b64url(json.dumps(claims, separators=(",", ":")).encode())
    token = head + "." + body
    return f"vapid t={token}.{b64url(sign(private_hex, token.encode()))}, k={public_b64}"


def valid_endpoint(endpoint):
    """Push endpoints come from the browser; accept only public HTTPS hosts."""
    if not isinstance(endpoint, str) or len(endpoint) > 1000:
        return False
    site = urlsplit(endpoint)
    if site.scheme != "https" or not site.hostname or site.username or site.password:
        return False
    host = site.hostname.lower()
    if host == "localhost" or host.endswith((".local", ".internal", ".lan")) or "." not in host:
        return False
    try:
        address = ipaddress.ip_address(host.strip("[]"))
        return address.is_global
    except ValueError:
        return True


def send(endpoint, private_hex, public_b64, subject, urgency="high"):
    """Sends an empty push. Returns 'sent', 'gone' (subscription expired) or 'failed'."""
    if not valid_endpoint(endpoint):
        return "gone"
    request = Request(endpoint, data=b"", method="POST", headers={
        "TTL": "3600", "Urgency": urgency, "Content-Length": "0",
        "Authorization": vapid_header(endpoint, private_hex, public_b64, subject)})
    try:
        with urlopen(request, timeout=10) as response:
            return "sent" if 200 <= response.status < 300 else "failed"
    except HTTPError as error:
        return "gone" if error.code in (404, 410) else "failed"
    except (URLError, TimeoutError, OSError):
        return "failed"
