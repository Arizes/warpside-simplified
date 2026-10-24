# PlanetSide 2 Data Ecosystem — Research Notes

_Last updated: 2026-10-24. Carried over from the earlier, larger design; the verification script and
fixtures were removed with it. The live tracker uses only the event stream (§2) and the `character`,
`item` and image lookups in §1. The lifetime-stats, history-bucket and weapon-stat collections described
here are not used and are kept for reference only._

**Verified 2026-10-24 on `ps2ps4us`:** `Death`, `PlayerLogin` and `PlayerLogout` arrive with
`characters:["all"]`; `serviceStateChanged.detail` names several endpoints in one string, for example
`EventServerEndpoint_1000_Genudine_1001_Palos_1002_Crux_1003_Searhus_1004_Xelas` (world id first).

Tags:

- **[V-live]**: confirmed against the live API or its official documentation page.
- **[V-lib]**: confirmed only in maintained community source code (`ps2census` v4.9.3, Honu).
- **[U]**: unverified. **Must not be depended on** until verified.

## 1. Daybreak Census REST API (primary source)

- URL: `https://census.daybreakgames.com/s:{serviceId}/{get|count}/{namespace}/{collection}?{query}`. **[V-live]**
- Warpside's service ID is registered (no IP restriction). It lives only in `.env`. **[V-live]**
- `s:example` is "throttled to 10 requests per minute per client IP address" (official docs).
  Requests **without** any service ID still returned data on 2026-10-23, but the docs say they
  "may be completely blocked in the future", so we always send ours. Limits for registered IDs
  are not published. **[V-live]**
- **`c:start` paging returns 0 rows on filtered `character` queries** (it works on `item`).
  Use one large page (`c:limit` up to 5,000) and split by time window if a page fills up. **[V-live]**
- Query commands used and confirmed: `c:limit` (5,000 rows returned in one call), `c:show`,
  `c:join … ^inject_at ^show`, `c:sort`, `c:lang`; search modifiers `^` (starts with) and `]`
  (greater or equal). Other commands exist **[V-lib]**.
- Comma lists on an ID field work on `item`: `item?item_id=80,7214,999999999` returned the two
  known items; unknown IDs are left out, and a list of only unknown IDs returns
  `{"item_list":[],"returned":0}` with no error (both PS4 namespaces, 2026-10-23). **[V-live]**
- Read-only. No end-user authentication.

### Worlds in scope **[V-live]**

| World | ID | Namespace | ESS environment | Notes |
|---|---|---|---|---|
| Genudine | 1000 | `ps2ps4us:v2` | `ps2ps4us` | Only world in its namespace; 5,455,754 rows in `characters_world` |
| Ceres | 2000 | `ps2ps4eu:v2` | `ps2ps4eu` | Only world in its namespace |

World 1000 is **not** present in `ps2:v2`; each namespace is a separate dataset. The ESS
environment names are still **[V-lib]**.

### Collections verified on both PS4 namespaces **[V-live]**

| Need | Collection | Shape and notes |
|---|---|---|
| Lookup | `character` | `name.first`, `name.first_lower`, `faction_id`, `battle_rank.value`, `prestige_level`, `times.{creation,last_login,last_save}` (unix seconds and date strings), `times.minutes_played`, `certs.*` |
| Exact name | `character?name.first_lower=<lower>` | Exactly one result |
| Prefix search | `character_name?name.first_lower=^<prefix>` | Returns `character_id` + name; **no world**, so join `characters_world` or filter by namespace |
| Server | `characters_world` | `world_id`; joinable onto `character` |
| Outfit | `outfit_member_extended` (join) / `outfit` | `name`, `alias`, `member_count`. Names can carry trailing spaces, so trim them |
| Lifetime + period stats | `characters_stat` | One row per `stat_name` × `profile_id` (class: 0 = all, 1, 3, 4, 5, 6, 7), with `value_forever`, `value_monthly`, `value_weekly`, `value_daily`, `value_one_life_max`. Names: `achievement_count, assist_count, deaths, facility_defended_count, fire_count, hit_count, medal_count, play_time, score, skill_points, weapon_deaths, weapon_fire_count, weapon_hit_count, weapon_play_time, weapon_score` |
| History buckets | `characters_stat_history` | **`d01`/`w01`/`m01` = the period of the last save, not the calendar day** (`d01` matched today's `value_daily`; `last_save` was yesterday). Stats update on logout/save. `stat_name` ∈ `battle_rank, certs, deaths, facility_capture, facility_defend, kills, medals, ribbons, score, time`; `all_time`, `one_life_max`, `day.d01–d31`, `week.w01–w13`, `month.m01–m12`. `time` is in seconds |
| By victim faction | `characters_stat_by_faction` | `kills`, `killed_by`, `weapon_kills`, `weapon_headshots`, … as `value_forever_{vs,nc,tr}` etc. |
| Weapon counters | `characters_weapon_stat` | Per `item_id` × `vehicle_id`: `weapon_deaths, weapon_fire_count, weapon_hit_count, weapon_play_time, weapon_score` (about 1,700–2,200 rows for a veteran) |
| Weapon kills | `characters_weapon_stat_by_faction` | **Kills and headshots exist only here**, split `value_vs/nc/tr`, so sum all three. `item_id = 0` rows are **vehicle totals** keyed by `vehicle_id` (everything used from that vehicle, including roadkills: Sunderer 18,704 kills vs 15,603 summed over its weapon rows; corrected 2026-10-23). Rows with `vehicle_id ≠ 0` are vehicle weapons; infantry weapons have `vehicle_id = 0` |
| Online | `characters_online_status?character_id=` | `online_status` `"0"`/non-zero. A bare list query returns nothing, so always filter by ID |
| Recent events | `characters_event?type=DEATH,KILL` | Attacker, weapon, vehicle, zone, headshot flag, timestamp |
| Reference | `item`, `item_category`, `faction`, `experience_rank` | Names in all languages (use `c:lang=en`), `image_path` |

Not yet checked: `characters_event_grouped`, `leaderboard`, `world_event`, `vehicle`, and
how fresh the `value_daily` counters are (they appear to reset daily) **[U]**.

### Metric field mapping (PRD §5)

| Metric | Source |
|---|---|
| Kills, deaths, score, play time (lifetime) | `characters_stat_history.all_time` for `kills`, `deaths`, `score`, `time` (seconds) |
| Weekly/monthly figures | `characters_stat` `value_weekly` / `value_monthly` where the stat exists there (deaths, score, play_time). Kills per period: `characters_stat_by_faction` `kills` `value_{weekly,monthly}_{vs,nc,tr}` summed **[U: confirm equality with history]** |
| Weapon kills, HSR | `characters_weapon_stat_by_faction` `weapon_kills`, `weapon_headshots`, summed over vs/nc/tr |
| Accuracy | `characters_weapon_stat` `weapon_hit_count / weapon_fire_count` (per weapon, or summed over infantry weapons) |
| Weapon KPM | weapon kills / (`weapon_play_time` / 60) |

### Images **[V-live]**

The official docs list "Game Images: `/files/{game}/images/{type}/{image_id}.png`". Rows carry
`image_id` and `image_path`, and `https://census.daybreakgames.com{image_path}` returns
`image/png`:

| Asset | Source | Size |
|---|---|---|
| Faction emblems | `faction.image_path` (VS 94, NC 12, TR 18, NSO 93615) | 512×512, transparent |
| Weapon renders | `item.image_path` | 256×128, transparent |
| Rank insignia | `experience_rank.{vs,nc,tr}_image_path` | 128×128 |

**Caveat:** `experience_rank` returns several rows per rank (the normal insignia plus A.S.P.
variants) and no field identifies the prestige level. Which row to show for ASP 1–3 is **[U]**.

### Error behaviour **[V-live]**

Every failure is **HTTP 200**:

| Case | Body |
|---|---|
| Unknown collection **or unknown namespace** | `{"error":"No data found."}` |
| Invalid search term / malformed command | `{"errorCode":"SERVER_ERROR","errorMessage":"INVALID_SEARCH_TERM: …"}` |
| Unregistered service ID | `{"error":"Provided Service ID is not registered. …"}` |
| No match | `{"<collection>_list":[],"returned":0}` (not an error) |

### Performance **[V-live]**

20 sequential small requests: p50 111 ms, p95 1,062 ms. Heavy queries are much slower:
a sorted `character` query with two joins took 3.1 s on `ps2ps4us` and **timed out after
40 s** on `ps2ps4eu`. Avoid `c:sort` on large collections; use 10 s timeouts with a fallback.

### Data hygiene

- Character IDs are 19 digits (e.g. `5428352933373830017` becomes `…830000` as a JS number). **[V-live]**
- 5,000 sampled names all matched `^[A-Za-z0-9]{1,32}$` (longest 15). **[V-live]** The real
  maximum length is unknown, so keep 32 as the cap.
- Active characters (`times.last_login`), 1/7/30 days: Genudine 907/3,974/11,991; Ceres
  426/2,156/7,176. A one-page sweep of a day's actives takes 3.5–4.3 s. **[V-live]**
- Name search returns many abandoned 2015 characters. Exact match first, then prefix results
  ordered by recent login where possible.

## 2. Event Streaming Service (ESS) (post-MVP)

- `wss://push.planetside2.com/streaming?environment={ps2ps4us|ps2ps4eu}&service-id=s:{id}`
  connects; heartbeat every 30 s; `PlayerLogin`/`PlayerLogout` for worlds 1000/2000 observed. **[V-live]**
- Mirror `wss://push.nanite-systems.net/streaming`: same, with one heartbeat key per world. **[V-live]**
- `Death`/`GainExperience` not observed in a 75 s low-population capture. **[U]**
- Events: `AchievementEarned, BattleRankUp, ContinentLock, Death, FacilityControl, FishScan,
  GainExperience, ItemAdded, MetagameEvent, PlayerFacilityCapture, PlayerFacilityDefend,
  PlayerLogin, PlayerLogout, SkillAdded, VehicleDestroy` **[V-lib]**. PS4 coverage **[U]**.

## 3. Daybreak API Policy (summary of the official text, 2026-10-23) **[V-live]**

- Fan websites and apps are encouraged; they may show ads and charge for premium features.
- Only for EQ2, PS2, DCUO and MTGO. **Reverse engineering or circumventing the system "to gain
  access to data other than as expressly provided" is prohibited.** Assets extracted from the
  game client fall under this.
- Must not include content that infringes someone else's rights; content owned by others
  needs their permission.
- Don't share the service ID. Access can be terminated for non-compliance, **excessive
  requests**, or disrupting the games.
- Daybreak keeps all rights to its games, data and IP. A mobile app's title may not include a
  Daybreak game name or trademark. The site **must not suggest sponsorship, endorsement or
  association** with Daybreak.
- No warranty; the API or any data may change or disappear without notice.
- Contact: PS2 Data API forum, or `data-feedback@daybreakgames.com`.

## 4. Third-party sources (not used in v1)

| Source | What | Usable for PS4? |
|---|---|---|
| Sanctuary.Census | Census-compatible static and realtime data | **No**: rejects PS4 namespaces **[V-live]** |
| Saerro (`saerro.ps2.live/graphql`) | Live population | **Yes** for 1000/2000 **[V-live]** |
| "Planetside Files" Google Drive folder (owner-supplied link; owned by a third party) | About 22k PNGs, plus audio, models and a texture sheet; appears to be extracted from the game client | **Not used** (see §3 and DESIGN §3) |

## 5. Known risks

1. Census reliability: cache everything; serve stale data; validate every response.
2. Limited history (31 days / 13 weeks / 12 months), so Warpside keeps its own snapshots.
3. Unpublished rate limits, so we keep a self-imposed budget (ARCHITECTURE §7) and stay
   polite: termination for "excessive requests" is explicitly allowed.
4. 64-bit IDs as strings.
5. Slow heavy queries, especially on `ps2ps4eu`.

## 6. Open items

- [ ] Rank insignia for ASP characters (§1 Images caveat).
- [ ] Confirm per-period kills source (Metric mapping).
- [ ] ESS on `ps2ps4us`/`ps2ps4eu`: connect for 10 min and record events (post-MVP).

## Sources

- Census docs and API Policy: https://census.daybreakgames.com/
- ps2census on npm: https://www.npmjs.com/package/ps2census
- Honu: https://github.com/varunda/honu
- Saerro: https://github.com/genudine/saerro
- Sanctuary.Census: https://github.com/PS2Sanctuary/Sanctuary.Census
