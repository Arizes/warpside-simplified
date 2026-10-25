# Warpside Simplified: project instructions

Live PlanetSide 2 leaderboards (Genudine, Ceres) with a rolling 24-hour history. It currently runs on
Cloudflare's free tier (one Worker plus one Durable Object). See `README.md` for how it works now and
`docs/DEPLOY.md` for limits.

**Approved direction (owner, 2026-10-25):** backend API, event listener, background jobs and PostgreSQL move
to Railway (Hobby); Cloudflare keeps frontend, DNS, caching and security. Docker-compatible and portable.
`docs/ARCHITECTURE.md` is the plan; follow its phases and principles, and keep it current.

## Scope guard

The project is deliberately small. Approved by the owner: PostgreSQL on Railway, long-term history (raw events
plus rollups), backups, Docker packaging, and later player profiles, all as described in
`docs/ARCHITECTURE.md`. Still needs explicit approval: any other database or store, a queue or cache service
(Redis etc.), a third Railway service, a build step, a framework, user accounts, or an ORM.

Ask before: adding a runtime dependency (the Postgres driver `pg` is expected for phase 2), adding an external
data source or Cloudflare product, changing the CSP beyond the API origin in `ARCHITECTURE.md`, or increasing
Census request volume. Never run more than one replica of the backend (it would double-ingest events).

## Rules

1. Never invent Census capabilities. Rely on what `docs/research/census-api.md` marks verified; verify live
   and record the evidence before depending on anything else.
2. All external data is untrusted: stream frames, Census responses and query parameters. Validate at the
   edge; never interpolate unvalidated values into a Census URL.
3. Character, item and outfit IDs are strings (64-bit). Never convert to `number`.
4. Servers are configuration (`SERVERS` in `src/config.js`); no per-server branches.
5. The service ID is a secret (Worker secret or Railway variable; `.dev.vars` or `.env` locally). Never log
   it (do not log URLs that contain it), commit it, or send it to the browser. The same goes for
   `DATABASE_URL` and backup credentials.
6. In the browser, build DOM with `textContent`; no `innerHTML`, `eval` or inline scripts/styles (CSP).
7. Until migration phase 4 retires the Worker: keep `src/` free of Node-only imports except in the Node
   server entry point, and only `src/tracker.js` may import `cloudflare:workers`. Keep shared logic
   (`stream`, `ingest`, `stats`, `map`, `census`, `api`) runtime-neutral and free of provider-specific APIs.
8. In the Durable Object, do not use timer callbacks for network I/O (they have no I/O context); drive work
   from events and the alarm. (Does not apply to the Node server.)9. Only Honu (MIT) code may be adapted. Do not copy PS2Alerts application code (GPL-3.0) or LivePlanetmans
   (no licence). The separate `ps2alerts/assets` repository (MIT) is covered by rule 10.
10. Game art: the official continent map tiles and map sound effects from
    [`ps2alerts/assets`](https://github.com/ps2alerts/assets) (MIT) **may be used**. The owner stated on
    2026-10-24 that they have permission from the official developers to use them. They are downloaded by
    `npm run assets` from a pinned commit (never committed to git), and the MIT notice ships with them in
    `public/maps/NOTICE.txt`. Any other extracted game files still need the same kind of permission first.
    Icons and emblems load from Census image paths.
11. Comments explain why, not what. No model names or AI attribution in code comments.
12. Stage files by explicit path; never `git add -A` or `git commit -a`.
13. Never present data Daybreak does not publish as if it were real. Per-base populations are not published:
    the map shows distinct players *seen* in events as a floor ("8+ seen"), never as an in-game range such as
    "24–48". The same applies to fight positions (estimated) and capturing outfits (only flips seen live).
14. Database: plain PostgreSQL, no extensions, plain `.sql` migrations; IDs as `bigint`, read back as strings
    (rule 3); batched writes, never one insert per event; queries always parameterised.

## Commands

| Command | |
|---|---|
| `npm run dev` | Local Worker with a real Durable Object (reads `.dev.vars`) |
| `npm test` | Unit tests (`node --test`, no network) |
| `npm run deploy` | Deploy to Cloudflare |
| `npm run assets` | Download map tiles and sounds into `public/` (also runs before `dev` and `deploy`) |

Tests never call the real Census or stream. Map tiles and sounds are not in git: a fresh clone gets them from
`npm run assets`, which `predev` and `predeploy` run automatically; never deploy without them.

## Definition of done

Behaviour is covered by a test, `npm test` passes, `npm audit` is clean, and the README or `docs/` are
updated if behaviour, limits or setup changed. For changes to `src/tracker.js`, also run `npm run dev`
and confirm `/health` shows both streams connected and events arriving.
