// Runtime configuration. Servers are data: add an entry to track another world.
// `env` is the streaming environment, `ns` the Census REST namespace, `platform` groups the server
// picker. PC world ids were verified live on 2026-11-24 (docs/research/census-api.md). Jaeger (19) is
// left out: it is the private events server and was silent in the sample.
export const SERVERS = {
  1: { name: 'Osprey', region: 'PC US', platform: 'pc', env: 'ps2', ns: 'ps2:v2' },
  10: { name: 'Wainwright', region: 'PC EU', platform: 'pc', env: 'ps2', ns: 'ps2:v2' },
  40: { name: 'SolTech', region: 'PC Asia', platform: 'pc', env: 'ps2', ns: 'ps2:v2' },
  1000: { name: 'Genudine', region: 'PS4 US', platform: 'ps4', env: 'ps2ps4us', ns: 'ps2ps4us:v2' },
  2000: { name: 'Ceres', region: 'PS4 EU', platform: 'ps4', env: 'ps2ps4eu', ns: 'ps2ps4eu:v2' },
};

/** Display names for `platform`, in picker order. */
export const PLATFORMS = { pc: 'PC', ps4: 'PlayStation' };

// Windows the API will serve. The log never holds more than RETAIN_HOURS.
export const WINDOWS = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3 };

// Ranges the population chart will serve. Samples are a minute apart and far smaller than events,
// so they are kept for a week (see POP_RETAIN_MS in store.js) while the event log stays at 24 hours.
export const POP_RANGES = { '2h': 2 * 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3, '7d': 7 * 24 * 3600e3 };

/** Worker bindings arrive as strings; the service ID is a secret. */
export function loadConfig(env = {}) {
  return {
    serviceId: env.CENSUS_SERVICE_ID || 'example', // 'example' is limited to 10 req/min
    retainMs: (Number(env.RETAIN_HOURS) || 24) * 3600e3,
  };
}

/** Worlds grouped by streaming environment: one connection per environment. */
export function worldsByEnv(servers = SERVERS) {
  const byEnv = {};
  for (const [world, s] of Object.entries(servers)) (byEnv[s.env] ||= []).push(Number(world));
  return byEnv;
}
