#!/bin/sh
# Assistente IA portal container entrypoint. Created by Diogo Moreira, MIT License.
set -e
: "${PORTAL_ORIGIN:?Set PORTAL_ORIGIN to the exact address browsers and phones use, for example https://192.168.1.20:8781}"
host=$(python -c "import os; from urllib.parse import urlsplit; print(urlsplit(os.environ['PORTAL_ORIGIN']).hostname or '')")
[ -n "$host" ] || { echo "PORTAL_ORIGIN must look like https://host:port" >&2; exit 2; }

# The certificate is created once and kept in /data: paired phones trust its fingerprint.
if [ ! -f /data/portal-cert.pem ] || [ ! -f /data/portal-key.pem ]; then
    python certgen.py --ip "$host" --cert /data/portal-cert.pem --key /data/portal-key.pem
fi

# Android download page for the QR code in Downloads (port 8782).
python lan_download.py 0.0.0.0 &

set -- python server.py --host 0.0.0.0 --port 8781 --origin "$PORTAL_ORIGIN" \
    --cert /data/portal-cert.pem --key /data/portal-key.pem --database /data/portal.sqlite3 "$@"
[ -n "$PUBLIC_ORIGIN" ] && set -- "$@" --public-origin "$PUBLIC_ORIGIN"
[ -n "$DOWNLOAD_ORIGIN" ] && set -- "$@" --download-origin "$DOWNLOAD_ORIGIN"
exec "$@"
