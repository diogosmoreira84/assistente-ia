# Assistente IA portal

**Created by [Diogo Moreira](https://github.com/diogosmoreira84)** · MIT License

A self-hosted portal to watch and steer your AI coding agents (Claude Code and Codex) from any screen. See live sessions and usage limits, answer permission requests from your phone, and let rules answer the routine ones for you.

## Features

- **Live overview**: working, waiting and idle sessions with model, effort, run time, token use and context fill. CPU and memory of the host PC.
- **Approval requests**: requests appear at the top of every page with the exact command, a countdown and *Allow once*, *Deny* or *Always…* (creates a rule).
- **Automation rules**: rules read as plain sentences ("Allow any agent to run a command when the command starts with `npm test` in any project"). There are one-click Quick start sets, a live preview with example requests, and *Always…* on any request. Block rules win. An allow rule that uses a wildcard never matches commands that chain, pipe, redirect or substitute (`; & | $ < >` and backticks).
- **Installable app (PWA)**: install the portal on a phone or computer and open it full screen from the home screen, with an offline app shell.
- **Push notifications**: approval requests, finished tasks, usage alerts and the daily summary reach your devices even when the app is closed. Pushes are empty wake-up messages signed with VAPID, and the app fetches the text from your own portal, so push services never see content.
- **Usage alerts**: one alert per limit window when Claude Code or Codex crosses your chosen level (50–95%).
- **Daily summary**: agent time, projects, approvals and peak usage for the day, at the hour you choose. Kept in Insights.
- **Use it anywhere**: publish the portal privately on your Tailscale network (`tailscale serve`, never Funnel) and scan a QR code to open it on your phone.
- **Activity**: a 30-day timeline with search and filters by agent, project and event type.
- **Insights**: agent time per day, top projects, approval breakdown and usage-limit history. Every chart has hover details and a table view.
- **GitHub**: review requests, your open PRs with CI state, notification count, and a repository list with creation through the GitHub CLI on the host PC.
- **Devices**: link the local PC in one click, connect remote PCs with a one-time key, and pair Android phones and tablets with a QR code.
- **Account**: profile, password change, sign out other sessions, account deletion. Dark, light and system themes.
- **Real-time updates**: server-sent events, falling back to polling.

## Run the portal

Use Python 3.10+ and install the dependency with `python -m pip install -r requirements.txt`. Run `python server.py` and open `http://127.0.0.1:8780/`.

On Windows, `Start-Portal.ps1` starts everything in one step:
- the local portal
- the HTTPS listener for your Wi-Fi
- the Android download page
- when available, your private Tailscale address

### Run it with Docker

```
docker build -t assistente-ia-portal .
docker run -d --name assistente-ia --restart unless-stopped   -p 8781:8781 -p 8782:8782 -v assistente-ia-data:/data   -e PORTAL_ORIGIN=https://192.168.1.20:8781 assistente-ia-portal
```

- Set `PORTAL_ORIGIN` to the exact address browsers and phones use: the host's IP or name and the published port.
- On first start the container creates its certificate in `/data`, which also holds the database. Keep the volume.
- Port 8782 serves the Android download page used by the QR code in **Downloads**.
- Optional: set `PUBLIC_ORIGIN` to an HTTPS address for use away from home, and `DOWNLOAD_ORIGIN` when port 8782 is published elsewhere.
- Desktop agents connect with the command shown in **Devices**: `python connector.py --portal <address> --fingerprint <sha256>`. The fingerprint pins the container's self-signed certificate. Set `ASSISTENTE_AGENT_KEY` to run the connector without the key prompt.
- "Connect this PC" is only available when the portal runs directly on the PC with the agent (`Start-Portal.ps1`).

### Use it away from home (Tailscale)

1. Install Tailscale on the PC and on your phone, signed in to the same account.
2. In the Tailscale admin console, open **DNS** and enable **MagicDNS** and **HTTPS Certificates**.
3. Run `Start-Portal.ps1`. It starts a loopback listener with `--behind-proxy --origin https://<pc>.<tailnet>.ts.net` and publishes it with `tailscale serve`. Only devices on your tailnet can reach it.
4. Open **Devices › Use it anywhere**, scan the QR code with your phone, install the app and turn on push in **Settings**.

On the Windows PC that runs the PhoneBox agent, add `--local-agent-port 8765` to enable **Connect this PC**. The portal relays that agent for the linked account and reconnects after restarts.

For access from other devices, run a TLS listener using `--host`, `--port`, `--origin`, `--cert` and `--key`. Set the origin to the exact HTTPS address clients use. The Android QR code carries the certificate's fingerprint, so the app trusts only that certificate. A loopback portal can issue pairing codes for the TLS listener with `--pair-origin` and `--pair-cert`. Run both listeners against the same `--database`. Keep the database and private key outside the repository.

To install the Android app by scanning a QR code, run `python lan_download.py <LAN_IP>` (port 8782). **Downloads** then shows a QR code that the phone camera opens directly. The portal derives that address from `--pair-origin`; set `--download-origin` to override it.

## Connect a remote desktop agent

1. Install the PhoneBox desktop agent and sign in to Claude Code or Codex on that computer.
2. In **Devices**, generate an agent key. Generating a new key revokes the previous one, because each account tracks one agent.
3. Run `python connector.py --portal https://your-portal` and paste the key.

## Data and privacy

Everything is stored in one SQLite file. Activity is kept for 30 days. Agent time is aggregated per day, project and agent. Usage-limit readings are sampled every 5 minutes and kept for 35 days. Passwords use scrypt. Session, device and agent tokens are stored only as SHA-256 hashes. The browser app runs under a strict Content Security Policy and never renders server data as HTML.

## Components

- `server.py`: HTTP server, API, SQLite schema and migrations, local agent relay.
- `public/`: browser app with no build step (ES modules in `public/js`, styles in `public/css`).
- `connector.py`: relays a PhoneBox agent to the portal and delivers approval decisions.
- `webpush.py`: VAPID push sender (standard library only).
- `certgen.py`: creates the self-signed certificate for the Wi-Fi listener (standard library only).
- `Start-Portal.ps1`: starts every listener on Windows.
- `Dockerfile` and `docker-entrypoint.sh`: container image for the portal.
- `lan_download.py`: optional APK download page.
- `../android/`: Android app.
- `../windows/`: Windows installer and packaging scripts.

## License and credits

Assistente IA is © 2026 Diogo Moreira, released under the [MIT License](LICENSE). Keep the copyright notice in copies and derivatives.

PhoneBox is an MIT-licensed project by [ersinkoc](https://github.com/ersinkoc/phonebox). Provider icons come from [Lobe Icons](https://github.com/lobehub/lobe-icons). The Android QR reader uses [ZXing](https://github.com/zxing/zxing).
