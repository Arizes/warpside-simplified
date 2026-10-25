# Spawn activity evidence

Verified 2026-10-25. The feature uses the existing Daybreak Census/ESS source, not a third-party live feed.

## Event identity and counts

The [official ESS documentation](https://census.daybreakgames.com/#websocket-details) documents filtered subscriptions named
`GainExperience_experience_id_233` and `GainExperience_experience_id_1410`, with `characters:["all"]`.
Set `worlds` and `logicalAndCharactersWithWorlds:true` to restrict delivery to the configured world.
Its GainExperience schema provides `character_id`, `experience_id`, `other_id`, `loadout_id`, `amount`,
`timestamp`, `world_id`, `zone_id` and `team_id`; it has no facility or coordinate fields.

Live `experience?experience_id=56,201,233,355,1410,1988&c:limit=20` calls on both
[`ps2ps4us:v2`](https://census.daybreakgames.com/s:example/get/ps2ps4us:v2/experience?experience_id=56,201,233,355,1410,1988&c:limit=20)
and [`ps2ps4eu:v2`](https://census.daybreakgames.com/s:example/get/ps2ps4eu:v2/experience?experience_id=56,201,233,355,1410,1988&c:limit=20)
returned the same six definitions: Squad Spawn (56), Galaxy Spawn Bonus (201), Sunderer Spawn Bonus (233),
Squad Vehicle Spawn Bonus (355), Generic Npc Spawn (1410), and ANT Spawn Bonus (1988).
Static definitions establish names, not that every category currently arrives on the PS4 stream.

[Honu's event handler](https://github.com/varunda/honu/blob/master/Services/Realtime/Implementations/EventHandler.cs)
tracks individual spawn NPCs only for 233 (Sunderer) and 1410 (Router): `character_id` is the credited owner,
`other_id` is the NPC instance identifier, and each event increments its counter once. It does not count
XP `amount` as a spawn count. The separate squad bonus categories should not be added to those counters.
Use world and NPC identity together to avoid cross-world collisions.

## Availability and attribution

[Honu's model](https://github.com/varunda/honu/blob/master/Models/Watchtower/SpawnEntry.cs) explicitly states
that `FirstSeenAt` is the first observed spawn, not when the NPC was pulled. Its UI's deployment/lifespan
labels must therefore not be treated as evidence of actual deployment or destruction times.
[Honu's cleanup](https://github.com/varunda/honu/blob/master/Services/Hosted/EventCleanupService.cs) expires
NPCs after five minutes without activity; this is an inactivity heuristic, not proof of destruction.

Honu's [data builder](https://github.com/varunda/honu/blob/master/Services/Repositories/DataBuilderRepository.cs)
sets `SecondsAlive` to the difference between current UTC time and `FirstSeenAt`.
Its [table](https://github.com/varunda/honu/blob/master/src/view/watchtower/RealtimeData.vue) labels
`FirstSeenAt` as "Deployed at" and `SecondsAlive` as "Lifespan". This verifies an elapsed observation
timer is possible; it does not verify a deployment flag. Warpside displays this as "Observed lifespan",
alongside "First seen" and "Last spawn", and does not claim the NPC is currently deployed.

No base-spawn event, entity position stream, deployment event or instance-to-facility lookup was verified.
VehicleDestroy includes a facility, vehicle type and owner, but no instance identifier that safely joins
to the `other_id` spawn NPC. Owner capture/defend activity and territory control do not establish where
their deployed spawn is. Unknown locations must stay unknown; continent navigation is possible from
the spawn's own `zone_id`, but precise base-centering needs independent verified location evidence.

Resolving the credited owner's character through Census can identify their **current outfit**. This
does not establish historical membership at deployment or ownership by the faction controlling a base.
Do not substitute a capturing outfit or an unrelated player's outfit.

## Outfit imagery

Live outfit samples on both PS4 namespaces contained `outfit_id`, `name`, `alias`, creation time,
leader and member count, without a decal ID or image path. Adding `c:join=outfit_customization` returned
the same ordinary records with no joined data. Direct `outfit_customization?c:limit=1` calls returned
`{"error":"No data found."}` on both namespaces. This does not prove that no possible mapping exists,
but no official outfit-to-decal mapping was verified. Use existing official Census faction emblems
as fallbacks; do not infer a decal by matching an item name to an outfit name.
The live [US collection catalogue](https://census.daybreakgames.com/s:example/get/ps2ps4us:v2/) and
[EU catalogue](https://census.daybreakgames.com/s:example/get/ps2ps4eu:v2/) expose outfit, outfit_member,
outfit_member_extended and outfit_rank, with no published outfit customization/decal collection.

## Bounded live stream probe

A 55-second read-only probe against `push.planetside2.com` subscribed to the two filtered spawn
categories with the existing service ID. Both PS4 environments acknowledged the subscriptions.
Genudine delivered 15 Sunderer spawn events. Their payload keys were exactly `amount`, `character_id`,
`event_name`, `experience_id`, `loadout_id`, `other_id`, `timestamp`, `world_id`, `zone_id`.
No `team_id`, facility or coordinate was present in the sampled frames. Ceres delivered no spawn event
during this bounded interval, so its live delivery and Router delivery remain unobserved rather than
proven absent. Credentials remain in `.env` and are never included in evidence URLs or logs.

## Faction without team_id

Live [US loadouts](https://census.daybreakgames.com/s:example/get/ps2ps4us:v2/loadout?c:limit=100) and
[EU loadouts](https://census.daybreakgames.com/s:example/get/ps2ps4eu:v2/loadout?c:limit=100) returned
24 identical mappings, also matching [Honu's finite lookup](https://github.com/varunda/honu/blob/master/Code/Constants/Loadout.cs):

| Faction | Exact loadout IDs |
| --- | --- |
| VS (1) | 15, 17, 18, 19, 20, 21 |
| NC (2) | 1, 3, 4, 5, 6, 7 |
| TR (3) | 8, 10, 11, 12, 13, 14 |
| NSO (4) | 28, 29, 30, 31, 32, 45 |

Use exact IDs, not numeric ranges: gaps such as 2, 9 and 16 are not published loadouts in this response.
Unrecognised IDs stay unknown. NSO loadouts identify NSO, not the faction currently employing the owner;
without `team_id`, do not infer VS/NC/TR allegiance from territory control.
