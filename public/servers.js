// Server picker rules, kept free of the DOM so they can be tested under Node.

/** An API from before PC support sends no platform; every server it knew was PlayStation. */
export function normaliseServers(servers) {
  return servers.map((s) => ({ ...s, platform: s.platform || 'ps4', platformName: s.platformName || 'PlayStation' }));
}

/** Platforms in the order the API lists their first server: [[key, name], ...]. */
export function platformsOf(servers) {
  return [...new Map(servers.map((s) => [s.platform, s.platformName])).entries()];
}

/**
 * The server to show after switching to `platform`: the one last picked there if it still exists,
 * otherwise the platform's first server. A stored id never selects a server on another platform.
 */
export function worldForPlatform(servers, platform, saved) {
  const own = servers.filter((s) => s.platform === platform);
  return (own.find((s) => s.id === Number(saved)) || own[0])?.id ?? null;
}
