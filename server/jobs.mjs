// 异步作业队列：给「解释走本地 agent」用。
//
// 为什么必须异步：实测 agent 一次解释 10 轮 / 32 秒。同步等在 HTTP 上，
// 浏览器和浮层都会被挂住，用户以为卡死。改成"立刻返回 jobId，浮层轮询进度"。
//
// 为什么必须串行：agent 是重进程（一次几十秒、吃 CPU 和额度）。若按请求并发起，
// 用户连点几下就能把机器和额度一起打满。队列宽度默认 1，多的排队。
//
// 刻意只放在内存里：作业是"这次查询的过程"，结果一落库就没有保留价值了；
// 服务重启后残留的 running 作业没有任何办法接续，持久化只会留下一堆僵尸。

const jobs = new Map();          // id → job
const queue = [];                // 待跑的 job id
// 用 Set 而不是计数器：计数器会被"陈旧完成"打成负数（_reset 归零后，先前还在飞的
// 任务完成时仍会 running--），一旦为负就允许并发超限。删一个不在集合里的 id 是
// 无操作，这类 bug 从数据结构上就不存在了。
const inFlight = new Set();
let seq = 0;

const MAX_CONCURRENT = 1;
// 完成后保留一会儿供前端取结果，之后清掉，避免内存里越积越多
const KEEP_MS = 10 * 60 * 1000;

/**
 * @param {object} o
 * @param {string} o.kind        作业类型，仅用于展示
 * @param {string} o.label       给人看的一句话
 * @param {(job)=>Promise<any>} o.task 真正干活的函数；可用 job.progress(text) 报进度
 * @returns {{id, status}}
 */
export function submit({ kind, label, task }) {
  const id = `j${++seq}-${Date.now().toString(36)}`;
  const job = {
    id, kind, label,
    status: 'queued',            // queued | running | done | error | canceled
    progress: '',
    result: null,
    error: null,
    at: Date.now(),
    startedAt: null,
    endedAt: null,
    _task: task,
    _canceled: false,
  };
  jobs.set(id, job);
  queue.push(id);
  pump();
  return view(job);
}

function pump() {
  while (inFlight.size < MAX_CONCURRENT && queue.length) {
    const id = queue.shift();
    const job = jobs.get(id);
    if (!job || job._canceled) continue;
    inFlight.add(id);
    job.status = 'running';
    job.startedAt = Date.now();

    const api = {
      id: job.id,
      progress: (text) => { job.progress = String(text ?? '').slice(0, 400); },
      get canceled() { return job._canceled; },
    };

    Promise.resolve()
      .then(() => job._task(api))
      .then((r) => {
        if (job._canceled) return;
        job.status = 'done'; job.result = r;
      })
      .catch((e) => {
        if (job._canceled) return;
        job.status = 'error';
        job.error = { message: e?.message || String(e), code: e?.code || 'ERROR' };
      })
      .finally(() => {
        inFlight.delete(job.id);
        job.endedAt = Date.now();
        job._task = null;                       // 别把闭包（含全文）留在内存里
        setTimeout(() => jobs.delete(job.id), KEEP_MS).unref?.();
        pump();
      });
  }
}

/** 对外形状：不暴露内部字段 */
function view(job) {
  const queuedAhead = job.status === 'queued'
    ? queue.indexOf(job.id) + inFlight.size
    : 0;
  return {
    id: job.id, kind: job.kind, label: job.label,
    status: job.status, progress: job.progress,
    queuedAhead: Math.max(0, queuedAhead),
    ms: (job.endedAt ?? Date.now()) - (job.startedAt ?? job.at),
    result: job.status === 'done' ? job.result : null,
    error: job.error,
  };
}

export function get(id) {
  const j = jobs.get(id);
  return j ? view(j) : null;
}

export function cancel(id) {
  const j = jobs.get(id);
  if (!j || j.status === 'done' || j.status === 'error') return false;
  j._canceled = true;
  j.status = 'canceled';
  j.endedAt = Date.now();
  const i = queue.indexOf(id);
  if (i >= 0) queue.splice(i, 1);
  return true;
}

export function stats() {
  return {
    running: inFlight.size,
    queued: queue.length,
    total: jobs.size,
    maxConcurrent: MAX_CONCURRENT,
  };
}

/** 测试用：清空状态 */
export function _reset() {
  for (const j of jobs.values()) j._canceled = true;   // 在飞的任务不再回写
  jobs.clear(); queue.length = 0; inFlight.clear(); seq = 0;
}
