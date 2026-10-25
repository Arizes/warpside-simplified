# Architecture: Railway backend, Cloudflare edge

Decided by the owner on 2026-10-25. This is the **target** architecture. The code still runs on the original
Cloudflare Worker and Durable Object design (see `README.md`) until the migration below is complete; each
phase keeps the site working.

## Split of responsibilities

| Layer | Provider | What it does |
|---|---|---|
| DNS, TLS, WAF, rate limiting | Cloudflare (Free) | `warpside2.com` zone, proxied records, security rules |
| Frontend | Cloudflare (Workers static assets, no Worker code, no Durable Object) | Serves `public/`: page, map tiles, sounds |
| Edge cache | Cloudflare | Caches API responses for a few seconds so viewers rarely reach Railway |
| Backend API | Railway (Hobby) | `/api/*` and `/health`, same routes and response shapes as today |
| Event listener | Railway, same process as the API | One connection per Census stream environment, 24/7 |
| Background work | Railway, same process | Census lookups, map polling, rollups, retention, partition maintenance |
| Database | Railway PostgreSQL | Events, rollups, cached Census lookups, map geometry |
| Backups | Railway + off-provider copy | See [Backups](#backups) |

```
Browser ──▶ warpside2.com (Cloudflare: static assets, cached)
   └──▶ api.warpside2.com (Cloudflare proxy + cache) ──▶ Railway "app" service (Node 22, Docker)
                                                           ├─ API (src/api.js, src/stats.js, src/map.js)
Daybreak event stream ◀──WebSocket── listener ─────────────┤─ in-memory 24 h window (live leaderboards)
Census REST ◀── batched lookups ───────────────────────────┤─ batched writes every few seconds
                                                           └──▶ Railway PostgreSQL (private network)
```

## Principles

- **Two Railway services only:** `app` and `postgres`. No Redis, queue, worker fleet, or separate cron
  service. One Node process does API, listening and background jobs; that is enough for two PS4 servers
  (about 14 deaths/min measured on Genudine).
- **Exactly one replica of `app`.** Two listeners would ingest every event twice. Do not enable horizontal
  scaling; scale vertically if ever needed.
- **Live views stay in memory.** Leaderboards, 1 h/6 h/24 h windows and the map are computed from the
  in-memory window exactly as now, so API reads cost no database queries. Postgres is for durability,
  history and (later) profiles, not for serving every poll.
- **Portable by construction.** Everything is configured by environment variables (`DATABASE_URL`,
  `CENSUS_SERVICE_ID`, `PORT`, `PUBLIC_ORIGIN`), packaged by a plain `Dockerfile`, and runs locally with
  `docker compose`. No Railway SDK or Railway-only feature in the code path. Moving providers means: run the
  image anywhere, restore a `pg_dump`, change one DNS record.
- **Existing rules still apply:** IDs stay strings in JavaScript (rule 3), untrusted data is validated at the
  edge (rule 2), the service ID never reaches logs or the browser (rule 5), rule 13 on presenting data.

## Database design

Plain PostgreSQL (16+), no extensions, so any managed Postgres or a container can host it.

- **IDs:** character, item and outfit IDs are `bigint` columns (Census IDs fit in signed 64-bit; confirm
  against the largest observed ID before the schema is final). `node-postgres` returns `bigint` as a string,
  which keeps rule 3 intact; never enable its integer parsing.
- **Raw events:** one `events` table, **range-partitioned by day** on event time. Inserts are batched
  (multi-row `INSERT` or `COPY` every ~5 s), never one row per event. Expiring raw data is
  `DROP TABLE` on an old partition: instant, no vacuum load, no bloat. The app creates tomorrow's partition
  ahead of time.
- **Rollups for long-term history:** hourly aggregates per world, character, outfit and weapon (kills,
  deaths, headshots, play time seen). These are small and are what is kept indefinitely; raw events are
  kept for a configurable window (start with 30 days, `RAW_RETENTION_DAYS`).
- **Reference data:** `characters`, `outfits`, `items` cache Census lookups with a `fetched_at`, replacing the
  in-memory-only cache, so restarts do not re-query Census. Map geometry (currently Durable Object storage)
  moves to a `map_static` table.
- **Indexes:** only what queries need; for raw partitions, `(world_id, ts)` and `(character_id, ts)`.
  BRIN on `ts` is enough for range scans on append-only partitions.
- **Migrations:** numbered plain `.sql` files applied at startup inside a transaction, tracked in a
  `schema_migrations` table. No ORM.
- **Restart recovery:** on boot the app reloads the last 24 h from `events` into memory, replacing the
  gzipped Durable Object snapshot. Nothing is lost except events during the restart itself.

Rough size: 2 servers × ~20 kills/min ≈ 60,000 events/day. At ~100 bytes per row with indexes that is about
6 MB/day raw, ~180 MB for 30 days, plus a few MB/month of rollups. Comfortably small.

## Resource budget (Railway Hobby)

Railway Hobby is billed by usage (CPU, memory, volume, egress) on top of a monthly subscription that includes
some credit. Check current prices on Railway's pricing page before relying on any figure.

- `app`: target under 256 MB RAM and well under 0.1 vCPU average. Avoid per-request work: the API serves
  memoised results (as `src/api.js` does now) and Cloudflare caches them.
- `postgres`: small; keep `shared_buffers` modest and avoid long-running queries.
- **Egress:** browsers download map tiles and the page from Cloudflare, never from Railway. Only API JSON
  leaves Railway, and the edge cache absorbs most of it.
- Watch the Railway usage page monthly; if cost grows, see [Exit plan](#exit-plan).

## Cloudflare edge

- **Frontend:** the same `public/` directory deployed as Workers static assets with no `main` script and no
  Durable Object, which is free and does not count against Worker request limits.
- **API host:** `api.warpside2.com` as a proxied CNAME to the Railway service's custom domain.
- **Caching:** API responses send `Cache-Control: public, max-age=0, s-maxage=15` (map static data longer);
  a Cache Rule makes Cloudflare cache `api.warpside2.com/api/*` JSON. `/health` is never cached.
- **Security:** a rate-limiting rule on `/api/*`, and, so the API cannot be called around the cache, the
  origin accepts only requests through Cloudflare (a shared secret header added by a Transform Rule and
  checked by the app, kept in Railway variables).
- **CSP and CORS:** `connect-src` in `public/_headers` gains `https://api.warpside2.com`, and the API answers
  CORS only for `PUBLIC_ORIGIN`. This is a CSP change, approved as part of this architecture.

## Backups

- **Railway:** enable Postgres volume backups if the Hobby plan offers them at the time of setup (verify in
  the Railway dashboard; do not assume).
- **Provider-independent copy (required):** a nightly `pg_dump --format=custom` run by the `app` process
  (or `pg_dump` in the same image) and uploaded off Railway, for example to Cloudflare R2's free tier. Keep
  7 daily and 4 weekly dumps.
- **Restore drill:** restore the latest dump into a local `docker compose` Postgres once after setup and
  after any schema change. An untested backup does not count.

## Migration plan

Each phase is shippable on its own and keeps all current functionality (leaderboards, player detail, map,
`/health`, the same API contract).

1. **Port the runtime.** Replace the Durable Object with a plain Node HTTP server (`src/server.js`) that hosts
   the same API, the stream listener and timers. `src/tracker.js` loses its `cloudflare:workers` import;
   `stream.js`, `ingest.js`, `stats.js`, `map.js`, `census.js` and `api.js` are reused unchanged where
   possible. Add `Dockerfile` and `docker-compose.yml`. Tests keep passing.
2. **Add Postgres.** Batched event writes, boot-time reload of the last 24 h, Census reference cache,
   `map_static`. Remove the snapshot code once reload is proven.
3. **History.** Daily partitions, hourly rollups, retention job, nightly backup and restore drill.
4. **Edge and cutover.** Deploy `public/` to Cloudflare as static assets, point `api.warpside2.com` at
   Railway, add the cache and security rules, then retire the Worker and Durable Object.
5. **Later: player profiles.** Built on rollups (long-term per-character stats). Scope and UI to be decided;
   rule 13 applies to anything derived.

## Exit plan

If Railway becomes too expensive: run the same Docker image on any VPS or container host (Fly.io, Hetzner,
a home server behind a Cloudflare Tunnel), restore the latest `pg_dump` into any Postgres 16+, set the same
environment variables, and change the `api` DNS record. The frontend on Cloudflare does not change.
