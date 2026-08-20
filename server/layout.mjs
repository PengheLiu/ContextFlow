// 笔记版式：两个写入端（思源 / 文件）共用的分组、排序与命名。
//
// 抽出来的直接原因：mdfile.mjs 与 siyuan.mjs 各写了一份 order()，且已经出现
// 细微分歧（解释的排序时机不同）。同一套版式规则存两份，早晚会让两个后端
// 产出不一样的笔记。
//
// 分类与面板 tab 一一对应、顺序也一致 —— 用户在面板里看到的次序，就是笔记里
// 标题的次序，回看时不用做二次映射。
import { hashKey } from '../src/core/lookupkey.js';

export const CATEGORIES = [
  { key: 'translate', label: '翻译', actions: ['translate'] },
  { key: 'explain', label: '解释', actions: ['explain'] },
  // 高亮与它的评论是一体的，同属「批注」
  { key: 'comments', label: '批注', actions: ['highlight', 'comment'] },
  { key: 'note', label: '总结', actions: ['note'] },
];

export const CAT_KEYS = CATEGORIES.map((c) => c.key);
export const CAT_OF = new Map(
  CATEGORIES.flatMap((c) => c.actions.map((a) => [a, c.key])));
export const LABEL_OF = new Map(CATEGORIES.map((c) => [c.key, c.label]));

const at = (e) => e.anchor?.start ?? 0;
const byAnchor = (a, b) => at(a) - at(b);

/**
 * 把一批事件按分类分组，组内排好序。
 * @returns {Map<string, object[]>} 只含**非空**分组，键序同 CATEGORIES
 */
export function groupByCategory(events) {
  const out = new Map();
  for (const c of CATEGORIES) {
    const mine = events.filter((e) => c.actions.includes(e.action));
    if (!mine.length) continue;
    out.set(c.key, c.key === 'comments' ? orderComments(mine) : [...mine].sort(byAnchor));
  }
  return out;
}

/** 高亮按文档位置排，其评论紧随其后 */
function orderComments(events) {
  const highlights = events.filter((e) => e.action === 'highlight').sort(byAnchor);
  const comments = events.filter((e) => e.action === 'comment');
  const out = [];
  for (const h of highlights) {
    out.push(h);
    for (const c of comments) if (c.parentId === h.id) out.push(c);
  }
  // 父高亮在更早的批次就同步过了，这些评论找不到宿主，但不能丢
  for (const c of comments) if (!out.includes(c)) out.push(c);
  return out;
}

// ---------------- 文档命名 ----------------

// Windows 的保留字符 + 控制字符；`/` 在 POSIX 上也会被当成路径分隔。
// 连字符和空格是合法的，别一起清掉 —— 论文标题里到处都是。
const BAD = /[/\\:*?"<>|\u0000-\u001f]/g;
// 单个文档名的上限。按 CJK 在 UTF-8 里 3 字节算，60 字 ≈ 180 字节，
// 离常见的 255 字节文件名上限还有余量（还要留给冲突后缀和 .md）
const MAX_CHARS = 60;

/**
 * 文章标题 → 安全的文件名 / 思源文档名（不含扩展名）。
 *
 * @param {string} title
 * @param {string} urlKey 标题为空时的回落，以及同名冲突时的区分依据
 * @param {(name:string) => boolean} [taken] 该名字是否已被**别的**文章占用
 */
export function docName(title, urlKey, taken = () => false) {
  let base = String(title ?? '')
    .replace(BAD, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // 首尾的点会让文件变隐藏文件，或触发 . / .. 语义
    .replace(/^\.+|\.+$/g, '')
    .trim();

  if ([...base].length > MAX_CHARS) base = [...base].slice(0, MAX_CHARS).join('').trim();
  // 标题为空、或整个标题都是非法字符时回落到 urlKey 的哈希，总得有个名字
  if (!base) base = `untitled-${hashKey(String(urlKey)).slice(0, 8)}`;

  // 同名不同文章：加短哈希后缀区分。不用序号 —— 序号取决于同步顺序，
  // 换台机器重建时同一篇文章可能拿到不同的号
  if (taken(base)) base = `${base} (${hashKey(String(urlKey)).slice(0, 8)})`;
  return base;
}

/** 内容哈希：用来判断已同步的块内容是否变了，需要回写 */
export function contentHash(str) {
  return hashKey(String(str ?? ''));
}
