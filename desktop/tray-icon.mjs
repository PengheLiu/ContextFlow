// The main process injects Electron's nativeImage. Keeping Electron out of this
// module lets normal Node tests verify assets, fallback and Retina behavior.
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), 'ui');
const STROKE = 1.8;
const SEGMENTS = [[1.7, 3.5, 10.5, 3.5], [1.7, 8, 13, 8], [1.7, 12.5, 8.5, 12.5], [10.5, 5.5, 13.5, 8], [13.5, 8, 10.5, 10.5]];
export const TRAY_TEMPLATE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#000" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round">\n${SEGMENTS.map(([x1, y1, x2, y2]) => `  <path d="M${x1} ${y1} ${x2} ${y2}"/>`).join('\n')}\n</svg>\n`;

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let n = 0; n < 8; n++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(name, data) {
  const type = Buffer.from(name), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, checksum]);
}
function distanceToSegment(x, y, [x1, y1, x2, y2]) {
  const dx = x2 - x1, dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - x1 - t * dx, y - y1 - t * dy);
}

/** A deterministic black/alpha mask; never depends on browser or SVG support. */
export function renderTrayTemplate(size = 16) {
  if (![16, 32].includes(size)) throw new Error('Tray templates must be 16px or 32px.');
  const scale = size / 16, samples = 8, rowBytes = size * 4 + 1;
  const rgba = Buffer.alloc(rowBytes * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let covered = 0;
    for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++) {
      const px = (x + (sx + 0.5) / samples) / scale, py = (y + (sy + 0.5) / samples) / scale;
      if (SEGMENTS.some(segment => distanceToSegment(px, py, segment) <= STROKE / 2)) covered++;
    }
    // RGB remains black for transparent and visible pixels. Only alpha varies.
    rgba[y * rowBytes + 1 + x * 4 + 3] = Math.round(255 * covered / (samples * samples));
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  const density = Buffer.alloc(9), ppm = Math.round((size === 16 ? 72 : 144) / 0.0254);
  density.writeUInt32BE(ppm, 0); density.writeUInt32BE(ppm, 4); density[8] = 1;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('pHYs', density), chunk('IDAT', deflateSync(rgba)), chunk('IEND', Buffer.alloc(0))]);
}

function validate(image) {
  if (!image || typeof image.isEmpty !== 'function' || image.isEmpty()) throw new Error('Empty tray image');
  const size = image.getSize();
  if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) throw new Error('Invalid tray image size');
  return image;
}
function templateImage(nativeImage, standard, retina) {
  for (const [bytes, expected] of [[standard, 16], [retina, 32]]) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || bytes.readUInt32BE(16) !== expected || bytes.readUInt32BE(20) !== expected) throw new Error('Invalid tray template representation');
  }
  const image = validate(nativeImage.createFromBuffer(standard, { scaleFactor: 1 }));
  image.addRepresentation({ scaleFactor: 2, dataURL: `data:image/png;base64,${retina.toString('base64')}` });
  validate(image);
  if (typeof image.getScaleFactors === 'function' && !image.getScaleFactors().includes(2)) throw new Error('Retina tray representation missing');
  image.setTemplateImage(true);
  if (typeof image.isTemplateImage === 'function' && !image.isTemplateImage()) throw new Error('Template tray image was not marked');
  return image;
}

/**
 * @returns {NativeImage} macOS: dedicated 16pt template with a 32px @2x
 * representation. Other platforms: the normal full-color brand PNG.
 * `warn` receives a static non-sensitive message if generated fallback is used.
 */
export function loadTrayIcon({ nativeImage, platform = process.platform, directory = DEFAULT_DIRECTORY, readFile = readFileSync, warn = () => {} } = {}) {
  if (!nativeImage) throw new TypeError('nativeImage is required');
  if (platform !== 'darwin') {
    try { return validate(nativeImage.createFromPath(join(directory, 'icon.png'))); }
    catch { throw Object.assign(new Error('无法加载 ContextFlow 托盘图标，请重新安装应用。'), { code: 'TRAY_ICON_UNAVAILABLE' }); }
  }
  try {
    return templateImage(nativeImage, readFile(join(directory, 'trayTemplate.png')), readFile(join(directory, 'trayTemplate@2x.png')));
  } catch {
    warn('菜单栏模板资源不可用，已改用内置黑色透明模板。');
    try { return templateImage(nativeImage, renderTrayTemplate(16), renderTrayTemplate(32)); }
    catch { throw Object.assign(new Error('无法创建 ContextFlow 菜单栏图标，请重新安装应用。'), { code: 'TRAY_ICON_UNAVAILABLE' }); }
  }
}
