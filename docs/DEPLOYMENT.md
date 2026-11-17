# Deployment: local, local network, container

> **Role:** where and how EANyra may run, and what each option exposes · **Audience:** anyone running EANyra outside the default single PC

EANyra is a single-user tool. The web UI and MCP are built for **one person on
one machine**: they listen on loopback only, and the security model (below)
relies on that. Every option here keeps it that way.

## Security model in one paragraph

The web server binds `127.0.0.1` and refuses other addresses. It checks the
`Host` header (blocks DNS rebinding), needs the `X-EANyra` header and a
same-origin `Origin` on every POST (blocks CSRF), keeps the session in an
HttpOnly SameSite=Strict cookie, sends a strict CSP, throttles wrong passwords
and caps request bodies. `/mcp` needs a Bearer token and refuses browser
requests. What it deliberately does **not** do: TLS. Traffic is plain HTTP,
which is fine on loopback (it never leaves the PC) and not fine on a network,
where the master password, the session cookie and the MCP token would travel
in clear text.

## 1. One PC (default)

```bash
npm install
npm run serve
```

Open `http://localhost:4450`. Claude Desktop / Claude Code connect over stdio
([MCP_GUIDE.md](MCP_GUIDE.md)). Nothing else is needed.

## 2. From another device on your network

Direct LAN access is intentionally not supported: binding `0.0.0.0` on the
LAN would send your master password over plain HTTP to anyone on the Wi-Fi.
Keep EANyra on loopback and bring the other device to it through an encrypted
tunnel:

- **SSH tunnel** (Windows has an optional OpenSSH Server: Settings → System →
  Optional features). From the other device:

  ```bash
  ssh -N -L 4450:localhost:4450 you@your-pc
  ```

  then open `http://localhost:4450` there. The browser sees `localhost`, so
  the Host and Origin checks pass and nothing is exposed on the LAN.
- **Tailscale / WireGuard**: the same idea over a private mesh; use
  `ssh -L` through it, or Tailscale Serve, which adds HTTPS and forwards to
  `localhost:4450` on the PC.

Do not put a reverse proxy in front that rewrites `Host` to a LAN name: the
server would answer 421 by design.

## 3. Container (Docker / Podman)

`Dockerfile` and `compose.yaml` in the repository root run the web UI with the
scheduler in one container. **Status: written against the Playwright image and
the code paths above, but not yet built on a machine with Docker** — treat the
first run as a test.

```bash
docker compose up -d --build
docker compose logs -f eanyra      # first start prints the one-time token
```

Open `http://localhost:4450`, log in with the token from the log and create
the vault on «Огляд», as on a PC.

What is different in a container:

| Topic | In the container |
|---|---|
| Network | The server binds `0.0.0.0` inside the container (allowed only with `EANYRA_CONTAINER=1`), and compose publishes it as **`127.0.0.1:4450`** on the host. Never publish `4450:4450` or `0.0.0.0:4450`. |
| Data | `/app/instance` is a named volume (`eanyra-instance`): database, vault, accounts, context, backups. Back it up with «Налаштування» → «Створити бекап» (lands in the volume) or `docker run --rm -v eanyra-instance:/d -v ${PWD}:/b alpine tar czf /b/eanyra.tgz -C /d .`. |
| Vault unlock | No Windows DPAPI, so «Запам'ятати на цьому ПК» is unavailable. After every container start, log in once in the browser: that unlocks the vault for the scheduler and `/mcp` in the same process. `EANYRA_MASTER_PASSWORD` also works but keeps the password in plaintext in the container environment; avoid it. |
| X login | No screen, so «Увійти у вікні…» cannot open. Use «Cookies…» (paste or upload an export from your browser). |
| Telegram login | QR login works: the QR is shown in the page. |
| Encryption at rest | EFS is Windows-only. Use disk encryption on the host (BitLocker on the Docker Desktop disk, LUKS on Linux). |
| MCP | Add `--mcp` to the command (see `compose.yaml`) and connect the AI client to `http://localhost:4450/mcp` with the token from «Налаштування». Or stdio through the container: `docker exec -i eanyra-eanyra-1 node src/core/mcp/start.js` as the client command (reads work; collection and publishing need the vault unlocked in that process). |
| Chromium | `shm_size: 1gb` in compose; Docker's default 64 MB `/dev/shm` crashes Chromium. |
| Updates | `git pull`, then `docker compose up -d --build`. Migrations run on start; the volume keeps the data. |

The image never contains personal data: `.dockerignore` excludes `.env`,
`instance/`, `data/` and cookie files.

## 4. A VPS or any remote server

Not supported as an exposed service. The reasons are the open roadmap item
«Review HTTP MCP deployment security»: there is no TLS, no multi-user model,
and the login, CSRF and session rules assume one person on loopback. If you
run it on a server anyway, run the container exactly as above (loopback-only
port) and reach it only through `ssh -L 4450:localhost:4450 you@server`.
Also note that X sees the server's IP: collecting from a data-center address
is far more likely to trigger checks than from your home connection.
