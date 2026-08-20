// 面板列表的排序规则：一律按**文档位置**。
//
// 单独成文件，是为了让批注与查询记录共用同一个比较器。此前两处各写了一份
// （批注在 panel.js、查询记录在 main.js 的 getLookups），只要有人动了一处，
// 两个列表的顺序就会不一致 —— 而这种不一致极难被注意到。
//
// 为什么不按时间：读者的心理模型是「从上往下读」。按时间排会让同一段的记录
// 散落在列表各处；又因为点条目能跳原文、点原文能跳条目，两侧顺序必须对得上，
// 否则双向定位反而让人迷失。

/**
 * @param {Array<{id:string, createdAt:number}>} items
 * @param {(id:string) => number|undefined} posOf 字符偏移；失锚项给旧偏移，无锚点给 undefined
 * @returns {Array} 新数组，不改动入参
 */
export function byPosition(items, posOf) {
  const at = (e) => posOf(e.id) ?? Number.MAX_SAFE_INTEGER;
  // 位置相同时按创建先后，保证顺序稳定（同一位置的多条不会每次渲染都换位）
  return [...items].sort((a, b) => at(a) - at(b) || (a.createdAt ?? 0) - (b.createdAt ?? 0));
}
