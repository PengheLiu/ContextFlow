import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';
import { join } from 'node:path';
import { loadTrayIcon, renderTrayTemplate, TRAY_TEMPLATE_SVG } from '../desktop/tray-icon.mjs';

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function pngChunk(name, data) {
  const type = Buffer.from(name), size = Buffer.alloc(4), crc = Buffer.alloc(4);
  size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([size, type, data, crc]);
}
function decode(png) {
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const chunks = [], names = []; let width, height, density, offset = 8;
  while (offset < png.length) {
    assert.ok(offset + 12 <= png.length, 'PNG chunk header/trailer is truncated');
    const length = png.readUInt32BE(offset), name = png.toString('ascii', offset + 4, offset + 8), data = png.subarray(offset + 8, offset + 8 + length);
    assert.ok(offset + length + 12 <= png.length, 'PNG chunk exceeds the file');
    assert.equal(png.readUInt32BE(offset + 8 + length), crc32(png.subarray(offset + 4, offset + 8 + length)), `${name} CRC mismatch`);
    names.push(name);
    if (name === 'IHDR') {
      assert.equal(length, 13); width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      assert.ok(width > 0 && width <= 32 && height > 0 && height <= 32, 'Template dimensions must be bounded');
      assert.deepEqual([...data.subarray(8)], [8, 6, 0, 0, 0], 'Template must be noninterlaced 8-bit RGBA with standard compression/filter methods');
    }
    if (name === 'IDAT') chunks.push(data);
    if (name === 'pHYs') { assert.equal(length, 9); density = { x: data.readUInt32BE(0), y: data.readUInt32BE(4), units: data[8] }; }
    if (name === 'IEND') assert.equal(length, 0);
    offset += 12 + length;
  }
  assert.deepEqual(names, ['IHDR', 'pHYs', 'IDAT', 'IEND'], 'Template chunk order and cardinality must remain valid');
  const rows = inflateSync(Buffer.concat(chunks)); assert.equal(rows.length, height * (width * 4 + 1));
  const pixels = [];
  for (let y = 0; y < height; y++) { assert.equal(rows[y * (width * 4 + 1)], 0); for (let x = 0; x < width; x++) pixels.push([...rows.subarray(y * (width * 4 + 1) + 1 + x * 4, y * (width * 4 + 1) + 5 + x * 4)]); }
  return { width, height, pixels, density };
}
function nativeFixture({ failBuffer = false, failPath = false, omitRetina = false } = {}) {
  const images = [], calls = [];
  const image = (size, empty = false) => {
    const scales = [1], value = {
      empty, template: false, isEmpty: () => empty, getSize: () => ({ width: size, height: size }),
      addRepresentation: spec => { calls.push(['representation', spec]); if (!omitRetina) scales.push(spec.scaleFactor); },
      getScaleFactors: () => scales, setTemplateImage: flag => { value.template = flag; }, isTemplateImage: () => value.template,
    }; images.push(value); return value;
  };
  return { images, calls, nativeImage: {
    createFromBuffer: (bytes, options) => { calls.push(['buffer', bytes, options]); return image(16, failBuffer); },
    createFromPath: path => { calls.push(['path', path]); return image(128, failPath); },
  } };
}
const readTemplate = path => renderTrayTemplate(path.endsWith('@2x.png') ? 32 : 16);

test('dedicated template assets are deterministic black/alpha masks at 72dpi and 144dpi', () => {
  assert.equal(readFileSync(new URL('../assets/trayTemplate.svg', import.meta.url), 'utf8'), TRAY_TEMPLATE_SVG);
  for (const [name, size, dpi] of [['trayTemplate.png', 16, 72], ['trayTemplate@2x.png', 32, 144]]) {
    const png = readFileSync(new URL(`../assets/${name}`, import.meta.url)), generated = renderTrayTemplate(size);
    // zlib versions may encode identical RGBA rows as different valid IDAT
    // streams. Compare every decoded pixel and metadata field, not compression.
    assert.deepEqual(generated, renderTrayTemplate(size), 'Generation must remain deterministic in one runtime');
    const result = decode(png); assert.deepEqual(result, decode(generated));
    assert.equal(result.width, size); assert.equal(result.height, size);
    assert.equal(result.density.units, 1); assert.equal(result.density.x, Math.round(dpi / 0.0254)); assert.equal(result.density.y, result.density.x);
    for (const [red, green, blue] of result.pixels) assert.deepEqual([red, green, blue], [0, 0, 0]);
    const visible = result.pixels.filter(pixel => pixel[3] > 0); assert.ok(visible.length > size * size * 0.2); assert.ok(visible.length < size * size * 0.8);
    assert.ok(result.pixels.some(pixel => pixel[3] === 255)); assert.ok(result.pixels.some(pixel => pixel[3] > 0 && pixel[3] < 255)); assert.equal(result.pixels[0][3], 0);
  }
  assert.throws(() => renderTrayTemplate(128), /16px or 32px/);
});
test('template identity follows exact pixels and density across legal PNG compression streams', () => {
  for (const size of [16, 32]) {
    const png = renderTrayTemplate(size), dataAt = png.indexOf(Buffer.from('IDAT')), length = png.readUInt32BE(dataAt - 4);
    const rows = inflateSync(png.subarray(dataAt + 4, dataAt + 4 + length));
    const repack = raw => Buffer.concat([png.subarray(0, dataAt - 4), pngChunk('IDAT', deflateSync(raw, { level: 0 })), png.subarray(dataAt + 8 + length)]);
    const alternative = repack(rows);
    assert.notDeepEqual(alternative, png, 'Fixture must exercise a different compression stream');
    assert.deepEqual(decode(alternative), decode(png));
    const altered = Buffer.from(rows); altered[4] = altered[4] === 255 ? 254 : 255;
    assert.notDeepEqual(decode(repack(altered)), decode(png), 'Even a one-pixel alpha change must remain detectable');
  }
});
test('template validation rejects corrupt CRCs, truncated chunks and extra trailing bytes', () => {
  const png = renderTrayTemplate(16), corrupt = Buffer.from(png), dataAt = corrupt.indexOf(Buffer.from('IDAT'));
  corrupt[dataAt + 4] ^= 1;
  assert.throws(() => decode(corrupt), /IDAT CRC mismatch/);
  assert.throws(() => decode(png.subarray(0, png.length - 1)), /truncated|exceeds/);
  assert.throws(() => decode(Buffer.concat([png, Buffer.from([0])])), /truncated/);
  const oversized = Buffer.from(png); oversized.writeUInt32BE(0xffffffff, 8);
  assert.throws(() => decode(oversized), /exceeds/);
});
test('macOS loader preserves explicit 1x and 2x representations, validates and marks template', () => {
  const f = nativeFixture(), reads = [], warnings = [];
  const image = loadTrayIcon({ nativeImage: f.nativeImage, platform: 'darwin', directory: '/app/ui', readFile: path => { reads.push(path); return readTemplate(path); }, warn: message => warnings.push(message) });
  assert.deepEqual(reads, [join('/app/ui', 'trayTemplate.png'), join('/app/ui', 'trayTemplate@2x.png')]);
  assert.equal(image.isEmpty(), false); assert.equal(image.isTemplateImage(), true); assert.deepEqual(image.getScaleFactors(), [1, 2]);
  assert.deepEqual(f.calls[0][2], { scaleFactor: 1 });
  const retina = f.calls.find(call => call[0] === 'representation')[1]; assert.equal(retina.scaleFactor, 2);
  assert.equal(decode(Buffer.from(retina.dataURL.split(',')[1], 'base64')).width, 32); assert.deepEqual(warnings, []);
});
test('missing or malformed macOS resources use an independently generated safe template', () => {
  for (const readFile of [() => { throw new Error('ENOENT /private/resource'); }, () => Buffer.from('broken'), () => renderTrayTemplate(32)]) {
    const f = nativeFixture(), warnings = [];
    const image = loadTrayIcon({ nativeImage: f.nativeImage, platform: 'darwin', readFile, warn: message => warnings.push(message) });
    assert.equal(image.isEmpty(), false); assert.equal(image.isTemplateImage(), true); assert.deepEqual(image.getScaleFactors(), [1, 2]);
    assert.equal(warnings.length, 1); assert.ok(!warnings[0].includes('/private/'));
  }
});
test('native empty images and missing Retina representations never silently create a blank tray', () => {
  for (const options of [{ failBuffer: true }, { omitRetina: true }]) {
    const f = nativeFixture(options);
    assert.throws(() => loadTrayIcon({ nativeImage: f.nativeImage, platform: 'darwin', readFile: readTemplate }), error => error.code === 'TRAY_ICON_UNAVAILABLE');
  }
});
test('Windows uses the normal brand PNG without template, fallback mask or forced 1x resize', () => {
  const f = nativeFixture(); let reads = 0;
  const image = loadTrayIcon({ nativeImage: f.nativeImage, platform: 'win32', directory: 'app-ui', readFile: () => { reads++; throw new Error('must not read template'); } });
  assert.equal(image.isTemplateImage(), false); assert.equal(image.getSize().width, 128); assert.equal(reads, 0);
  assert.deepEqual(f.calls, [['path', join('app-ui', 'icon.png')]]);
  assert.throws(() => loadTrayIcon({ nativeImage: nativeFixture({ failPath: true }).nativeImage, platform: 'win32' }), error => error.code === 'TRAY_ICON_UNAVAILABLE');
});
test('loader has no Electron import and preparation packages the specific template pair', () => {
  const helper = readFileSync(new URL('../desktop/tray-icon.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(helper, /from ['"]electron['"]|import\(['"]electron['"]\)/);
  const prepare = readFileSync(new URL('../tools/prepare-desktop.mjs', import.meta.url), 'utf8');
  assert.match(prepare, /trayTemplate\.png/); assert.match(prepare, /trayTemplate@2x\.png/); assert.match(prepare, /prepareTrayAssets\(\)/);
});
