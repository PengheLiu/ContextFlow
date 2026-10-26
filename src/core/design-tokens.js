// ContextFlow's paper / ink / burnt-orange visual system.
// Shared by injected Shadow UI and generated static styles. Brand is not status:
// green means success, red means error; neither is a navigation/CTA colour.
export const FONTS = Object.freeze({
  sans: '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif',
  serif: 'Georgia,"Songti SC","Noto Serif CJK SC",serif',
  mono: 'ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono",monospace',
});
export const RADII = Object.freeze({ control: '7px', card: '10px', panel: '14px' });
const common = {
  ...Object.fromEntries(Object.entries(FONTS).map(([key, value]) => [`font-${key}`, value])),
  ...Object.fromEntries(Object.entries(RADII).map(([key, value]) => [`radius-${key}`, value])),
  'inverse-paper': '#302c27', 'inverse-ink': '#f3ede3', 'inverse-muted': '#c8bdad',
  'inverse-line': '#554d43', 'inverse-accent': '#e1a05f',
};
export const LIGHT = Object.freeze({
  ...common,
  paper: '#fbfaf7', 'paper-raised': '#fffefa',
  sunk: '#f4f1eb', 'sunk-hover': '#ece7de',
  line: '#dcd5ca', 'line-soft': '#ebe6de', 'line-strong': '#bdb3a4',
  ink: '#24211d', 'ink-soft': '#4e4840', quote: '#655e55', placeholder: '#71695f',
  accent: '#a6530e', 'accent-hover': '#87410b', 'on-accent': '#fffefa',
  'accent-soft': 'rgba(166,83,14,.16)', 'accent-wash': 'rgba(166,83,14,.085)',
  blue: '#496f9f', 'blue-soft': 'rgba(73,111,159,.12)',
  ok: '#356f3f', 'ok-soft': '#edf5ee', 'ok-line': '#c6dccb',
  bad: '#a8322a', 'bad-soft': '#fff4f1', 'bad-line': '#e7c9c2',
  warning: '#7d5a16', 'warning-soft': '#fff6de', 'warning-line': '#e7d7aa',
  'focus-line': '#bc7332', 'focus-ring': 'rgba(166,83,14,.17)', hover: 'rgba(54,45,35,.065)',
  'shadow-float': '0 1px 2px rgba(28,26,23,.06),0 18px 44px -16px rgba(28,26,23,.28)',
  'shadow-panel': '-18px 0 48px -26px rgba(28,26,23,.34)',
  'shadow-control': '0 6px 20px -8px rgba(28,26,23,.30)',
  scroll: '#c9c0b3', 'scroll-hover': '#aea393', grain: 'rgba(72,59,45,.035)',
});
export const DARK = Object.freeze({
  ...common,
  paper: '#302c27', 'paper-raised': '#39342e',
  sunk: '#292621', 'sunk-hover': '#403a33',
  line: '#554d43', 'line-soft': '#423c35', 'line-strong': '#746959',
  ink: '#f3ede3', 'ink-soft': '#ddd4c7', quote: '#c8bdad', placeholder: '#aaa091',
  accent: '#e1a05f', 'accent-hover': '#edb77f', 'on-accent': '#292621',
  'accent-soft': 'rgba(225,160,95,.22)', 'accent-wash': 'rgba(225,160,95,.105)',
  blue: '#8fb4e2', 'blue-soft': 'rgba(143,180,226,.14)',
  ok: '#8bc596', 'ok-soft': '#293b2d', 'ok-line': '#4d7257',
  bad: '#f09a91', 'bad-soft': '#442d29', 'bad-line': '#88534b',
  warning: '#e3bf77', 'warning-soft': '#403622', 'warning-line': '#7c6843',
  'focus-line': '#dda05f', 'focus-ring': 'rgba(225,160,95,.22)', hover: 'rgba(255,247,235,.075)',
  'shadow-float': '0 1px 2px rgba(0,0,0,.24),0 20px 50px -15px rgba(0,0,0,.56)',
  'shadow-panel': '-18px 0 48px -22px rgba(0,0,0,.56)',
  'shadow-control': '0 8px 24px -8px rgba(0,0,0,.54)',
  scroll: '#62594d', 'scroll-hover': '#7a7061', grain: 'rgba(255,244,227,.025)',
});
const HIGH_CONTRAST = {
  light: { quote: '#514a41', placeholder: '#5c554d', line: '#b6ac9d' },
  dark: { quote: '#e4dbcf', placeholder: '#cfc4b4', line: '#7b7162' },
};
export function declarations(tokens) {
  return Object.entries(tokens).map(([key, value]) => `--cf-${key}:${value};`).join('');
}
// A surface makes its tone policy explicit. The website/desktop stay light;
// options can follow the OS; injected UI sets data-theme from the page canvas.
export function themeCSS(selector, { systemDark = false } = {}) {
  const dark = selector === ':host' ? ':host([data-theme=dark])' : `${selector}[data-theme=dark]`;
  const auto = selector === ':host' ? ':host(:not([data-theme=light]))' : `${selector}:not([data-theme=light])`;
  return `${selector}{color-scheme:light;${declarations(LIGHT)}}\n` +
    `${dark}{color-scheme:dark;${declarations(DARK)}}\n` +
    (systemDark ? `@media(prefers-color-scheme:dark){${auto}{color-scheme:dark;${declarations(DARK)}}}\n` : '') +
    `@media(prefers-contrast:more){${selector}{${declarations(HIGH_CONTRAST.light)}}${dark}{${declarations(HIGH_CONTRAST.dark)}}}\n` +
    (systemDark ? `@media(prefers-color-scheme:dark) and (prefers-contrast:more){${auto}{${declarations(HIGH_CONTRAST.dark)}}}\n` : '');
}
export function rootThemeCSS(options) { return themeCSS(':root', options); }
