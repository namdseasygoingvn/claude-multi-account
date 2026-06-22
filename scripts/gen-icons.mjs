// Generates the menu-bar tray icons + the app icon as real PNGs (and Windows
// .ico files), with tiny dependency-free PNG + ICO encoders (zlib is built in).
// Run: node scripts/gen-icons.mjs
//   assets/trayTemplate.png      16x16  — macOS template image (alpha only)
//   assets/trayTemplate@2x.png   32x32
//   assets/icon.png              512x512 — app/dmg icon (macOS)
//   assets/icon.ico              16–256  — app/installer icon (Windows; NSIS needs 256²)
//   assets/tray.ico              16–32   — colored Windows tray icon (not a template)
//   assets/tray.png              32x32   — colored Linux tray icon
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ASSETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');
fs.mkdirSync(ASSETS, { recursive: true });

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(CRC(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** rgba: Uint8 array length w*h*4 → PNG buffer (color type 6, 8-bit). */
function encodePng(rgba, w, h) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // 10,11,12 = compression/filter/interlace = 0
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy
      ? rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, y * w * 4 + w * 4)
      : Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/** Pack PNG-encoded images into a single .ico (PNG-in-ICO, supported by Windows
 *  Vista+ and electron-builder). entries: [{ size, png }]. */
function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size; // width (0 ⇒ 256)
    dir[o + 1] = e.size >= 256 ? 0 : e.size; // height (0 ⇒ 256)
    // [o+2] colorCount=0, [o+3] reserved=0
    dir.writeUInt16LE(1, o + 4); // color planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel
    dir.writeUInt32LE(e.png.length, o + 8); // bytes in image data
    dir.writeUInt32LE(offset, o + 12); // offset to image data
    offset += e.png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

/** RGBA buffer for an orange rounded square with a dark gauge, at any size. */
function appIcon(size) {
  return drawGauge(size, { bg: [0xf9, 0x9c, 0x24], ring: [20, 20, 22, 255], needle: [20, 20, 22, 255], rounded: true });
}

function px(buf, w, x, y, r, g, b, a) {
  const i = (y * w + x) * 4;
  buf[i] = r;
  buf[i + 1] = g;
  buf[i + 2] = b;
  buf[i + 3] = a;
}

// A gauge ring with a needle — recognizable at 16px.
function drawGauge(w, { ring, bg, needle, rounded }) {
  const buf = Buffer.alloc(w * w * 4);
  const cx = w / 2 - 0.5;
  const cy = w / 2 - 0.5;
  const outer = w * 0.42;
  const inner = w * 0.26;
  const radius = w * 0.18; // rounded-rect corner radius for bg
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      // optional rounded-square background
      if (bg) {
        const ix = Math.min(x, w - 1 - x);
        const iy = Math.min(y, w - 1 - y);
        let inside = true;
        if (ix < radius && iy < radius) {
          const dx = radius - ix;
          const dy = radius - iy;
          inside = dx * dx + dy * dy <= radius * radius;
        }
        if (inside) px(buf, w, x, y, bg[0], bg[1], bg[2], 255);
      }
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      // gauge ring (open at the bottom for a speedometer look)
      const ang = Math.atan2(dy, dx); // -pi..pi, downward = +pi/2
      const openBottom = ang > Math.PI * 0.30 && ang < Math.PI * 0.70;
      if (d <= outer && d >= inner && !openBottom) {
        px(buf, w, x, y, ring[0], ring[1], ring[2], ring[3] ?? 255);
      }
      // needle pointing up-right
      if (needle) {
        const nx = dx;
        const ny = dy;
        const len = Math.sqrt(nx * nx + ny * ny);
        if (len <= inner + 1) {
          const targetAng = -Math.PI * 0.25;
          const a2 = Math.atan2(ny, nx);
          if (Math.abs(((a2 - targetAng + Math.PI * 3) % (Math.PI * 2)) - Math.PI) > Math.PI - 0.32) {
            px(buf, w, x, y, needle[0], needle[1], needle[2], needle[3] ?? 255);
          }
        }
      }
    }
  }
  return buf;
}

// Tray: black, alpha-only (macOS tints template images per theme).
for (const [name, size] of [['trayTemplate.png', 16], ['trayTemplate@2x.png', 32]]) {
  const buf = drawGauge(size, { ring: [0, 0, 0, 255], needle: [0, 0, 0, 255] });
  fs.writeFileSync(path.join(ASSETS, name), encodePng(buf, size, size));
  console.log('wrote', name);
}

// App icon (macOS .dmg / dev): orange rounded square with a dark gauge.
fs.writeFileSync(path.join(ASSETS, 'icon.png'), encodePng(appIcon(512), 512, 512));
console.log('wrote icon.png');

// Windows app/installer icon. electron-builder's NSIS target needs a 256² entry.
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const appEntries = icoSizes.map((s) => ({ size: s, png: encodePng(appIcon(s), s, s) }));
fs.writeFileSync(path.join(ASSETS, 'icon.ico'), encodeIco(appEntries));
console.log('wrote icon.ico');

// Colored tray icon for Windows/Linux (template images render invisible there).
const trayEntries = [16, 24, 32].map((s) => ({ size: s, png: encodePng(appIcon(s), s, s) }));
fs.writeFileSync(path.join(ASSETS, 'tray.ico'), encodeIco(trayEntries));
console.log('wrote tray.ico');
fs.writeFileSync(path.join(ASSETS, 'tray.png'), encodePng(appIcon(32), 32, 32));
console.log('wrote tray.png');
