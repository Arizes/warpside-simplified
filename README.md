# Warpside

Live PlanetSide 2 leaderboards for the PS4 servers **Genudine** (US) and **Ceres** (EU): top players, top
outfits, faction kills and kills per hour, over a rolling 24-hour window.

One small Node process does everything. It listens to Daybreak's event stream, keeps the last 24 hours of
kills in memory, and serves the dashboard and a tiny JSON API. No database, no build step, one runtime
dependency (`ws`).

## Run it

Requires Node 22+.

```sh
npm install
cp .env.example .env     # add your CENSUS_SERVICE_ID (free: https://census.daybreakgames.com/#devSignup)
npm run dev              # http://localhost:8080
npm test
```

Leaderboards start empty and fill as kills arrive; the 24-hour history builds up the longer it runs.

| Variable | Default | Meaning |
|---|---|---|
| `CENSUS_SERVICE_ID` | `example` | Your Census service ID. `example` is limited to 10 requests/min |
| `PORT` | `8080` | HTTP port |
| `DATA_DIR` | `./data` | Where `state.json` is saved (mount a volume here) |
| `RETAIN_HOURS` | `24` | History kept |

## How it works

```
Daybreak event stream ──ws──▶ src/stream.js ──▶ in-memory event log ──▶ src/stats.js ──▶ /api/*
        (Death, login/out)     parse + reconnect   (state.json every 60 s)   leaderboards     │
Census REST ◀── src/census.js (batched name / weapon / outfit lookups, cached)               ▼
                                                                                      public/ dashboard
```

| File | Job |
|---|---|
| `server.js` | Wires everything together, saves state, handles shutdown |
| `src/config.js` | Server list (add a world here), windows, env |
| `src/stream.js` | Event-stream connection (reconnect, watchdog) and message parsing |
| `src/census.js` | Batched, cached, backed-off Census lookups |
| `src/store.js` | Event log, pruning, atomic save/load |
| `src/stats.js` | Leaderboards, outfits, faction split, hourly history, player detail |
| `src/http.js` | Routes, validation, security headers, image proxy |
| `public/` | The dashboard (plain HTML, CSS, ES modules) |

API (all `GET`): `/api/stats?world=1000&window=24h`, `/api/player?world=1000&id=<characterId>&window=24h`,
`/api/servers`, `/health`. Windows are `1h`, `6h`, `24h`.

### Design decisions

- **Memory plus one JSON file.** 24 hours of PS4 kills is small, so a database would add cost and
  operations for no benefit. State is written atomically every minute and on shutdown; a restart loses at
  most a minute.
- **History is a rolling window, not an archive.** Nothing older than 24 hours is kept.
- **Servers are configuration.** Each entry in `SERVERS` carries its own Census namespace and stream
  environment.
- **Untrusted data stays at the edges.** Stream frames are parsed defensively, Census IDs are validated as
  digit strings before they enter a query, API parameters are allow-listed, the browser builds DOM with
  `textContent` only, and a strict CSP is set on every response.
- **Images come from Census.** Faction emblems and weapon icons are fetched from the Census image paths
  through `/img/*` (allow-listed paths, small in-memory cache). No game files are bundled.

Hosting: see [`docs/DEPLOY.md`](docs/DEPLOY.md). Census API notes: [`docs/research/census-api.md`](docs/research/census-api.md).

## Credits

Built on [`ps2-stats-tracker`](https://github.com/Arizes/ps2-stats-tracker). Data from the Daybreak Census
API. Warpside is a fan project, not affiliated with or endorsed by Daybreak Games. MIT licence.
