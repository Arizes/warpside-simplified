# Warpside: project instructions

Live PlanetSide 2 leaderboards (Genudine, Ceres) with a rolling 24-hour history. One Node process, no
database, one runtime dependency. See `README.md` for the architecture.

## Scope guard

The project is deliberately small. Do not add a database, queue, build step, framework, accounts, or
long-term storage without the owner's explicit approval. Anything beyond live leaderboards, player stats and
24-hour history is out of scope.

Ask before: adding a runtime dependency, adding a new external data source or service, changing the CSP or
other security headers, or increasing request volume to Census.

## Rules

1. Never invent Census capabilities. Rely on what `docs/research/census-api.md` marks verified; verify live
   and record the evidence before depending on anything else.
2. All external data is untrusted: stream frames, Census responses and query parameters. Validate at the
   edge; never interpolate unvalidated values into a Census URL.
3. Character, item and outfit IDs are strings (64-bit). Never convert to `number`.
4. Servers are configuration (`SERVERS` in `src/config.js`); no per-server branches.
5. The service ID comes from the environment only and is never logged, committed or sent to the browser.
6. In the browser, build DOM with `textContent`; no `innerHTML`, `eval` or inline scripts/styles (CSP).
7. Only Honu (MIT) code may be adapted. Do not copy PS2Alerts (GPL-3.0) or LivePlanetmans (no licence).
8. Do not bundle extracted game files. Images come from Census image paths.
9. Comments explain why, not what. No model names or AI attribution in code comments.
10. Stage files by explicit path; never `git add -A` or `git commit -a`.

## Commands

| Command | |
|---|---|
| `npm run dev` | Run with reload (reads `.env`) |
| `npm test` | Unit tests (`node --test`, no network) |
| `npm start` | Production start |

Tests never call the real Census or stream. Behind a proxy, run Node with `NODE_USE_ENV_PROXY=1`.

## Definition of done

Behaviour is covered by a test, `npm test` passes, `npm audit --omit=dev` is clean, and the README or
`docs/` are updated if behaviour or setup changed.
