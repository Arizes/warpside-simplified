// Runtime configuration. Servers are data: add an entry to track another world.
// `env` is the streaming environment, `ns` the Census REST namespace.
export const SERVERS = {
  1000: { name: 'Genudine', region: 'PS4 US', env: 'ps2ps4us', ns: 'ps2ps4us:v2' },
  2000: { name: 'Ceres', region: 'PS4 EU', env: 'ps2ps4eu', ns: 'ps2ps4eu:v2' },
};

// Windows the API will serve. The log never holds more than RETAIN_HOURS.
export const WINDOWS = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3 };

export function loadConfig(env = process.env) {
  const retainHours = Number(env.RETAIN_HOURS) || 24;
  return {
    serviceId: env.CENSUS_SERVICE_ID || 'example', // 'example' is limited to 10 req/min
    port: Number(env.PORT) || 8080,
    dataDir: env.DATA_DIR || './data',
    retainMs: retainHours * 3600e3,
  };
}
