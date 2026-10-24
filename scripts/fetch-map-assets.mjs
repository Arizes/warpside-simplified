// Downloads the continent map tiles and map sounds from ps2alerts/assets (MIT) into public/.
// They are not committed to git: run `npm run assets` once after cloning, and before deploying.
// Usage: node scripts/fetch-map-assets.mjs [--lods=2,3,4]
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMIT = '60df8bdb3ebc61c08147abc7f41d64bc5cd73e06'; // pinned: update deliberately
const RAW = `https://raw.githubusercontent.com/ps2alerts/assets/${COMMIT}/assets`;
// Census zone id -> folder in ps2alerts/assets (Oshur has several map versions; 1.2 is the current one).
const ZONES = { 2: 'indar/1.0', 4: 'hossin/1.0', 6: 'amerish/1.0', 8: 'esamir/1.0', 344: 'oshur/1.2' };
const SOUNDS = { 'map-zoom-in.wav': 'audio/UI_INTERFACE_MAP_ZOOM_IN.wav', 'map-zoom-out.wav': 'audio/UI_INTERFACE_MAP_ZOOM_OUT.wav' };
const NOTICE = `Continent map tiles and map sounds from https://github.com/ps2alerts/assets (commit ${COMMIT}).

MIT License
Copyright (c) 2022 PS2Alerts

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

PlanetSide 2 artwork is the property of Daybreak Games Company LLC. Used with permission.
`;

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const lods = (process.argv.find((a) => a.startsWith('--lods='))?.slice(7) || '2,3,4').split(',').map(Number);

async function download(url, file) {
  try {
    await fs.access(file);
    return false; // already there
  } catch {
    /* fetch it */
  }
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(url);
    if (r.ok) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, Buffer.from(await r.arrayBuffer()));
      return true;
    }
    if (attempt >= 3) throw new Error(`${r.status} for ${url}`);
    await new Promise((res) => setTimeout(res, 1000 * attempt));
  }
}

const jobs = [];
for (const [zone, dir] of Object.entries(ZONES)) {
  for (const lod of lods) {
    const n = 2 ** lod; // tiles per side at this level
    for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) {
      jobs.push([`${RAW}/zones/${dir}/${lod}/tile_${x}_${y}.png`, path.join(root, 'maps', zone, String(lod), `${x}_${y}.png`)]);
    }
  }
}
for (const [name, src] of Object.entries(SOUNDS)) jobs.push([`${RAW}/${src}`, path.join(root, 'audio', name)]);

let done = 0;
let fetched = 0;
const worker = async () => {
  while (jobs.length) {
    const [url, file] = jobs.pop();
    if (await download(url, file)) fetched++;
    if (++done % 200 === 0) console.log(`${done} files checked`);
  }
};
await Promise.all(Array.from({ length: 8 }, worker));
await fs.writeFile(path.join(root, 'maps', 'NOTICE.txt'), NOTICE);
console.log(`map assets ready: ${fetched} downloaded, ${done - fetched} already present (levels ${lods.join(', ')})`);
