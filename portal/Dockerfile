# Assistente IA portal. Created by Diogo Moreira, MIT License.
FROM python:3.13-slim

LABEL org.opencontainers.image.title="Assistente IA portal" \
      org.opencontainers.image.description="Watch Claude Code and Codex and answer their permission requests from your phone." \
      org.opencontainers.image.authors="Diogo Moreira" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="1.2.0" \
      org.opencontainers.image.url="https://github.com/diogosmoreira84"

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app

# qrcode is the only dependency (pure Python).
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py connector.py webpush.py certgen.py lan_download.py README.md docker-entrypoint.sh ./
COPY public/ public/
RUN mkdir -p downloads

RUN useradd --system --uid 10001 --home-dir /app portal \
 && mkdir /data && chown portal /data && chmod +x docker-entrypoint.sh
USER portal
VOLUME /data
EXPOSE 8781 8782

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD python -c "import socket; socket.create_connection(('127.0.0.1', 8781), 3).close()"

ENTRYPOINT ["/app/docker-entrypoint.sh"]
