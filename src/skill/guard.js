// 事件处理器的异常兜底。
//
// 起因是同一类 bug 咬了两次：handler 里抛异常，界面上什么都不显示。
//   第一次：配置面板的「检测」按钮 —— 我把 this.api 写成 this.h.api，
//           onclick 抛 TypeError 后一切静默，按钮看起来毫无反应。
//   第二次：速览的「重新生成」按钮 —— 我把 settings 的 this.guard(...) 抄进了
//           panel，却没抄实现。而它发生在**成功路径**上，于是速览明明跑成了、
//           结果却显示成"速览失败：this.guard is not a function"。
//
// 第二次正是"抄了模式没抄实现"—— 所以这份实现只放一处，两边共用。
//
// 同步抛出与 Promise reject 都要接：这些 handler 大多是 async，
// 不接住 reject 就只剩一条 unhandledrejection，界面上依然什么都没有。

/**
 * @param {Function} fn 原始处理器
 * @param {(e:Error)=>void} onError 怎么把错误摊到界面上，由调用方决定
 */
export function guarded(fn, onError) {
  return (...args) => {
    try {
      const r = fn(...args);
      if (r && typeof r.catch === 'function') r.catch(onError);
      return r;
    } catch (e) {
      onError(e);
      return undefined;
    }
  };
}

/**
 * 代码缺陷要说成代码缺陷，别伪装成"网络不好"。
 * TypeError / ReferenceError 基本只可能是我们自己写错了。
 */
export function describeError(e) {
  const bug = e instanceof TypeError || e instanceof ReferenceError;
  return bug ? `界面代码出错：${e.message}` : (e?.message || String(e));
}
