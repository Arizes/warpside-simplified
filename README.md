# Warpside Simplified

Live PlanetSide 2 leaderboards for the PS4 servers **Genudine** (US) and **Ceres** (EU): top players and outfits
by empire, a live player count per empire over a rolling 24-hour window, and a live continent map with territory, base captures
and estimated fights.

Today it runs entirely on Cloudflare's free tier: one Worker serves the page and the API, and one Durable
Object collects the kill stream and keeps the last 24 hours. No database, no server to maintain, no runtime
dependencies.

> **Move in progress (decided 2026-10-25):** the backend API, event listener, background jobs and a
> PostgreSQL database move to **Railway** (Hobby), packaged with Docker so the provider can be changed;
> **Cloudflare** keeps the frontend, DNS, caching and security. Plan and phases:
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
>
> **Phase 1 is done:** the collector also runs as a plain Node process (`npm start`, or `docker compose up`)
> with no Cloudflare runtime, serving the same API. Both runtimes share `src/collector.js`, so there is one
> implementation. Phase 2 adds PostgreSQL; the Worker is retired in phase 4.

> The earlier, much larger Postgres-based design is archived at
> [Arizes/warpside](https://github.com/Arizes/warpside). This project started from
> [Arizes/ps2-stats-tracker](https://github.com/Arizes/ps2-stats-tracker).

## Run it locally

Requires Node 22+.

```sh
npm install
npm run assets                   # map tiles and sounds (about 120 MB, not in git); dev and deploy also run it
cp .dev.vars.example .dev.vars   # add your CENSUS_SERVICE_ID (free: https://census.daybreakgames.com/#devSignup)
npm run dev                      # Worker + Durable Object, http://localhost:8787
npm test
```

Or run the Node backend, which is what Railway will run:

```sh
cp .env.example .env             # same CENSUS_SERVICE_ID
npm start                        # http://localhost:8080  (npm run dev:node to reload on change)
docker compose up --build        # the same image Railway builds, plus Postgres for phase 2
```

Leaderboards start empty and fill as kills arrive; the 24-hour history builds up the longer it runs.

## How it works

```
Daybreak event stream ──outbound WebSocket──▶ Tracker (one Durable Object)
   (Death, login, logout)                       ├─ parses events (src/stream.js)
Census REST ◀── batched name/weapon lookups ────┤─ keeps the rolling event log in memory
                                                ├─ snapshots it to its own storage every ~60 s
Browser ──▶ Worker ──▶ /api/* ──────────────────┴─ computes leaderboards on request (src/stats.js)
   └──▶ static page (public/, served by Cloudflare, free and unmetered)
```

| File | Job |
|---|---|
| `src/collector.js` | The collector, runtime-neutral: connections, event log, map, API, watchdog tick |
| `src/worker.js` | Cloudflare entry point: routes `/api/*` and `/health` to the Tracker, cron safety net |
| `src/tracker.js` | Cloudflare wrapper: Durable Object storage, WebSocket over fetch, keep-alive alarm |
| `src/server.js` | Node entry point: HTTP server, static files, graceful shutdown (what Railway runs) |
| `src/node-store.js` | Snapshot, map and geometry as files in `DATA_DIR` (replaced by Postgres in phase 2) |
| `src/stream.js` | Stream URL, subscription message and message parsing |
| `src/ingest.js` | Applies a parsed record to the state |
| `src/census.js` | Batched, cached, backed-off Census lookups |
| `src/store.js` | Event log, pruning, compressed chunked snapshots |
| `src/stats.js` | Leaderboards, outfits, faction split, player count per empire, player detail |
| `src/map.js` | Map state: ownership, base presence, fight detection, captures |
| `public/map.js` | The map view: tiles, hex territories, influence cloud, lattice, battle bubbles, region card, zoom sounds |
| `public/map-logic.js` | Pure map helpers (cut-off territory, bubble rate, base labels), unit tested |
| `scripts/fetch-map-assets.mjs` | Downloads map tiles and sounds from ps2alerts/assets at a pinned commit |
| `src/api.js` | Routes, validation, short response memo |
| `src/config.js` | Server list (add a world here), windows, env |
| `public/` | The dashboard (plain HTML, CSS, ES modules) and `_headers` (CSP) |

API (all `GET`): `/api/stats?world=1000&window=24h`, `/api/player?world=1000&id=<characterId>&window=24h`,
`/api/population?world=1000&range=2h`, `/api/online?world=1000&empire=1`, `/api/map?world=1000[&zone=2]`,
`/api/map-static?world=1000&zone=2`, `/api/servers`, `/health`. Windows are `1h`, `6h`, `24h`; chart ranges are
`2h`, `6h`, `24h`, `7d`; `empire` is `0` for everyone, or `1` VS, `2` NC, `3` TR, `4` NSO.

### Design decisions

- **One collector, two runtimes.** `src/collector.js` holds all the behaviour and is given a store, a way
  to open a socket and a `waitUntil`; `tracker.js` supplies the Cloudflare versions and `server.js` the Node
  ones. There is no second implementation to keep in step during the migration.
- **One Durable Object, no database.** 24 hours of PS4 kills is small. The object holds it in memory and
  writes a gzipped snapshot in chunks to its own storage, so a restart loses about a minute. D1, KV, R2 and
  Queues are deliberately not used.
- **One object for both servers.** Free-plan duration is 13,000 GB-s per day; one always-on object uses about
  11,000. A second object would exceed it.
- **History is a rolling window**, not an archive.
- **The live board charts the player count, not kills per hour.** Kill rate is already in the boards and the
  KPM column. The population comes from the `PlayerLogin` and `PlayerLogout` events Daybreak publishes:
  `state.online` is the set of characters currently logged in, anyone seen in a kill event is added to it
  (their login may predate the tracker), and the collector records one sample per world per minute into
  `state.pop`. A session running more than 18 hours is treated as a logout that was missed and swept out.
  Characters already online when the tracker started are not counted until their next login, so the count can
  read low, never high, and the page says so.
- **Samples outlive the event log.** A sample is six numbers a minute per world, so a week of them costs far
  less than an hour of events: `state.pop` is kept for 7 days while the log stays at `RETAIN_HOURS`. That is
  what lets the chart zoom out past the board's own window. The chart defaults to the last 2 hours and offers
  6h, 24h and 7d; longer ranges are averaged into at most 180 points. Clicking an empire in the legend lists
  who the tracker has seen online there.
- **Servers are configuration** in `src/config.js`.
- **Untrusted data stays at the edges.** Stream frames are parsed defensively, Census IDs are validated as
  digit strings before they enter a query, API parameters are allow-listed, the browser builds DOM with
  `textContent` only, and a strict CSP is set on every page.
- **Images load directly from Census** in the visitor's browser (faction emblems and weapon icons), so they
  cost the site no requests.
- **The map** draws Census hex geometry over the official terrain tiles from
  [ps2alerts/assets](https://github.com/ps2alerts/assets) (MIT; used with the developers' permission, per the
  owner). Ownership is polled every 2 minutes and updated live from `FacilityControl`. Fights are estimated:
  kills only carry a continent, so they are placed at bases where a participant was seen capturing or
  defending in the last 15 minutes.
- **Map details:** styled after the in-game map, with filters named like the in-game panel (terrain, facilities,
  facility connections, territory control, hotspots, influence cloud, grid, plus region borders, names and players
  seen). Territory and lattice use PS2Alerts' map colours and opacities (tints at 40% opacity) over untouched terrain, so
  roads, buildings and relief stay readable at every zoom; thin black region borders, the lattice and icons carry the
  contrast. The **influence cloud** is the territory blurred into a small bitmap once per ownership change and glows
  only outside the playable hexes, so it never tints the terrain. **Battle bubbles** are short orange puffs on a canvas over the map: a fight's puff rate follows the
  server's measured heat at that base, but individual puffs are not individual kills and their spread around the base
  is decorative. **Cut-off** territory (not linked to its empire's warpgate through its own lattice, computed from
  ownership and `facility_link`) is dimmed. While zooming or panning, the heavy layer (terrain, territory, grid, cloud)
  is only moved by a GPU transform and redrawn once the view settles, as Leaflet does on PS2Alerts; the lattice,
  icons and names sit in a light overlay that follows every frame. A drag glides to a stop; arrow keys pan and +/- zoom. Base icons are original glyphs, not game art (rule 10).
  Hex geometry is adapted from Honu (MIT,
  `src/map/LedgerModels.ts`). Clicking a region shows its owner, the outfit that captured it (only for flips seen
  since tracking started), combat in the last 10 minutes and recent captures. Player counts are distinct characters
  seen in events at that base, shown as a floor ("8+ seen"). Daybreak does not publish per-base populations and
  players who are only present never appear in its data, so these are never presented as the in-game figures.

Target architecture: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Limits, risks and deployment:
[`docs/DEPLOY.md`](docs/DEPLOY.md). Census API notes:
[`docs/research/census-api.md`](docs/research/census-api.md).

## Credits

Data from the Daybreak Census API. MIT licence. Asset credits and licences ship in `public/maps/NOTICE.txt`.
The site is branded Warpside; `warpside2.com` is its domain. The site has no disclaimer footer.
