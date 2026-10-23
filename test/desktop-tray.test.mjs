import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join } from 'node:path';
import { loadTrayIcon, renderTrayTemplate, TRAY_TEMPLATE_SVG } from '../desktop/tray-icon.mjs';

function decode(png) {
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20), chunks = []; let density, offset = 8;
  assert.equal(png[24], 8); assert.equal(png[25], 6);
  while (offset < png.length) {
    const length = png.readUInt32BE(offset), name = png.toString('ascii', offset + 4, offset + 8), data = png.subarray(offset + 8, offset + 8 + length);
    if (name === 'IDAT') chunks.push(data); if (name === 'pHYs') density = { x: data.readUInt32BE(0), y: data.readUInt32BE(4), units: data[8] };
    offset += 12 + length;
  }
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
    const png = readFileSync(new URL(`../assets/${name}`, import.meta.url)); assert.deepEqual(png, renderTrayTemplate(size));
    const result = decode(png); assert.equal(result.width, size); assert.equal(result.height, size);
    assert.equal(result.density.units, 1); assert.equal(result.density.x, Math.round(dpi / 0.0254)); assert.equal(result.density.y, result.density.x);
    for (const [red, green, blue] of result.pixels) assert.deepEqual([red, green, blue], [0, 0, 0]);
    const visible = result.pixels.filter(pixel => pixel[3] > 0); assert.ok(visible.length > size * size * 0.2); assert.ok(visible.length < size * size * 0.8);
    assert.ok(result.pixels.some(pixel => pixel[3] === 255)); assert.ok(result.pixels.some(pixel => pixel[3] > 0 && pixel[3] < 255)); assert.equal(result.pixels[0][3], 0);
  }
  assert.throws(() => renderTrayTemplate(128), /16px or 32px/);
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
