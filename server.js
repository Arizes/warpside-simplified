// Warpside: one process that collects PS4 kill events and serves the leaderboards.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVERS, loadConfig } from './src/config.js';
import { createLookups } from './src/census.js';
import { createHandler } from './src/http.js';
import { connectStream } from './src/stream.js';
import { loadState, prune, saveState } from './src/store.js';

const config = loadConfig();
const root = path.dirname(fileURLToPath(import.meta.url));
const stateFile = path.join(config.dataDir, 'state.json');

const state = loadState(stateFile);
prune(state, Date.now(), config.retainMs);
console.log(`loaded ${state.events.length} events`);

const status = {}; // env -> 'connected' | 'reconnecting'
const feed = {}; // world -> Daybreak event server up?
const lookups = createLookups({ serviceId: config.serviceId, state });
setInterval(() => lookups.flush(), 3000);

function onRecord(r) {
  if (r.kind === 'feed') return Object.assign(feed, r.feeds);
  if (r.kind === 'login') {
    state.online[r.id] = r.ts;
    return lookups.requestCharacter(r.world, r.id);
  }
  if (r.kind === 'logout') return void delete state.online[r.id];
  const [, world, attacker, victim, weapon] = r.event;
  state.events.push(r.event);
  lookups.request(world, { attacker, victim, weapon });
}

// One connection per streaming environment, covering every configured world in it.
const byEnv = {};
for (const [world, s] of Object.entries(SERVERS)) (byEnv[s.env] ||= []).push(Number(world));
for (const [env, worlds] of Object.entries(byEnv)) {
  connectStream({ env, worlds, serviceId: config.serviceId, servers: SERVERS, onRecord, status });
}

async function persist() {
  prune(state, Date.now(), config.retainMs);
  try {
    await saveState(stateFile, state);
  } catch (err) {
    console.error('save failed:', err.message);
  }
}
setInterval(persist, 60e3);

const handler = createHandler({ state, config, status, feed, publicDir: path.join(root, 'public') });
const server = http.createServer((req, res) => {
  handler(req, res).catch((err) => {
    console.error('request failed:', err.message);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});
server.listen(config.port, () => console.log('listening on', config.port));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    await persist();
    process.exit(0);
  });
}
