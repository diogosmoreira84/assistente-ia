"""Creates the self-signed TLS certificate for the Wi-Fi listener, using only the standard library.

RSA 2048 with SHA-256, valid for this PC's LAN address, 127.0.0.1 and localhost. Phones and tablets do not need
to trust it: the pairing QR code carries its fingerprint and the Android app accepts exactly that certificate.
Assistente IA by Diogo Moreira. MIT License.
"""
import argparse
import base64
import hashlib
import ipaddress
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path


def _probable_prime(bits):
    small = (3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47)
    while True:
        n = secrets.randbits(bits) | (3 << (bits - 2)) | 1
        if any(n % p == 0 for p in small) or (n - 1) % 65537 == 0:
            continue
        d, r = n - 1, 0
        while d % 2 == 0:
            d, r = d // 2, r + 1
        for _ in range(40):
            x = pow(secrets.randbelow(n - 3) + 2, d, n)
            if x in (1, n - 1):
                continue
            for _ in range(r - 1):
                x = pow(x, 2, n)
                if x == n - 1:
                    break
            else:
                break
        else:
            return n


def _len(n):
    if n < 0x80:
        return bytes([n])
    raw = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(raw)]) + raw


def _tlv(tag, body):
    return bytes([tag]) + _len(len(body)) + body


def _int(n):
    raw = n.to_bytes(max(1, (n.bit_length() + 8) // 8), "big")
    return _tlv(0x02, raw)


def _oid(dotted):
    parts = [int(p) for p in dotted.split(".")]
    body = bytes([40 * parts[0] + parts[1]])
    for part in parts[2:]:
        chunk = [part & 0x7F]
        part >>= 7
        while part:
            chunk.append(0x80 | (part & 0x7F))
            part >>= 7
        body += bytes(reversed(chunk))
    return _tlv(0x06, body)


def _seq(*items):
    return _tlv(0x30, b"".join(items))


def _time(moment):
    return _tlv(0x17, moment.strftime("%y%m%d%H%M%SZ").encode())


def create(cert_path, key_path, addresses, days=825):
    e = 65537
    while True:
        p, q = _probable_prime(1024), _probable_prime(1024)
        n = p * q
        if p != q and n.bit_length() == 2048:
            break
    d = pow(e, -1, (p - 1) * (q - 1))
    private = _seq(_int(0), _int(n), _int(e), _int(d), _int(p), _int(q), _int(d % (p - 1)), _int(d % (q - 1)), _int(pow(q, -1, p)))

    sha256_rsa = _seq(_oid("1.2.840.113549.1.1.11"), b"\x05\x00")
    name = _seq(_tlv(0x31, _seq(_oid("2.5.4.3"), _tlv(0x0C, b"Assistente IA Local"))))
    now = datetime.now(timezone.utc).replace(microsecond=0)
    def entry(value):
        try:
            return _tlv(0x87, ipaddress.ip_address(value).packed)
        except ValueError:
            return _tlv(0x82, value.encode("ascii"))
    alt = b"".join(entry(a) for a in addresses if a != "localhost") + _tlv(0x82, b"localhost")
    extensions = _tlv(0xA3, _seq(
        _seq(_oid("2.5.29.17"), _tlv(0x04, _seq(alt))),
        _seq(_oid("2.5.29.19"), _tlv(0x04, _seq())),
        _seq(_oid("2.5.29.37"), _tlv(0x04, _seq(_oid("1.3.6.1.5.5.7.3.1"))))))
    public = _seq(_seq(_oid("1.2.840.113549.1.1.1"), b"\x05\x00"), _tlv(0x03, b"\x00" + _seq(_int(n), _int(e))))
    tbs = _seq(_tlv(0xA0, _int(2)), _int(secrets.randbits(120) | 1 << 120), sha256_rsa, name,
               _seq(_time(now - timedelta(days=1)), _time(now + timedelta(days=days))), name, public, extensions)

    digest_info = bytes.fromhex("3031300d060960864801650304020105000420") + hashlib.sha256(tbs).digest()
    padded = b"\x00\x01" + b"\xff" * (256 - 3 - len(digest_info)) + b"\x00" + digest_info
    signature = pow(int.from_bytes(padded, "big"), d, n).to_bytes(256, "big")
    certificate = _seq(tbs, sha256_rsa, _tlv(0x03, b"\x00" + signature))

    def pem(label, der):
        body = base64.encodebytes(der).decode().replace("\n", "")
        return f"-----BEGIN {label}-----\n" + "\n".join(body[i:i + 64] for i in range(0, len(body), 64)) + f"\n-----END {label}-----\n"
    Path(cert_path).parent.mkdir(parents=True, exist_ok=True)
    Path(key_path).write_text(pem("RSA PRIVATE KEY", private))
    Path(cert_path).write_text(pem("CERTIFICATE", certificate))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ip", action="append", required=True, help="IP address or host name to include (repeatable)")
    parser.add_argument("--cert", type=Path, default=Path(__file__).resolve().parent / "data" / "portal-cert.pem")
    parser.add_argument("--key", type=Path, default=Path(__file__).resolve().parent / "data" / "portal-key.pem")
    args = parser.parse_args()
    create(args.cert, args.key, list(dict.fromkeys(args.ip + ["127.0.0.1"])))
    print("Created", args.cert)
