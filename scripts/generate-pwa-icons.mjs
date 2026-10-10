#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// Renders the One Connect PWA icons (two linked rounded rings on teal) without any dependency.
// Deterministic: re-running produces identical files. Usage: node scripts/generate-pwa-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'web', 'public', 'icons');
const TEAL = [8, 126, 139], WHITE = [255, 255, 255];

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// Signed distance to a rounded rectangle centred at (cx, cy).
const rr = (px, py, cx, cy, hw, hh, r) => { const qx = Math.abs(px - cx) - hw + r, qy = Math.abs(py - cy) - hh + r; return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r; };

/** Glyph coverage at glyph-space point (gx, gy) in the 28x28 brand box. */
function glyph(gx, gy) {
  const a = (-35 * Math.PI) / 180, c = Math.cos(-a), s = Math.sin(-a);
  const x = gx - 14, y = gy - 14, rx = x * c - y * s + 14, ry = x * s + y * c + 14;
  const ring = (cx, cy) => Math.abs(rr(rx, ry, cx, cy, 8.5, 6, 6)) <= 1.5;
  return ring(10.5, 9) || ring(17.5, 19);
}

function render(size, { rounded, glyphScale }) {
  const out = Buffer.alloc(size * size * 4);
  const SS = 3, radius = size * 0.22, box = 28 * glyphScale, off = (size - box) / 2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const px = x + (sx + 0.5) / SS, py = y + (sy + 0.5) / SS;
      const inside = !rounded || rr(px, py, size / 2, size / 2, size / 2, size / 2, radius) <= 0;
      if (!inside) continue;
      const white = glyph((px - off) / glyphScale, (py - off) / glyphScale);
      const col = white ? WHITE : TEAL;
      r += col[0]; g += col[1]; b += col[2]; a += 255;
    }
    const n = SS * SS, i = (y * size + x) * 4;
    const cover = a / (255 * n);
    out[i] = cover ? Math.round(r / (cover * n)) : 0; out[i + 1] = cover ? Math.round(g / (cover * n)) : 0; out[i + 2] = cover ? Math.round(b / (cover * n)) : 0; out[i + 3] = Math.round(cover * 255);
  }
  return out;
}

fs.mkdirSync(OUT, { recursive: true });
const files = [
  ['icon-192.png', 192, { rounded: true, glyphScale: (192 * 0.62) / 28 }],
  ['icon-512.png', 512, { rounded: true, glyphScale: (512 * 0.62) / 28 }],
  // Maskable icons must keep the glyph inside the central 80% safe zone and fill the square.
  ['icon-maskable-512.png', 512, { rounded: false, glyphScale: (512 * 0.5) / 28 }],
  ['apple-touch-icon.png', 180, { rounded: false, glyphScale: (180 * 0.56) / 28 }],
];
for (const [name, size, o] of files) fs.writeFileSync(path.join(OUT, name), png(size, render(size, o)));
console.log(`wrote ${files.length} icons to ${path.relative(process.cwd(), OUT)}`);
