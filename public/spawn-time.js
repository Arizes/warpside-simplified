/** Elapsed time is evidence of observation, not a deployment/destruction event. */
export function spawnDuration(ms) {
  if (!Number.isFinite(ms)) return '—';
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h ? `${h}h ${m}m ${s}s` : m ? `${m}m ${s}s` : `${s}s`;
}

/** Anchor to the API clock so a viewer's incorrect wall clock cannot inflate the lifespan. */
export function spawnNow(clock, monotonicNow) {
  return clock.serverNow + Math.max(0, monotonicNow - clock.receivedAt);
}
