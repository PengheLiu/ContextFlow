// 本地镜像与服务端的对账。
//
// 单独成文件是因为它**能抹掉用户数据** —— 这种逻辑不该埋在需要浏览器环境才能
// 跑起来的 App.sync() 里，必须能单测。
//
// 背景：原先这里是简单并集，于是"服务端为事实源"只对新增和修改成立，删除永远
// 传不过来。用维护脚本从库里删掉的重复记录，会被 localStorage 镜像原地复活。

/**
 * @param {Array<{id:string, deletedAt?:number}>} local  本地镜像
 * @param {Array<{id:string, deletedAt?:number}>} remote 服务端该 urlKey 的全量
 * @param {object} o
 * @param {number} o.pending 出站积压条数；>0 说明本地有还没推上去的
 * @param {Set<string>} o.localBefore 发起请求**之前**的本地 id 集合
 * @returns {Array} 对账后的事件数组
 */
/**
 * 提交后尚未拿到结果的查询记录：只存在本地，不能被当成"服务端已删"。
 *
 * 判据是 extra.status 这个**显式标记**，不是"没有 value"——
 * 后者会把任何缺 value 的记录都当成进行中（第一版就这么写，测试立刻抓到：
 * 本该被淘汰的重复记录全被留下了）。从字段缺失推断意图不可靠。
 */
const isPending = (e) => !e.value && !e.deletedAt && !!e.extra?.status;

const cmp = (a, b) => {
  const ta = Number(a?.updatedAt || a?.createdAt || 0);
  const tb = Number(b?.updatedAt || b?.createdAt || 0);
  if (ta !== tb) return ta - tb;
  if (!!a?.deletedAt !== !!b?.deletedAt) return a?.deletedAt ? 1 : -1;
  return String(a?.mutationId || '').localeCompare(String(b?.mutationId || ''));
};

export function reconcile(local, remote, { pending, localBefore }) {
  const localMap = new Map(local.map((e) => [e.id, e]));
  const remoteMap = new Map(remote.map((e) => [e.id, e]));
  const merged = [];

  // 新协议：服务端返回 live + tombstone，并带 mutation clock。逐实体选新者，不再从
  // "远端没有"推断删除；旧客户端数据没有 clock 时仍保留下面的 absence 兼容策略。
  for (const [id, r] of remoteMap) {
    const l = localMap.get(id);
    merged.push(l && cmp(l, r) > 0 ? l : r);
  }

  const clockedRemote = remote.some((e) => e.updatedAt || e.mutationId || e.deletedAt);
  const trustRemote = !clockedRemote && pending === 0 && remote.length > 0;
  for (const l of local) {
    if (remoteMap.has(l.id)) continue;
    if (!trustRemote || !localBefore.has(l.id) || isPending(l)) merged.push(l);
  }

  return merged.filter((e) => !e.deletedAt);
}
