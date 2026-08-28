// ContextFlow 的界面图标统一使用同一套 24px、圆端点、1.8px 描边 SVG。
// 不再混用 ❓、⤢、×、✕ 等系统字符，避免字体与平台改变图标气质。
const PATHS = {
  close: '<path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5"/>',
  expand: '<path d="M9 4H4v5M15 4h5v5M20 15v5h-5M4 15v5h5"/><path d="m4 9 5-5m6 0 5 5m0 6-5 5M9 20l-5-5"/>',
  collapse: '<path d="M9 9H4M9 9V4M15 9h5M15 9V4M15 15h5M15 15v5M9 15H4M9 15v5"/>',
  settings: '<path d="M12 8.25A3.75 3.75 0 1 0 12 15.75 3.75 3.75 0 0 0 12 8.25Z"/><path d="M19.1 13.3a7.7 7.7 0 0 0 .04-2.52l2-1.56-2-3.46-2.48 1a8 8 0 0 0-2.17-1.25L14.1 3h-4l-.4 2.5a8 8 0 0 0-2.16 1.26l-2.47-1-2 3.46 1.98 1.55a7.7 7.7 0 0 0 .04 2.54l-2 1.55 2 3.46 2.46-.99a8 8 0 0 0 2.15 1.24l.4 2.48h4l.4-2.48a8 8 0 0 0 2.15-1.24l2.47.99 2-3.46-2.02-1.56Z"/>',
  dock: '<path d="M4 4h16v16H4z"/><path d="M14.5 4v16"/>',
  float: '<rect x="4" y="5" width="13" height="13" rx="1.5"/><path d="M8 5V3.75A1.75 1.75 0 0 1 9.75 2h8.5A1.75 1.75 0 0 1 20 3.75v8.5A1.75 1.75 0 0 1 18.25 14H17"/>',
  'chevron-right': '<path d="m9 5 7 7-7 7"/>',
  'chevron-left': '<path d="m15 5-7 7 7 7"/>',
  'arrow-left': '<path d="m10 5-7 7 7 7M3 12h18"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.8 9a2.35 2.35 0 1 1 3.4 2.1c-.78.4-1.2.87-1.2 1.9"/><path d="M12 16.65h.01"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/>',
  trash: '<path d="M5 7h14M9 7V4h6v3M7.2 7l.65 13h8.3l.65-13M10 10.5v6M14 10.5v6"/>',
  sync: '<path d="M19 7.5A8 8 0 0 0 5.3 5.2L3 8M5 16.5a8 8 0 0 0 13.7 2.3L21 16"/><path d="M3 3v5h5M21 21v-5h-5"/>',
  retry: '<path d="M20 11a8 8 0 1 0-2.35 5.65"/><path d="M20 5v6h-6"/>',
  translate: '<path d="M4 5h8M8 3v2c0 4-1.7 7.1-4.6 9.2M5 10c1.7 2 3.8 3.5 6.4 4.5"/><path d="m14 19 3-8 3 8m-5-3h4"/>',
  explain: '<path d="M12 3.5a6.75 6.75 0 0 0-3.9 12.25V20l3.55-1.55.35.02A6.75 6.75 0 1 0 12 3.5Z"/><path d="M10 9.2a2.1 2.1 0 1 1 3.15 1.82c-.78.47-1.15.98-1.15 1.73M12 15.9h.01"/>',
  comment: '<path d="M5 4.5h14v11H10l-5 4v-15Z"/><path d="M8 8.5h8M8 12h5"/>',
  note: '<path d="M6 3.5h9l3 3V20H6z"/><path d="M15 3.5V7h3M9 11h6M9 14.5h6M9 18h4"/>',
  sparkle: '<path d="m12 3 1.25 3.75L17 8l-3.75 1.25L12 13l-1.25-3.75L7 8l3.75-1.25L12 3Z"/><path d="m18.5 13 .7 2.1 2.1.7-2.1.7-.7 2.1-.7-2.1-2.1-.7 2.1-.7.7-2.1Z"/><path d="M5.5 14.5v5M3 17h5"/>',
  quote: '<path d="M9.5 6H5v6h4v5H5M19 6h-4.5v6h4v5h-4.5"/>',
  send: '<path d="m4 12 16-8-6.5 16-2.2-6.3L4 12Z"/><path d="m11.3 13.7 4.2-4.2"/>',
  highlight: '<path d="m14.5 4 5.5 5.5L10 19.5 4.5 14 14.5 4Z"/><path d="M3 21h9M12 6.5l5.5 5.5"/>',
  copy: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  download: '<path d="M12 3v11M8 10l4 4 4-4M4 19h16"/>',
  folder: '<path d="M3.5 7.5h6l1.7 2h9.3v8.8a2.2 2.2 0 0 1-2.2 2.2H5.7a2.2 2.2 0 0 1-2.2-2.2V7.5Z"/><path d="M3.5 7.5V5.7a2.2 2.2 0 0 1 2.2-2.2h3.1l1.8 2h7.7a2.2 2.2 0 0 1 2.2 2.2v1.8"/>',
  check: '<path d="m5 12.5 4.2 4.2L19 7"/>',
};

export function icon(name, cls = 'ico') {
  const body = PATHS[name];
  if (!body) throw new Error(`未知图标：${name}`);
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

export function brandMark(cls = 'mk') {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><path d="M4 6.5h12" stroke="currentColor" stroke-opacity=".38" stroke-width="2.2" stroke-linecap="round"/><path d="M4 17.5h9" stroke="currentColor" stroke-opacity=".38" stroke-width="2.2" stroke-linecap="round"/><path d="M4 12h13.5" stroke="var(--cf-accent)" stroke-width="2.6" stroke-linecap="round"/><path d="M16.3 9.2 19.8 12l-3.5 2.8" stroke="var(--cf-accent)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
