import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LIGHT, DARK, FONTS, RADII, themeCSS } from '../src/core/design-tokens.js';
import { BASE, T } from '../src/skill/theme.js';
import { checkDesignTokens, surfaces, synchronizedSource, generatedBlock, canvasPins, synchronizedCanvas } from '../tools/design-tokens.mjs';

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function luminance(hex) {
  const channels = hex.replace('#', '').match(/../g).map(value => parseInt(value, 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}
function contrast(a, b) { const values = [luminance(a), luminance(b)].sort((x, y) => y - x); return (values[0] + .05) / (values[1] + .05); }

test('Every static surface is generated from the same canonical paper/ink/orange source', () => {
  assert.equal(surfaces.length, 5);
  checkDesignTokens();
  for (const surface of surfaces) {
    assert.ok(source(surface.path).includes(generatedBlock(surface)), surface.path);
    assert.equal(synchronizedSource(source(surface.path), surface), source(surface.path), 'generation is idempotent');
    const windows = source(surface.path).replaceAll('\n', '\r\n');
    assert.equal(synchronizedSource(windows, surface), windows, 'CRLF checkouts have the same tokens without rewriting line endings');
    const changed = source(surface.path).replace('--cf-accent:#a6530e', '--cf-accent:#000000');
    assert.notEqual(synchronizedSource(changed, surface), changed, 'manual drift is rejected');
  }
});
test('Native startup canvas and website toolbar metadata cannot drift from shared paper', () => {
  assert.equal(canvasPins.length, 3);
  for (const pin of canvasPins) {
    assert.equal(synchronizedCanvas(source(pin.path), pin), source(pin.path));
    const altered = source(pin.path).replace(pin.pattern, (_match, before, _color, after) => before + '#000000' + after);
    assert.notEqual(synchronizedCanvas(altered, pin), altered);
  }
});
test('Shadow UI consumes canonical variables without changing page-driven dark mode', () => {
  assert.ok(BASE.includes(themeCSS(':host', { systemDark: true })));
  assert.match(BASE, /:host\(\[data-theme=dark\]\)/);
  assert.match(BASE, /:host\(:not\(\[data-theme=light\]\)\)/);
  assert.doesNotMatch(BASE, /:host\[data-theme/);
  assert.equal(T.sans, FONTS.sans); assert.equal(T.serif, FONTS.serif); assert.equal(T.radius, RADII.card);
  assert.deepEqual(Object.keys(LIGHT), Object.keys(DARK));
  assert.ok(Object.isFrozen(LIGHT) && Object.isFrozen(DARK));
  assert.match(source('desktop/ui/renderer.js'), /dataset\.theme\s*=\s*['"]light['"]/);
});
test('Body, secondary text, status labels and primary buttons meet AA contrast in both tones', () => {
  for (const [tone, tokens] of Object.entries({ light: LIGHT, dark: DARK })) {
    for (const surface of ['paper', 'paper-raised', 'sunk']) {
      for (const text of ['ink', 'ink-soft', 'quote', 'placeholder', 'accent']) {
        assert.ok(contrast(tokens[surface], tokens[text]) >= 4.5, `${tone}: ${text} on ${surface}`);
      }
    }
    for (const surface of ['accent', 'accent-hover']) {
      assert.ok(contrast(tokens[surface], tokens['on-accent']) >= 4.5, `${tone}: primary ${surface}`);
    }
    for (const state of ['ok', 'bad', 'warning']) {
      assert.ok(contrast(tokens[state], tokens[`${state}-soft`]) >= 4.5, `${tone}: ${state}`);
      assert.notEqual(tokens[state], tokens.accent, 'status is not brand colour');
    }
    assert.ok(contrast(tokens['focus-line'], tokens.paper) >= 3, `${tone}: focus indicator`);
  }
});
test('Build gates reject stale static tokens and do not introduce runtime CSS imports or fonts', () => {
  for (const path of ['tools/build.mjs', 'tools/build-website.mjs', 'tools/prepare-desktop.mjs']) {
    assert.match(source(path), /checkDesignTokens\(\)/, path);
  }
  for (const surface of surfaces) assert.doesNotMatch(generatedBlock(surface), /@import|https?:\/\//);
});
