import { byPosition } from './order.js';

export const RECORD_FILTERS = [
  ['all', '全部'], ['comments', '批注'], ['explain', '解释'], ['translate', '翻译'],
];
export const recordKind = (event) => event.action === 'highlight' ? 'comments' : event.action;

// Only join identical, resolved selections. Repeated quotes at different offsets,
// overlapping selections and orphaned records must not silently become one source.
export function groupRecords(items, positionOf, isOrphan = () => false) {
  const groups = new Map();
  for (const item of byPosition(items.filter(e => !e.deletedAt), positionOf)) {
    const text = item.anchor?.exact || item.text || '';
    const position = positionOf(item.id);
    const located = !isOrphan(item.id) && Number.isFinite(position) && position < Number.MAX_SAFE_INTEGER;
    const key = located && item.anchor?.exact
      ? JSON.stringify([position, text]) : JSON.stringify(['single', item.id]);
    if (!groups.has(key)) groups.set(key, { key, text, items: [] });
    groups.get(key).items.push(item);
  }
  return [...groups.values()];
}

export function matchesRecord(item, filter, query, comment = '') {
  if (filter !== 'all' && recordKind(item) !== filter) return false;
  const words = String(query || '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const haystack = [item.text, item.anchor?.exact, item.value, item.extra?.question,
    item.extra?.supplement, comment].filter(Boolean).join('\n').toLocaleLowerCase();
  return words.every(word => haystack.includes(word));
}
