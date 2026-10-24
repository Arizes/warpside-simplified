# Deploying Warpside

Warpside needs **one always-on process and a small persistent disk** (about 1 GB). It must not sleep: a
sleeping host misses kills, and the 24-hour history would have gaps. Hosts that scale to zero or have
ephemeral disks (serverless functions, Workers, free tiers that sleep) are not suitable.

Any of these work:

| Option | Notes |
|---|---|
| Small VPS with Docker | Cheapest and simplest. Run the image with a volume on `/data`. |
| Fly.io | `fly launch` (uses the Dockerfile), `fly volumes create data --size 1`, mount at `/data`, `fly secrets set CENSUS_SERVICE_ID=...`. Keep one machine, never auto-stop. |
| Railway / Render | Needs an always-on plan with a persistent disk at `/data`. |

Check current prices before choosing; the process needs well under 256 MB of memory at PS4 volumes
(measure with `/health` and your host's metrics after a day).

## Docker

```sh
docker build -t warpside .
docker run -d --restart=always --name warpside \
  -p 8080:8080 -v warpside-data:/data \
  -e CENSUS_SERVICE_ID=your-id warpside
```

The container runs as a non-root user and has a health check on `/health`.

## HTTPS and caching

Put the process behind a TLS-terminating proxy. Cloudflare (proxied DNS, or a Cloudflare Tunnel so no port is
opened) works well and also caches `/img/*`. `/api/*` responses are `no-store`.

## Operating notes

- **Service ID:** set it as an environment variable or secret, never commit it. It is never logged or sent
  to the browser.
- **Backups:** none needed. The data is a rolling 24 hours; losing it only means the history restarts.
- **Health:** `GET /health` lists the stream status per environment and the number of stored events.
  `streams` should read `connected`; a frozen `events` count while players are online means the feed is down.
- **Updating:** rebuild the image and restart. State is reloaded from the volume.
- **Adding a server:** add an entry to `SERVERS` in `src/config.js` (namespace and stream environment from
  `docs/research/census-api.md`).
