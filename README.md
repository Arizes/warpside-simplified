# Warpside

Live PlanetSide 2 stats for the PS4 servers **Genudine** (US) and **Ceres** (EU):

- top players and outfits by empire, over the last 1, 6 or 24 hours
- players online per empire, charted over up to 7 days
- a live continent map with territory, base captures and estimated fights
- the busiest Sunderer and Router spawn points right now

Data comes from Daybreak's public [Census API](https://census.daybreakgames.com/) and event stream. There is
no database and no runtime dependency: one collector keeps the last 24 hours in memory and serves a small
JSON API to a plain HTML/JS front end.

## Quick start

Requires Node 22+ and a free Census service ID ([sign up here](https://census.daybreakgames.com/#devSignup)).

```sh
npm install
npm run assets          # downloads map tiles and sounds (~120 MB, not in git)
cp .env.example .env    # set CENSUS_SERVICE_ID
npm run dev:node        # http://localhost:8080, reloads on change
npm test
```

Leaderboards start empty and fill as kills arrive.

The collector can run in two ways, sharing the same code (`src/collector.js`):

| Runtime | Command | Config file |
|---|---|---|
| Node / Docker | `npm start` or `docker compose up --build` | `.env` |
| Cloudflare Worker + Durable Object | `npm run dev` (via Wrangler) | `.dev.vars` |

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `CENSUS_SERVICE_ID` | `example` | Your Census service ID. `example` is limited to 10 requests/min. Keep it secret. |
| `PORT` | `8080` | HTTP port (Node) |
| `DATA_DIR` | `./data` | Where snapshots are written (Node) |
| `RETAIN_HOURS` | `24` | How much kill history to keep |

## How it works

```
Daybreak event stream ──WebSocket──▶ collector
  (deaths, logins, captures)           ├─ parses events            src/stream.js, src/ingest.js
Census REST ◀── batched lookups ───────┤─ keeps a rolling log      src/store.js
  (names, weapons, outfits)            ├─ snapshots it every ~60 s
                                       └─ answers /api/*           src/api.js, src/stats.js
Browser ──▶ public/ (static page) ──▶ /api/*
```

| Path | What it does |
|---|---|
| `src/collector.js` | Core logic, independent of runtime |
| `src/server.js`, `src/node-store.js` | Node entry point and file-based snapshots |
| `src/worker.js`, `src/tracker.js` | Cloudflare entry point and Durable Object wrapper |
| `src/stream.js`, `src/ingest.js` | Event-stream subscription, parsing and applying events |
| `src/census.js` | Batched, cached Census lookups with backoff |
| `src/store.js` | Event log, pruning, compressed snapshots |
| `src/stats.js` | Leaderboards, outfits, faction split, population, player detail |
| `src/map.js` | Territory, captures, fight detection |
| `src/spawns.js` | Spawn-point ranking |
| `src/config.js` | Tracked servers and time windows |
| `public/` | The front end (plain HTML, CSS, ES modules) |
| `scripts/fetch-map-assets.mjs` | Downloads map assets |

### API

All endpoints are `GET` and return JSON.

| Endpoint | Parameters |
|---|---|
| `/api/stats` | `world`, `window` (`1h`, `6h`, `24h`) |
| `/api/player` | `world`, `id` (character ID), `window` |
| `/api/population` | `world`, `range` (`2h`, `6h`, `24h`, `7d`) |
| `/api/online` | `world`, `empire` (`0` all, `1` VS, `2` NC, `3` TR, `4` NSO) |
| `/api/map` | `world`, optional `zone` |
| `/api/map-static` | `world`, `zone` |
| `/api/servers` | none |
| `/health` | none |

`world` is `1000` (Genudine) or `2000` (Ceres).

### Design notes

- **Rolling window, not an archive.** Kills older than `RETAIN_HOURS` are dropped. Population samples are
  tiny, so they're kept for 7 days.
- **Servers are configuration.** Add a world to `SERVERS` in `src/config.js`; there's no per-server code.
- **Untrusted input stays at the edges.** Stream frames and Census responses are parsed defensively, IDs are
  validated before they reach a query, API parameters are allow-listed, the browser builds DOM with
  `textContent` only, and a strict CSP is applied.
- **Counts are observed, not official.** Online players and per-base counts are derived from events Daybreak
  publishes, so they're a close estimate rather than the in-game figure. Fight locations on the map are
  inferred from recent captures and defences.

More detail: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/DEPLOY.md`](docs/DEPLOY.md),
[`docs/research/census-api.md`](docs/research/census-api.md), [`docs/research/spawns.md`](docs/research/spawns.md).

## Contributing

Issues and pull requests are welcome. Please run `npm test` before opening a PR; tests never call the real
Census API or stream.

## Credits

- Data from the Daybreak Census API. Warpside is a fan project and is not affiliated with Daybreak Games.
- Map tiles and sounds from [ps2alerts/assets](https://github.com/ps2alerts/assets) (MIT).
- Hex geometry adapted from [Honu](https://github.com/varunda/honu) (MIT).
- Started from [ps2-stats-tracker](https://github.com/Arizes/ps2-stats-tracker).

Asset credits and licences ship in `public/maps/NOTICE.txt`.

## Licence

[MIT](LICENSE)
