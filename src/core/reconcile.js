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

export function reconcile(local, remote, { pending, localBefore }) {
  const remoteIds = new Set(remote.map((e) => e.id));

  // 只有积压清空、且服务端确实有数据时才敢淘汰本地多出来的：
  //  · 有积压 → 本地那些"服务端没有"的可能只是还没推上去
  //  · 服务端全空而本地有 → 更可能是库被重置或换了机器，不是用户真删空了。
  //    宁可留着重复，也不能把阅读痕迹抹掉。
  const trustRemote = pending === 0 && remote.length > 0;

  const keepLocal = local.filter((e) => !remoteIds.has(e.id)
    // localBefore 之外的是请求期间新增的，服务端当然还没有，必须留
    && (!trustRemote || !localBefore.has(e.id)
      // 还没有结果的查询记录是**故意只存本地**的（半成品不该推给服务端），
      // 服务端当然没有它。按"服务端没有就是被删了"处理会让正在跑的解释
      // 在下一次同步时凭空消失。
      || isPending(e)));

  return [...remote, ...keepLocal].filter((e) => !e.deletedAt);
}
