// -----------------------------------------------------------------------------
// Generates cover.png (800×534, the store size): a dark-to-amber gradient, a
// boiler seen from the front with its touch display (a curve and a few
// values) and a flame in its window, next to a pile of pellets. Plain Node
// (zlib), no dependency.
// Run: npm run cover
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const WIDTH = 800;
const HEIGHT = 534;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.min(1, Math.max(0, t))));
const smooth = (edge, distance) => Math.min(1, Math.max(0, edge - distance + 0.5));

const DARK = [24, 14, 10];
const AMBER = [150, 70, 20];
const BODY = [236, 236, 232];
const SCREEN = [22, 34, 48];
const GREEN = [90, 200, 120];
const FLAME = [255, 150, 30];
const CORE = [255, 230, 120];
const PELLET = [176, 128, 70];

/** Distance from a point to a rounded rectangle (negative inside). */
function roundedBox(x, y, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(x - cx) - halfW + radius;
  const qy = Math.abs(y - cy) - halfH + radius;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** The colour of one pixel. */
function pixel(x, y) {
  let color = mix(DARK, AMBER, (x / WIDTH) * 0.5 + (y / HEIGHT) * 0.5);
  // The boiler body.
  const body = roundedBox(x, y, 300, 280, 150, 210, 18);
  color = mix(color, mix(BODY, [200, 200, 196], (x - 150) / 300), smooth(0, body));
  // The touch display: a dark screen, a curve and three value bars.
  const screen = roundedBox(x, y, 300, 160, 110, 62, 8);
  color = mix(color, SCREEN, smooth(0, screen));
  if (screen < -4) {
    const curve = 170 - 30 * Math.sin((x - 190) / 35) - (x - 190) * 0.12;
    color = mix(color, GREEN, smooth(3, Math.abs(y - curve)));
    for (let i = 0; i < 3; i += 1) {
      const bar = roundedBox(x, y, 345 + i * 18, 200 - i * 6, 6, 8 + i * 6, 2);
      color = mix(color, i === 1 ? FLAME : [120, 170, 220], smooth(0, bar));
    }
  }
  // The window with the flame.
  const window = roundedBox(x, y, 300, 350, 70, 70, 35);
  color = mix(color, [40, 24, 18], smooth(0, window));
  if (window < -2) {
    const fx = (x - 300) / 40;
    const fy = (y - 395) / 70;
    const flame = Math.hypot(fx * (1.4 + fy * 0.9), fy) - 0.9;
    color = mix(color, FLAME, smooth(0, flame * 40));
    color = mix(color, CORE, smooth(0, (flame + 0.45) * 40));
  }
  // The base.
  color = mix(color, [90, 90, 92], smooth(0, roundedBox(x, y, 300, 478, 140, 8, 4)));
  // A pile of pellets, right.
  for (let i = 0; i < 26; i += 1) {
    const row = i < 9 ? 0 : i < 16 ? 1 : i < 21 ? 2 : i < 24 ? 3 : 4;
    const start = [0, 9, 16, 21, 24][row];
    const px = 600 + (i - start - ([9, 7, 5, 3, 2][row] - 1) / 2) * 26;
    const py = 470 - row * 20;
    const pellet = roundedBox(x, y, px, py, 12, 8, 7);
    color = mix(color, mix(PELLET, [120, 84, 44], (y - py + 8) / 16), smooth(0, pellet));
  }
  color = mix(color, GREEN, smooth(4, Math.hypot(x - 420, y - 100)));
  return color;
}

const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
for (let y = 0; y < HEIGHT; y += 1) {
  const row = y * (WIDTH * 3 + 1);
  raw[row] = 0;
  for (let x = 0; x < WIDTH; x += 1) {
    const [r, g, b] = pixel(x, y);
    raw.set([r, g, b], row + 1 + x * 3);
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(WIDTH, 0);
header.writeUInt32BE(HEIGHT, 4);
header[8] = 8; // bit depth
header[9] = 2; // RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../cover.png', import.meta.url), png);
console.log(`cover.png: ${WIDTH}×${HEIGHT}, ${png.length} bytes`);
