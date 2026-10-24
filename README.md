# Warpside Simplified

Live PlanetSide 2 leaderboards for the PS4 servers **Genudine** (US) and **Ceres** (EU): top players and outfits
by empire, kills per hour over a rolling 24-hour window, and a live continent map with territory, base captures
and estimated fights.

It runs entirely on Cloudflare's free tier: one Worker serves the page and the API, and one Durable Object
collects the kill stream and keeps the last 24 hours. No database, no server to maintain, no runtime
dependencies.

> The earlier, much larger Postgres-based design is archived at
> [Arizes/warpside](https://github.com/Arizes/warpside). This project started from
> [Arizes/ps2-stats-tracker](https://github.com/Arizes/ps2-stats-tracker).

## Run it locally

Requires Node 22+.

```sh
npm install
npm run assets                   # map tiles and sounds (about 120 MB, not in git); dev and deploy also run it
cp .dev.vars.example .dev.vars   # add your CENSUS_SERVICE_ID (free: https://census.daybreakgames.com/#devSignup)
npm run dev                      # http://localhost:8787
npm test
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
| `src/worker.js` | Entry point: routes `/api/*` and `/health` to the Tracker, cron safety net |
| `src/tracker.js` | The Durable Object: stream connections, state, snapshots, keep-alive alarm |
| `src/stream.js` | Stream URL, subscription message and message parsing |
| `src/ingest.js` | Applies a parsed record to the state |
| `src/census.js` | Batched, cached, backed-off Census lookups |
| `src/store.js` | Event log, pruning, compressed chunked snapshots |
| `src/stats.js` | Leaderboards, outfits, faction split, hourly history, player detail |
| `src/map.js` | Map state: ownership, base presence, fight detection, captures |
| `public/map.js` | The map view: tiles, hex territories, lattice, fight markers, zoom sounds |
| `scripts/fetch-map-assets.mjs` | Downloads map tiles and sounds from ps2alerts/assets at a pinned commit |
| `src/api.js` | Routes, validation, short response memo |
| `src/config.js` | Server list (add a world here), windows, env |
| `public/` | The dashboard (plain HTML, CSS, ES modules) and `_headers` (CSP) |

API (all `GET`): `/api/stats?world=1000&window=24h`, `/api/player?world=1000&id=<characterId>&window=24h`,
`/api/map?world=1000[&zone=2]`, `/api/map-static?world=1000&zone=2`, `/api/servers`, `/health`. Windows are `1h`, `6h`, `24h`.

### Design decisions

- **One Durable Object, no database.** 24 hours of PS4 kills is small. The object holds it in memory and
  writes a gzipped snapshot in chunks to its own storage, so a restart loses about a minute. D1, KV, R2 and
  Queues are deliberately not used.
- **One object for both servers.** Free-plan duration is 13,000 GB-s per day; one always-on object uses about
  11,000. A second object would exceed it.
- **History is a rolling window**, not an archive.
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
- **Map details:** styled after the in-game map, with toggles inspired by Honu (terrain, territory, region borders,
  hex grid, lattice, bases, names, battles, players seen). Hex geometry is adapted from Honu (MIT,
  `src/map/LedgerModels.ts`). Clicking a region shows its owner, the outfit that captured it (only for flips seen
  since tracking started), combat in the last 10 minutes and recent captures. Player counts are distinct characters
  seen in events at that base, shown in the in-game brackets (1–12 … 96+) and labelled as a lower bound.

Limits, risks and deployment: [`docs/DEPLOY.md`](docs/DEPLOY.md). Census API notes:
[`docs/research/census-api.md`](docs/research/census-api.md).

## Credits

Data from the Daybreak Census API. Warpside is a fan project, not affiliated with or endorsed by Daybreak
Games. MIT licence.
