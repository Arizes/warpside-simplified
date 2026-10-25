// Pure helpers for the map view. No DOM access, so they are unit tested under Node (test/map-logic.test.js).

export const WARPGATE = 7;
const SUFFIX = { 2: 'Amp Station', 16: 'Amp Station', 3: 'Bio Lab', 4: 'Tech Plant' };

/**
 * Regions an empire owns that its lattice no longer connects to one of its warpgates. The in-game map dims
 * these. Derived only from published data (ownership and facility_link). An empire with no warpgate on the
 * continent (locked, or geometry missing) is never marked, because there is nothing to be cut off from.
 */
export function cutOffRegions(regions, links, owners) {
  const byFac = {};
  for (const [rid, r] of Object.entries(regions)) if (r.fac) byFac[r.fac] = rid;
  const adj = {};
  for (const [a, b] of links) {
    const ra = byFac[a];
    const rb = byFac[b];
    if (!ra || !rb) continue;
    (adj[ra] ||= []).push(rb);
    (adj[rb] ||= []).push(ra);
  }
  const own = (rid) => {
    const f = owners[rid] ?? 0;
    return f >= 1 && f <= 3 ? f : 0;
  };
  const reached = new Set();
  const hasGate = new Set();
  const queue = [];
  for (const [rid, r] of Object.entries(regions)) {
    if (r.t !== WARPGATE || !own(rid)) continue;
    hasGate.add(own(rid));
    reached.add(rid);
    queue.push(rid);
  }
  while (queue.length) {
    const rid = queue.pop();
    for (const next of adj[rid] || []) {
      if (reached.has(next) || own(next) !== own(rid)) continue;
      reached.add(next);
      queue.push(next);
    }
  }
  const out = new Set();
  for (const [rid, r] of Object.entries(regions)) if (r.fac && own(rid) && hasGate.has(own(rid)) && !reached.has(rid)) out.add(rid);
  return out;
}

/**
 * How strongly a fight reads on the map, 0..1, from the server's heat (recency-weighted kills and flips at
 * the base). Absolute rather than relative to the busiest fight, so a quiet continent does not look busy.
 */
export const intensity = (heat) => Math.min(1, Math.sqrt(Math.max(0, Number(heat) || 0)) / 8);

/**
 * Battle-bubble puffs per second for a fight. It visualises the measured activity level; individual
 * puffs are not individual kills and their positions are not real (Daybreak publishes no kill positions).
 */
export const puffRate = (heat) => Math.min(6, Math.max(0.6, 0.9 * Math.sqrt(Math.max(0, Number(heat) || 0))));

/** Base label lines like the in-game map: "Naum" + type becomes ["Naum Amp", "Station"]. */
export function labelLines(name, type) {
  let text = String(name || '').trim();
  const suffix = SUFFIX[type];
  if (suffix && text && !text.toLowerCase().includes(suffix.toLowerCase().split(' ')[0])) text = `${text} ${suffix}`;
  if (text.length <= 14) return [text];
  const words = text.split(' ');
  if (words.length < 2) return [text];
  let best = null;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ');
    const b = words.slice(i).join(' ');
    const cost = Math.max(a.length, b.length);
    if (!best || cost < best[0]) best = [cost, a, b];
  }
  return [best[1], best[2]];
}

/** Bounding box [minX, minY, maxX, maxY] of a set of points, padded by `pad`. */
export function bounds(points, pad = 0) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of points) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return Number.isFinite(x0) ? [x0 - pad, y0 - pad, x1 + pad, y1 + pad] : null;
}

/**
 * The CSS transform that makes a layer rendered with viewBox `drawn` line up with viewBox `view`, for an
 * SVG of `w` x `h` pixels with the default centred "meet" fit. Used to move the heavy map layer on the
 * compositor while zooming instead of re-rendering it every frame. Returns { s, tx, ty } (scale, pixels).
 */
export function layerShift(drawn, view, w, h) {
  const k = Math.min(w / view[2], h / view[3]);
  const kd = Math.min(w / drawn[2], h / drawn[3]) || k;
  const s = k / kd;
  const tx = (w - view[2] * k) / 2 - view[0] * k - s * ((w - drawn[2] * kd) / 2 - drawn[0] * kd);
  const ty = (h - view[3] * k) / 2 - view[1] * k - s * ((h - drawn[3] * kd) / 2 - drawn[1] * kd);
  return { s, tx, ty };
}

/** Animation progress 0..1. A frame's timestamp can predate the start; unclamped, the first frame ran backwards. */
export const progress = (now, start, ms) => Math.min(1, Math.max(0, (now - start) / ms));
