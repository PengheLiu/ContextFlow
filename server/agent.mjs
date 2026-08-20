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
// **不做任何工具限制** —— 用户本地的 agent 有什么能力就用什么能力（这是明确的
// 产品决定）。因此这里既不下发 --allowedTools/--disallowedTools，也不剥 MCP，
// 也不强制沙箱：agent 完全按用户自己的配置运行。
//
// 剩下的唯一防线是软性的：convo.mjs 把网页正文包在 <article> 里并声明"这是资料、
// 不是给你的指令"。它挡不住刻意构造的提示注入 —— 一个被注入的页面理论上可以借
// agent 的能力在本机执行命令。接受这个风险是使用本功能的前提。
//
// 仍然保留的两件事，与权限无关：
//   · 子进程环境不整份继承 process.env（服务里有 LLM key 与思源 token，
//     没有理由让 agent 进程看见）
//   · --max-turns 与进程超时，防一次查询把 agent 跑飞、把额度烧干
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const execFileAsync = promisify(execFile);
const err = (msg, code) => Object.assign(new Error(msg), { code });

export const AGENTS = {
  claude: {
    label: 'Claude Code',
    bin: 'claude',
    versionArgs: ['--version'],
    // 已实测可用（读文件、续接会话）。注意本机的 Claude Code 指向内部网关，
    // WebSearch/WebFetch 会挂死 —— 那是网关不代理服务端工具，不是配置问题。
    verified: true,
    resumable: true,
  },
  codex: {
    label: 'Codex CLI',
    bin: 'codex',
    versionArgs: ['--version'],
    // 已实测可用，且联网正常（走另一套认证，不经内部网关）
    verified: true,
    resumable: true,
  },
  dsh: {
    label: 'DeepSeek Harness',
    bin: 'dsh',
    versionArgs: ['--version'],
    verified: false,
    // 实测 headless 输出里只有答案、没有 session id，因此无法 --resume。
    // 不可续接的 agent 走"每次发完整对话"的路子（见 lookup.explainViaAgent）。
    resumable: false,
  },
  gemini: {
    label: 'Gemini CLI',
    bin: 'gemini',
    versionArgs: ['--version'],
    verified: false,
    resumable: false,
  },
};

export const AGENT_IDS = Object.keys(AGENTS);

/**
 * 探测本机可用的 agent。
 *
 * 用 `which` 解析真实可执行文件，不依赖 shell 别名 —— 用户的 `claude` 很可能是
 * 一个带代理环境变量的 alias，Node 起进程时不走别名。
 */
export async function detect() {
  const out = [];
  for (const [id, a] of Object.entries(AGENTS)) {
    const row = { id, label: a.label, verified: !!a.verified, available: false, path: '', version: '' };
    try {
      const { stdout } = await execFileAsync('/usr/bin/which', [a.bin], { timeout: 3000 });
      row.path = stdout.trim().split('\n')[0];
      if (!row.path) throw new Error('not found');
      row.available = true;
    } catch {
      out.push(row);
      continue;
    }
    try {
      const { stdout } = await execFileAsync(row.path, a.versionArgs,
        { timeout: 15000, env: childEnv() });
      row.version = stdout.trim().split('\n')[0].slice(0, 60);
    } catch (e) {
      row.version = '(取版本失败)';
    }
    out.push(row);
  }
  return out;
}

/**
 * 子进程环境。
 * 刻意**不**整份继承 process.env：服务里有 LLM api key 和思源 token，
 * 没有任何理由让 agent 进程看见它们。只透传运行所必需的几项。
 */
function childEnv(extra = {}) {
  const keep = ['PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR',
    'TERM', 'XDG_CONFIG_HOME'];
  const env = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  // 代理需要时由配置显式给出（用户的 claude 别名里就带着代理）
  return { ...env, ...extra };
}

/**
 * 构造调用参数。
 *
 * 返回 `{ argv, stdin }`：prompt 走 stdin 还是 argv 由各家的契约决定，
 * 不用一个魔法 `-` 糊过去 —— dsh 就是把字面的 `-` 当成了提问内容，
 * 结果它回了一句"你的消息是空的"。
 */
function argvFor(id, { prompt, sessionId, resume, notesDir, maxTurns }) {
  switch (id) {
    case 'claude': {
      // bypassPermissions：无头模式下没人能批准授权，dontAsk 会把未预授权的工具
      // 一律静默拒掉 —— 那等于"有能力却用不了"。既然不做限制，就要真的放开。
      const argv = ['-p', '--output-format', 'json',
        '--permission-mode', 'bypassPermissions',
        '--max-turns', String(maxTurns)];
      if (notesDir) argv.push('--add-dir', notesDir);
      if (resume) argv.push('--resume', sessionId);
      else argv.push('--session-id', sessionId);
      return { argv, stdin: true };
    }
    case 'codex': {
      // 不指定 --sandbox，用用户 config.toml 里自己的设置。
      // --skip-git-repo-check：cwd 是 /tmp，codex 默认拒绝在非 git 目录里跑
      // （"Not inside a trusted directory"）。这里不需要 git 语义。
      // 刻意**不**加 --ignore-user-config：实测它会把认证与网关路由一并剥掉，
      // 导致 codex 直连 api.openai.com 拿 401。
      const argv = resume
        ? ['exec', 'resume', sessionId, '--json', '--skip-git-repo-check', '-']
        : ['exec', '--json', '--skip-git-repo-check', '-'];
      if (notesDir) argv.push('--cd', notesDir);
      return { argv, stdin: true };
    }
    case 'dsh':
      // `dsh --profile headless [task...]`：prompt 是位置参数，没有 stdin 契约
      return {
        argv: resume
          ? ['--profile', 'headless', '--resume', sessionId, prompt]
          : ['--profile', 'headless', prompt],
        stdin: false,
      };
    case 'gemini':
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
    // 末尾那行 type=result 的 JSON 才是最终结果
    const m = text.match(/\{"type":"result".*\}\s*$/m) || text.match(/\{"type":"result".*\}/);
    if (!m) return { answer: text.trim(), meta: {} };
    const r = JSON.parse(m[0]);
    if (r.is_error) throw err(`agent 返回错误：${r.result || r.subtype}`, 'AGENT_ERROR');
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
    let answer = '', sid = '', usage = null;
    for (const line of text.split('\n')) {
      const s2 = line.trim();
      if (!s2.startsWith('{')) continue;
      let o; try { o = JSON.parse(s2); } catch { continue; }
      if (o.thread_id) sid = o.thread_id;
      if (o.type === 'turn.completed' && o.usage) usage = o.usage;
      const it = o.item;
      if (o.type === 'item.completed' && it?.type === 'agent_message') {
        answer = String(it.text ?? it.message ?? '');      // 取最后一条
      }
      // 错误项要带出来，否则失败时只剩一句"没有返回内容"
      if (o.type === 'item.completed' && it?.type === 'error' && it.message
          && !/bypass-hook-trust/.test(it.message)) {
        answer = answer || '';
        sid = sid || '';
        if (!answer) usage = usage || null;
      }
    }
    return {
      answer: answer.trim(),
      meta: {
        sessionId: sid,
        cacheRead: usage?.cached_input_tokens ?? 0,
        cacheWrite: usage?.cache_write_input_tokens ?? 0,
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
  agent, prompt, sessionId, resume = false, notesDir = '',
  maxTurns = 12, timeoutMs = 240000, env = {}, onProgress,
}) {
  const a = AGENTS[agent];
  if (!a) throw err(`未知 agent：${agent}`, 'BAD_AGENT');

  const sid = sessionId || (agent === 'claude' ? randomUUID() : '');
  const { argv, stdin } = argvFor(agent, { prompt, sessionId: sid, resume, notesDir, maxTurns });
  if (!stdin && prompt.length > ARGV_MAX) {
    throw err(
      `${a.label} 只能用命令行参数传 prompt，而本次有 ${prompt.length} 字符，超过 ${ARGV_MAX} 上限。`
      + '把配置里的「每段字符数」调小，或换成 Claude Code / Codex（它们走 stdin）。',
      'AGENT_PROMPT_TOO_LONG');
  }

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(a.bin, argv, {
        env: childEnv(env),
        // cwd 用 /tmp：agent 会读 cwd 下的项目配置（CLAUDE.md/AGENTS.md 等），
        // 指到仓库里会把无关上下文灌进去，还多给一片可读目录
        cwd: '/tmp',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      return reject(err(`起 ${a.bin} 失败：${e.message}（装了吗？）`, 'AGENT_SPAWN'));
    }

    let out = '', errBuf = '', done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000);
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
      done = true; clearTimeout(timer);
      reject(err(`${a.bin} 执行失败：${e.message}`, 'AGENT_SPAWN'));
    });
    child.on('close', (code) => {
      if (done) return;
      done = true; clearTimeout(timer);
      try {
        const { answer, meta } = parseOut(agent, out);
        if (!answer) {
          return reject(err(
            `${a.label} 没有返回内容（退出码 ${code}）${errBuf ? `：${errBuf.slice(-300)}` : ''}`,
            'AGENT_EMPTY'));
        }
        resolve({ answer, agent, sessionId: meta.sessionId || sid, ...meta });
      } catch (e) {
        reject(e.code ? e : err(`解析 ${a.label} 输出失败：${e.message}`, 'AGENT_PARSE'));
      }
    });

    child.stdin.on('error', () => { /* agent 提前退出时的 EPIPE，忽略 */ });
    // 走 argv 的 agent 也要关掉 stdin，否则它可能一直等输入
    child.stdin.end(stdin ? prompt : '');
  });
}

export { argvFor as _argvFor };
