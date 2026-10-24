# Deploying Warpside to Cloudflare

Everything runs on the **Workers Free** plan: one Worker, one SQLite-backed Durable Object, static assets and
one cron trigger. There is nothing else to create.

## Deploy

```sh
npm install
npx wrangler login                          # once
npx wrangler secret put CENSUS_SERVICE_ID   # paste your Census service ID; never commit it
npm run deploy
```

The first deploy creates the Durable Object class and the cron trigger. The collector starts on the first
request or at the next cron tick (within a minute). Open `/health`: `streams` should read `connected` for both
environments and `events` should start climbing.

Optional: add a custom domain under Workers & Pages, Settings, Domains & Routes.

## Free-plan budget (verified against Cloudflare docs, October 2026)

| Resource | Free limit | Use |
|---|---|---|
| Durable Object duration | 13,000 GB-s/day | 128 MB x 86,400 s = about 11,060 GB-s/day (**85%**) |
| Durable Object requests | 100,000/day (WebSocket messages count 20:1) | about 1,500 to 10,000 billed/day |
| Durable Object row writes | 100,000/day | about 1,000 to 7,000/day (snapshots and alarms) |
| Worker requests | 100,000/day, shared by all visitors | the page is free; each API poll is one |
| Memory | 128 MB | tens of MB at peak |

Measured stream rate (Genudine, one 9-minute sample): about 14 deaths/min, plus logins and heartbeats.

**Capacity:** the dashboard polls every 30 s, which is 120 Worker requests per viewer-hour, so the free plan
supports roughly 800 viewer-hours per day. If you outgrow it, publish snapshots to a public R2 bucket so the
CDN serves them, or move to the Workers Paid plan ($5/month).

## Risks and what to watch

- **Duration is the tight limit.** If the quota is exhausted the collector stops until 00:00 UTC. Keep it to
  one object; do not add a second always-on object to this account's free plan.
- **Free limits can change.** Re-check the pricing pages before relying on this.
- **Traffic spikes** can exhaust the 100,000 daily Worker requests; the API then returns errors until
  00:00 UTC. The static page keeps working.
- **Eviction or deploys** drop the stream briefly. The cron trigger and the 30-second alarm reconnect it, and
  the snapshot restores the log, so the gap is typically under a minute.

## Operating notes

- **Service ID** is a Worker secret, never logged (connection errors log only the message) and never sent to
  the browser.
- **Health:** `GET /health` shows stream status per environment and the stored event count. A frozen `events`
  count while players are online means the feed is down.
- **Usage:** check Workers & Pages, Durable Objects, Metrics for duration, requests and rows written.
- **Updating:** `npm run deploy`. State is restored from the snapshot.
- **Adding a server:** add an entry to `SERVERS` in `src/config.js` (namespace and stream environment from
  `docs/research/census-api.md`). Another stream environment adds another always-on connection but not another
  object.
- **Fallback:** the first commit in the history is a plain Node version of this app (one process plus a JSON
  file) that runs on any small VPS with a persistent disk.

## Shared quota: use a dedicated Cloudflare account

Free-plan limits are counted **per Cloudflare account**, not per Worker or project. Every Worker on the
account shares the 100,000 daily requests, and every Durable Object shares the 13,000 GB-s/day of duration.
Warpside's always-on collector alone uses about 85% of the duration limit, so deploy it only to an account
that hosts nothing else. A busy neighbour could stop the collector, and the collector would crowd out the
neighbour. If a dedicated free account is not an option, the Workers Paid plan ($5/month) lifts these caps
(one always-on object stays inside its included 400,000 GB-s/month), or run the Node version from the first
commit on a small VPS behind Cloudflare's proxy.
