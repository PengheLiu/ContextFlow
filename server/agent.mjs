// 本地 agent 适配层：把「解释」交给用户机器上已有的编码 agent。
//
// 为什么值得做：网页上套一层 LLM 现在到处都有，而且受限于模型自身知识 ——
// 实测让 agent 去翻用户自己的笔记库，它能答出
//   "…这正好是这篇论文的威胁模型所处的位置（见 advanced_blogs/Multi-Teacher…md）"
// 这种任何 chat2html 都做不到的回答。差异化不在"更聪明的模型"，
// 在**它能读你本地积累的语料**。
//
// 代价（实测）：单次 10 轮 / 32 秒 / $0.44。所以解释走异步作业，翻译仍走 LLM ——
// 翻译一句话不需要 agent loop，用 agent 只是贵一到两个数量级。
//
// ────────────────── 权限姿态 ──────────────────
//
// 新用户默认 Safe：Claude Code 只暴露读/检索工具并隔离 MCP、命令与持久会话；
// Codex 使用 read-only sandbox。dsh / Gemini 的权限边界尚未验证，Safe 下直接拒绝。
// Full 藏在设置页「高级能力」并需风险确认；只有迁移来的旧配置保留原行为。
//
// 两档都保留的硬约束：
//   · 子进程环境不整份继承 process.env（服务里有 LLM key 与思源 token）
//   · 每次查询都有超时与取消；支持 --max-turns 的 CLI 另加轮数限制
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { runCodex, getCodexSession, closeCodexServers, resolveCodexExecutable } from './codex-app-server.mjs';
import { runDsh, getDshSession, closeDshServers } from './dsh-runtime.mjs';
import { resolveDshInstallation } from './dsh-installation.mjs';
import { findExecutable, agentEnvironment, execAgent, spawnAgent, terminateTree } from './platform.mjs';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execAgent);
const err = (msg, code) => Object.assign(new Error(msg), { code });

export const AGENTS = {
  claude: {
    label: 'Claude Code',
    bin: 'claude',
    versionArgs: ['--version'],
    // 已实测可用（读文件、续接会话）。注意本机的 Claude Code 指向内部网关，
    // WebSearch/WebFetch 会挂死 —— 那是网关不代理服务端工具，不是配置问题。
    verified: true,
    safeSupport: 'best-effort',
    resumable: true,
  },
  codex: {
    label: 'Codex CLI',
    bin: 'codex',
    versionArgs: ['--version'],
    // 已实测可用，且联网正常（走另一套认证，不经内部网关）
    verified: true,
    safeSupport: 'verified',
    resumable: true,
  },
  dsh: {
    label: 'DeepSeek Harness',
    bin: 'dsh',
    versionArgs: ['--version'],
    verified: false,
    safeSupport: 'unsupported',
    // 通过常驻 Web API 在进程内续接；旧 headless 仅作协议不支持时的兼容路径。
    resumable: true,
  },
  gemini: {
    label: 'Gemini CLI',
    bin: 'gemini',
    versionArgs: ['--version'],
    verified: false,
    safeSupport: 'unsupported',
    resumable: false,
  },
};

export const AGENT_IDS = Object.keys(AGENTS);

/**
 * 探测本机可用的 agent。
 *
 * DSH 优先使用桌面版附带的运行入口；其他 agent 用 `which` 解析真实可执行文件。
 * 不依赖 shell 别名 —— 用户的 `claude` 很可能是
 * 一个带代理环境变量的 alias，Node 起进程时不走别名。
 */
// 探测结果缓存。起 4 个进程取版本要 600~900ms —— 对"打开面板就自动探测"来说
// 每次都跑太浪费，而 agent 的安装状态几乎不变（装/卸 CLI 才会变）。
// 缓存让面板能在每个页面上都自动显示真实的 agent 名，而不是"未检测"。
const probeCache = new Map();
const TTL = 10 * 60 * 1000;
const pendingProbes = new Map();

/**
 * @param {boolean} [fresh] 用户手动点「检测」时绕过缓存 —— 他刚装了新 agent 就指望这个
 */
export async function detect(fresh = false, configuredAgent = {}) {
  const env = childEnv();
  const key = createHash('sha256').update(JSON.stringify([configuredAgent.id, configuredAgent.executable,
    Object.entries({ ...env, ...configuredAgent.env }).sort(([a], [b]) => a.localeCompare(b))])).digest('hex');
  const cached = probeCache.get(key);
  if (!fresh && cached && Date.now() - cached.at < TTL) return cached.rows;
  if (pendingProbes.has(key)) return pendingProbes.get(key);
  const pending = probe(env, configuredAgent).then(r => {
    probeCache.delete(key); probeCache.set(key, { at: Date.now(), rows: r });
    while (probeCache.size > 8) probeCache.delete(probeCache.keys().next().value);
    return r;
  }).finally(() => pendingProbes.delete(key));
  pendingProbes.set(key, pending);
  return pending;
}

async function probe(baseEnv, configuredAgent) {
  // Independent local version probes must not serially hold up first launch.
  // A version timeout leaves the installation visible but never calls it tested.
  return Promise.all(Object.entries(AGENTS).map(async ([id, a]) => {
    // Credentials and executable overrides belong only to the selected agent.
    const env = id === configuredAgent.id ? { ...baseEnv, ...configuredAgent.env } : baseEnv;
    const row = {
      id, label: a.label, verified: !!a.verified, safeSupport: a.safeSupport,
      connectionTestSupported: a.safeSupport !== 'unsupported',
      available: false, path: '', version: '',
    };
    try {
      if (id === 'dsh') {
        const installation = resolveDshInstallation({ env, bin: id === configuredAgent.id ? configuredAgent.executable : undefined });
        row.source = installation.source;
        row.appPath = installation.appPath || '';
        if (!installation.available) throw new Error('not found');
        row.path = installation.bin;
      } else {
        const requested = id === configuredAgent.id ? configuredAgent.executable : '';
        const found = id === 'codex' ? resolveCodexExecutable(env, requested) : requested || a.bin;
        row.path = findExecutable(found, { env }) || '';
      }
      if (!row.path) throw new Error('not found');
      row.available = true;
    } catch {
      return row;
    }
    try {
      const { stdout } = await execFileAsync(row.path, a.versionArgs,
        { timeout: 5000, env, windowsHide: true });
      row.version = stdout.trim().split('\n')[0].slice(0, 60);
    } catch (e) {
      row.version = '(取版本失败)';
    }
    if (id === 'dsh') row.connectionTestSupported = row.source === 'desktop' && row.version === '0.2.1-rc.2';
    return row;
  }));
}

/**
 * 子进程环境。
 * 刻意**不**整份继承 process.env：服务里有 LLM api key 和思源 token，
 * 没有任何理由让 agent 进程看见它们。只透传运行所必需的几项。
 */
function childEnv(extra = {}) {
  return agentEnvironment(process.env, extra);
}

// 常驻 Agent 只在同配置的进程内复用会话，不读取旧 CLI 留下的 session ID。
export function session({ agent = 'codex', contextKey, env = {}, profile = 'safe', notesDir = '', bin }) {
  const getSession = agent === 'dsh' ? getDshSession : getCodexSession;
  return getSession({ contextKey, env: childEnv(env), profile, notesDir, bin });
}

export function close() { return Promise.all([closeCodexServers(), closeDshServers()]); }

/**
 * 构造调用参数。
 *
 * 返回 `{ argv, stdin }`：prompt 走 stdin 还是 argv 由各家的契约决定，
 * 不用一个魔法 `-` 糊过去 —— dsh 就是把字面的 `-` 当成了提问内容，
 * 结果它回了一句"你的消息是空的"。
 */
function argvFor(id, { prompt, sessionId, resume, notesDir, maxTurns, profile = 'safe', connectionTest = false }) {
  switch (id) {
    case 'claude': {
      if (profile === 'safe') {
        // Safe 是 best-effort：工具面 + allow/deny + customizations/MCP/Chrome 多层同时收紧。
        // 先前只配 allowedTools 时 Monitor 仍能执行 shell，所以绝不能只靠 allowlist。
        const allow = ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'];
        const deny = ['Bash', 'Edit', 'Write', 'NotebookEdit', 'Monitor', 'Workflow',
          'Agent', 'Task', 'Skill', 'CronCreate', 'ScheduleWakeup', 'PushNotification'];
        const argv = ['-p', '--output-format', 'json', '--safe-mode',
          '--permission-mode', 'dontAsk',
          // Official CLI contract: --tools "" disables built-in tools.
          // https://code.claude.com/docs/en/cli-reference
          ...(connectionTest ? ['--tools', ''] : ['--tools', ...allow, '--allowedTools', ...allow]),
          '--disallowedTools', ...deny,
          '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
          '--disable-slash-commands', '--no-chrome', '--no-session-persistence',
          '--max-turns', String(maxTurns)];
        if (notesDir) argv.push('--add-dir', notesDir);
        // Safe 不续接 Full 时代的 session；历史由 DB 重建。
        return { argv, stdin: true };
      }
      const argv = ['-p', '--output-format', 'json',
        '--permission-mode', 'bypassPermissions', '--max-turns', String(maxTurns)];
      if (notesDir) argv.push('--add-dir', notesDir);
      if (resume) argv.push('--resume', sessionId); else argv.push('--session-id', sessionId);
      return { argv, stdin: true };
    }
    case 'codex': {
      const safe = profile === 'safe';
      const base = ['--json', '--skip-git-repo-check'];
      if (safe) base.push('--sandbox', 'read-only', '--ephemeral', '--ignore-rules');
      // 不加 --ignore-user-config：实测会把认证路由剥掉，直连 api.openai.com 拿 401。
      const argv = ['exec'];
      // --cd 属于 exec，不属于 resume；必须在子命令前传入，否则续接会退出码 2。
      // https://learn.chatgpt.com/docs/cli/reference
      if (notesDir) argv.push('--cd', notesDir);
      if (!safe && resume) argv.push('resume', sessionId);
      argv.push(...base, '-');
      return { argv, stdin: true };
    }
    case 'dsh':
      if (profile === 'safe') throw err('DeepSeek Harness 的安全权限边界未验证，仅可在高级完整权限中使用', 'AGENT_SAFE_UNSUPPORTED');
      // `dsh --profile headless [task...]`：prompt 是位置参数，没有 stdin 契约
      return {
        // 旧 headless 没有 --resume；兼容调用始终接收完整上下文。
        argv: ['--profile', 'headless', prompt],
        stdin: false,
      };
    case 'gemini':
      if (profile === 'safe') throw err('Gemini CLI 的安全权限边界未验证，仅可在高级完整权限中使用', 'AGENT_SAFE_UNSUPPORTED');
      return { argv: ['-p', prompt], stdin: false };
    default:
      throw err(`未知 agent：${id}`, 'BAD_AGENT');
  }
}

// prompt 走 argv 的 agent 有长度上限。macOS ARG_MAX 约 1MB，但超了只会拿到
// 一个看不懂的 E2BIG，不如自己先拦下来并说清怎么办。
const ARGV_MAX = 120000;

/** 从各家的输出里抠出答案与会话 id */
function parseOut(id, stdout) {
  const text = String(stdout || '');
  if (id === 'claude') {
    // JSON 字段顺序与空白不固定；同时支持完整 JSON 和带日志的逐行输出。
    const json = (s) => { try { return JSON.parse(s); } catch { return null; } };
    const full = json(text);
    const r = full?.type === 'result' ? full
      : text.split('\n').map(json).findLast((row) => row?.type === 'result');
    if (!r) throw err('Claude Code 未返回有效的结果 JSON，请查看服务端日志', 'AGENT_PARSE');
    if (r.is_error || (r.subtype && r.subtype !== 'success')) {
      const detail = r.result || r.errors?.join('; ') || r.subtype || '未知错误';
      if (/not logged in/i.test(detail)) {
        throw err('Claude Code 尚未登录，请在终端运行 claude 并使用 /login 后重试', 'AGENT_AUTH');
      }
      throw err(`agent 返回错误：${detail}`, 'AGENT_ERROR');
    }
    return {
      answer: String(r.result || '').trim(),
      meta: {
        sessionId: r.session_id, turns: r.num_turns, ms: r.duration_ms,
        costUsd: r.total_cost_usd,
        cacheRead: r.usage?.cache_read_input_tokens ?? 0,
        cacheWrite: r.usage?.cache_creation_input_tokens ?? 0,
        denials: (r.permission_denials || []).length,
      },
    };
  }
  if (id === 'codex') {
    // 实测事件形状（v0.147）：
    //   {"type":"thread.started","thread_id":"…"}
    //   {"type":"item.completed","item":{"type":"agent_message","text":"…"}}
    //   {"type":"turn.completed","usage":{"cached_input_tokens":…}}
    // 注意是 item.completed 里**嵌套** item.type，不是顶层 msg.type。
    let answer = '', sid = '', usage = null, completed = false, failure = '';
    for (const line of text.split('\n')) {
      const s2 = line.trim();
      if (!s2.startsWith('{')) continue;
      let o; try { o = JSON.parse(s2); } catch { continue; }
      if (o.thread_id) sid = o.thread_id;
      if (o.type === 'turn.completed') { completed = true; usage = o.usage || null; }
      if (o.type === 'turn.failed' || o.type === 'error') {
        failure = o.error?.message || o.message || 'Codex 未完成本次任务';
      }
      const it = o.item;
      if (o.type === 'item.completed' && it?.type === 'agent_message') {
        answer = String(it.text ?? it.message ?? '');      // 取最后一条
      }
      // 错误项要带出来，否则失败时只剩一句"没有返回内容"
      if (o.type === 'item.completed' && it?.type === 'error' && it.message
          && !/bypass-hook-trust/.test(it.message)) {
        failure = it.message;
      }
    }
    if (failure) throw err(`Codex 执行失败：${failure}`, 'AGENT_ERROR');
    if (!completed) throw err('Codex 未返回成功完成状态，请重试', 'AGENT_PARSE');
    return {
      answer: answer.trim(),
      meta: {
        sessionId: sid,
        cacheRead: usage?.cached_input_tokens ?? 0,
        cacheWrite: usage?.cache_write_input_tokens ?? 0,
        usage: usage ? { in: usage.input_tokens, out: usage.output_tokens,
          cacheRead: usage.cached_input_tokens ?? 0, cacheWrite: usage.cache_write_input_tokens ?? 0 } : undefined,
      },
    };
  }

  // dsh / gemini：没有稳定的结构化输出契约，直接用 stdout
  return { answer: text.trim(), meta: {} };
}

/**
 * 跑一次 agent 查询。
 *
 * @param {object} o
 * @param {string} o.agent          AGENT_IDS 之一
 * @param {string} o.prompt         走 stdin，不进 argv —— 全文可能上百 KB
 * @param {string} [o.sessionId]    续接用；不给则新建
 * @param {boolean} [o.resume]      true = 续接已有会话
 * @param {string} [o.notesDir]     授予**只读**访问的笔记目录
 * @param {number} [o.maxTurns]
 * @param {number} [o.timeoutMs]
 * @param {(s:string)=>void} [o.onProgress] 收到 stderr/事件时回调，用于界面进度
 */
export async function run({
  agent, prompt, sessionId, resume = false, notesDir = '', profile = 'safe',
  maxTurns = 12, timeoutMs = 240000, env = {}, onProgress, onEvent, signal, connectionTest = false,
  contextKey, continuationPrompt, expectedSessionId, contextState, bin,
}) {
  if (signal?.aborted) throw err('已取消', 'ABORTED');
  const a = AGENTS[agent];
  if (!a) throw err(`未知 agent：${agent}`, 'BAD_AGENT');
  const runtimeEnv = childEnv(env);
  const executable = agent === 'dsh' ? resolveDshInstallation({ env: runtimeEnv, bin }).bin
    : agent === 'codex' ? resolveCodexExecutable(runtimeEnv, bin)
      : findExecutable(bin || a.bin, { env: runtimeEnv }) || bin || a.bin;

  if (profile === 'safe' && a.safeSupport === 'unsupported' && !(agent === 'dsh' && connectionTest)) {
    throw err(`${a.label} 不支持安全档，仅可在高级完整权限中使用`, 'AGENT_SAFE_UNSUPPORTED');
  }
  if (agent === 'codex') {
    try {
      const result = await runCodex({ prompt, continuationPrompt, expectedSessionId,
        contextKey, contextState, bin: executable, env: childEnv(env), profile, notesDir,
        timeoutMs, signal, onEvent, connectionTest });
      return { ...result, agent };
    } catch (error) {
      // 只能在模型任务尚未提交、且已确定协议不支持时回退；中途失败不可重放。
      if (error.code !== 'CODEX_UNSUPPORTED' || error.submitted !== false) throw error;
      onEvent?.({ type: 'status', text: '当前 Codex 使用兼容模式…' });
      sessionId = undefined;
      resume = false;
    }
  }
  if (agent === 'dsh') {
    try {
      const result = await runDsh({ prompt, continuationPrompt, expectedSessionId,
        contextKey, contextState, bin: executable, env: runtimeEnv, profile, notesDir,
        timeoutMs, signal, onEvent, connectionTest });
      return { ...result, agent };
    } catch (error) {
      if (connectionTest || error.code !== 'DSH_UNSUPPORTED' || error.submitted !== false) throw error;
      onEvent?.({ type: 'status', text: '当前 DSH 使用兼容模式…' });
      sessionId = undefined;
      resume = false;
    }
  }
  const sid = sessionId || (agent === 'claude' ? randomUUID() : '');
  const { argv, stdin } = argvFor(agent, {
    prompt, sessionId: sid, resume: profile === 'full' && resume, notesDir, maxTurns, profile, connectionTest,
  });
  if (!stdin && prompt.length > ARGV_MAX) {
    throw err(
      `${a.label} 只能用命令行参数传 prompt，而本次有 ${prompt.length} 字符，超过 ${ARGV_MAX} 上限。`
      + '把配置里的「每段字符数」调小，或换成 Claude Code / Codex（它们走 stdin）。',
      'AGENT_PROMPT_TOO_LONG');
  }

  const legacyStartedAt = Date.now();
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnAgent(executable, argv, {
        env: runtimeEnv,
        // cwd 用 /tmp：agent 会读 cwd 下的项目配置（CLAUDE.md/AGENTS.md 等），
        // 指到仓库里会把无关上下文灌进去，还多给一片可读目录
        cwd: tmpdir(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      return reject(err(`起 ${a.bin} 失败：${e.message}（装了吗？）`, 'AGENT_SPAWN'));
    }

    let out = '', errBuf = '', done = false, aborted = false, killTimer;
    const terminate = () => {
      terminateTree(child);
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) terminateTree(child, 'SIGKILL');
      }, 2000);
      killTimer.unref?.();
    };
    const onAbort = () => { if (!done) { aborted = true; terminate(); } };
    signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', onAbort); };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      terminate();
      signal?.removeEventListener('abort', onAbort);
      // 把 stderr 一并带出来 —— 一个光秃秃的"超时"把唯一的诊断线索丢在了地上
      const tail = errBuf.trim().split('\n').slice(-4).join(' | ').slice(-400);
      reject(err(
        `${a.label} 超过 ${Math.round(timeoutMs / 1000)}s 未返回，已中止`
        + (tail ? `。stderr 尾部：${tail}` : '。stderr 无输出'),
        'AGENT_TIMEOUT'));
    }, timeoutMs);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => {
      const s = String(d);
      errBuf += s;
      if (errBuf.length > 8000) errBuf = errBuf.slice(-8000);   // 只留尾部，别涨爆
      onProgress?.(s);
    });
    child.on('error', (e) => {
      if (done) return;
      done = true; cleanup();
      reject(err(`${a.bin} 执行失败：${e.message}`, 'AGENT_SPAWN'));
    });
    child.on('close', (code) => {
      cleanup();
      if (done) return;
      done = true; clearTimeout(timer);
      if (aborted) return reject(err('已取消', 'ABORTED'));
      try {
        if ((connectionTest || agent === 'codex' || agent === 'dsh') && code !== 0) {
          const diagnostic = `${out}\n${errBuf}`;
          if (/not logged in|unauthorized|authentication|invalid.{0,10}key|\b401\b|please.{0,15}login|\/login/i.test(diagnostic)) {
            throw err(`${a.label} 登录或认证失败，请在终端完成登录并确认默认模型可用，再回来测试`, 'AGENT_AUTH');
          }
          throw err(`${a.label} 进程异常退出（${code ?? 'signal'}）。请在终端确认 CLI 能正常启动，或更新 CLI 后重新检测。`, 'AGENT_ERROR');
        }
        const { answer, meta } = parseOut(agent, out);
        if (!answer) {
          return reject(err(
            `${a.label} 没有返回内容（退出码 ${code}）${errBuf ? `：${errBuf.slice(-300)}` : ''}`,
            'AGENT_EMPTY'));
        }
        resolve({ answer, agent, sessionId: meta.sessionId || sid, ...meta,
          ...(agent === 'dsh' ? { transport: 'dsh-headless', resumed: false, ms: Date.now() - legacyStartedAt } : {}) });
      } catch (e) {
        reject(e.code ? e : err(`解析 ${a.label} 输出失败：${e.message}`, 'AGENT_PARSE'));
      }
    });

    child.stdin.on('error', () => { /* agent 提前退出时的 EPIPE，忽略 */ });
    // 走 argv 的 agent 也要关掉 stdin，否则它可能一直等输入
    child.stdin.end(stdin ? prompt : '');
  });
}

export { argvFor as _argvFor, parseOut as _parseOut };
