// Codex's product protocol is newline-delimited JSON-RPC over a private stdio pipe.
// Threads live only in this process. The reading database remains the durable source
// for rebuilding context after idle shutdown, cancellation, or a Codex upgrade.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createCodexNoteTools } from './codex-note-tools.mjs';
import { findExecutable, spawnAgent, terminateTree } from './platform.mjs';

const fail = (message, code = 'AGENT_ERROR', extra = {}) => Object.assign(new Error(message), { code, ...extra });
const MAX_LINE = 32 * 1024 * 1024;
const MAX_ANSWER = 1024 * 1024;
// app-server has no equivalent of exec --ignore-rules. Explicit execpolicy allow
// rules can bypass a shell sandbox, so Safe replaces executable tools with the
// application's bounded note-reading tools instead of trusting read-only alone.
const SAFE_DISABLED_FEATURES = ['shell_tool', 'unified_exec', 'js_repl', 'code_mode',
  'code_mode_only', 'js_repl_tools_only', 'multi_agent', 'multi_agent_v2', 'computer_use'];
const toolStatuses = {
  commandExecution: '正在读取或检索资料…', webSearch: '正在搜索相关资料…',
  mcpToolCall: '正在查询已连接的工具…', dynamicToolCall: '正在查询阅读资料…',
  fileChange: '正在处理文件…', reasoning: '正在分析…',
};

export function resolveCodexExecutable(env = process.env, requested) {
  if (requested) return requested;
  const candidates = [findExecutable('codex', { env })].filter(Boolean);
  if (process.platform === 'darwin') {
    for (const root of ['/Applications', join(env.HOME || homedir(), 'Applications')]) {
      candidates.push(join(root, 'ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'));
      candidates.push(join(root, 'Codex.app/Contents/Resources/codex'));
    }
    candidates.push('/opt/homebrew/bin/codex', '/usr/local/bin/codex');
  }
  for (const candidate of candidates) {
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* next installation */ }
  }
  return 'codex';
}

function fileStamp(path) {
  try { const s = statSync(path); return [s.mtimeMs, s.size, s.ino]; } catch { return null; }
}

function identity(options) {
  const env = options.env || {};
  const bin = resolveCodexExecutable(env, options.bin);
  const cwd = resolve(options.notesDir || tmpdir());
  const notesRoot = options.notesDir ? resolve(options.notesDir) : null;
  const profile = options.connectionTest ? 'safe' : options.profile || 'safe';
  const codexHome = env.CODEX_HOME || join(env.HOME || homedir(), '.codex');
  // Hash the environment rather than retaining credentials in diagnostic keys.
  // Only metadata is read: never inspect the contents of auth.json/config.toml.
  const key = createHash('sha256').update(JSON.stringify({
    bin, cwd, notesRoot, profile, env: Object.entries(env).sort(([a], [b]) => a.localeCompare(b)),
    config: fileStamp(join(codexHome, 'config.toml')),
    auth: fileStamp(join(codexHome, 'auth.json')),
  })).digest('hex');
  return { key, bin, cwd, profile, env };
}

function usageOf(value) {
  if (!value) return undefined;
  return {
    in: Number(value.inputTokens) || 0, out: Number(value.outputTokens) || 0,
    cacheRead: Number(value.cachedInputTokens) || 0,
    cacheWrite: Number(value.cacheWriteInputTokens) || 0,
  };
}

function rpcError(error, method) {
  const message = String(error?.message || 'Codex 请求失败').slice(0, 500);
  if (error?.code === -32601 && ['initialize', 'thread/start'].includes(method)) {
    return fail('当前 Codex 不支持所需的 app-server 协议，请更新 Codex', 'CODEX_UNSUPPORTED', { submitted: false });
  }
  if (/not logged in|unauthorized|authentication|\b401\b|please.{0,15}login/i.test(message)) {
    return fail('Codex 登录或认证失败，请确认所选配置目录已登录', 'AGENT_AUTH');
  }
  return fail(message, 'CODEX_RPC', { rpcCode: error?.code });
}

class Server {
  constructor(id, runtime) {
    Object.assign(this, id);
    this.runtime = runtime;
    this.pending = new Map();
    this.sessions = new Map();
    this.sequence = 0;
    this.dead = false;
    this.buffer = '';
    this.stderr = '';
    this.active = null;
    this.createdThreads = 0;
    const argv = ['app-server', '--listen', 'stdio://'];
    if (this.profile === 'safe') for (const feature of SAFE_DISABLED_FEATURES) argv.push('--disable', feature);
    this.child = runtime.spawnProcess(this.bin, argv, {
      env: this.env, cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'],
    });
    runtime.children.add(this);
    this.closedPromise = new Promise(resolveClosed => this.child.once('close', () => {
      runtime.children.delete(this);
      resolveClosed();
    }));
    this.child.stdout.setEncoding?.('utf8');
    this.child.stdout.on('data', data => this.read(String(data)));
    this.child.stderr.on('data', data => { this.stderr = (this.stderr + String(data)).slice(-4000); });
    this.child.stdin.on('error', () => this.destroy(fail('Codex 连接已断开', 'CODEX_DISCONNECTED')));
    this.child.on('error', error => this.destroy(fail(`无法启动 Codex：${error.message}`, 'AGENT_SPAWN')));
    this.child.on('close', () => {
      const unsupported = !this.initialized && /unrecognized subcommand|unexpected argument|unknown (?:command|option|feature)/i.test(this.stderr);
      this.destroy(unsupported
        ? fail('当前 Codex 不支持 app-server，请更新 Codex', 'CODEX_UNSUPPORTED', { submitted: false })
        : fail('Codex 进程已退出，请重试；本次任务不会自动重放', 'CODEX_DISCONNECTED'));
    });
    this.ready = this.initialize();
    // A cancellation may terminate startup before its caller awaits ready.
    this.ready.catch(() => {});
  }

  async initialize() {
    await this.rpc('initialize', {
      clientInfo: { name: 'contextflow', title: 'ContextFlow', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized');
    this.initialized = true;
  }

  send(message) {
    if (this.dead) throw fail('Codex 连接已断开', 'CODEX_DISCONNECTED');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  notify(method, params) { this.send({ method, ...(params ? { params } : {}) }); }

  rpc(method, params = {}, timeoutMs = this.runtime.rpcTimeoutMs) {
    return new Promise((resolveRpc, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(fail(`Codex ${method} 请求超时`, 'CODEX_RPC_TIMEOUT'));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: resolveRpc, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  read(data) {
    this.buffer += data;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      if (line.length > MAX_LINE) return this.destroy(fail('Codex 返回内容过大', 'AGENT_OUTPUT_LIMIT'));
      let message;
      try { message = JSON.parse(line); }
      catch { return this.destroy(fail('Codex 返回了无效的协议消息', 'CODEX_PROTOCOL')); }
      this.receive(message);
    }
    if (this.buffer.length > MAX_LINE) this.destroy(fail('Codex 返回内容过大', 'AGENT_OUTPUT_LIMIT'));
  }

  receive(message) {
    if (message.method && message.id !== undefined) {
      // No interactive approval UI in this version. Never auto-approve a request
      // merely because it arrived over our trusted transport.
      const method = message.method;
      if (method === 'item/tool/call') {
        const active = this.active;
        const p = message.params || {};
        const reply = async () => {
          try {
            if (!active?.noteTools || p.threadId !== active.threadId || !active.turnId || p.turnId !== active.turnId) {
              throw Error('不允许调用此工具或该请求所属的任务已结束');
            }
            const args = typeof p.arguments === 'string' ? JSON.parse(p.arguments) : p.arguments;
            const value = await active.noteTools.call(p.tool, args);
            return { success: true, contentItems: [{ type: 'inputText', text: typeof value === 'string' ? value : JSON.stringify(value) }] };
          } catch (error) {
            return { success: false, contentItems: [{ type: 'inputText', text: String(error.message || '笔记读取失败').slice(0, 500) }] };
          }
        };
        reply().then(result => { if (!this.dead && this.active === active) this.send({ id: message.id, result }); }).catch(() => {});
        return;
      }
      let result;
      if (method === 'item/permissions/requestApproval') result = { permissions: {}, scope: 'turn' };
      else if (/\/requestApproval$/.test(method)) result = { decision: 'decline' };
      else if (method === 'mcpServer/elicitation/request') result = { action: 'decline', content: null };
      else if (method === 'item/tool/requestUserInput' || method === 'tool/requestUserInput') result = { answers: {} };
      try {
        this.send(result ? { id: message.id, result } : {
          id: message.id, error: { code: -32601, message: 'ContextFlow does not support this interactive request' },
        });
      } catch { /* process already closed */ }
      this.active?.emit({ type: 'status', text: '需要额外授权的操作未执行' });
      return;
    }
    const request = this.pending.get(message.id);
    if (request && !message.method) {
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(rpcError(message.error, request.method));
      else {
        if (request.method === 'turn/start' && message.result?.turn?.id) this.active?.acceptTurn(message.result.turn.id);
        request.resolve(message.result);
      }
      return;
    }
    this.active?.receive(message);
  }

  idle() {
    clearTimeout(this.idleTimer);
    if (!this.dead) {
      this.idleTimer = setTimeout(() => this.destroy(), this.runtime.idleMs);
      this.idleTimer.unref?.();
    }
  }

  destroy(error = fail('Codex 会话已释放', 'CODEX_DISCONNECTED')) {
    if (this.dead) return this.closedPromise;
    this.dead = true;
    clearTimeout(this.idleTimer);
    this.sessions.clear();
    if (this.runtime.servers.get(this.key) === this) this.runtime.servers.delete(this.key);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.active?.reject(error);
    this.active = null;
    if (this.child.exitCode == null && this.child.signalCode == null) {
      terminateTree(this.child);
      const timer = setTimeout(() => {
        if (this.child.exitCode == null && this.child.signalCode == null) terminateTree(this.child, 'SIGKILL');
      }, this.runtime.interruptMs);
      timer.unref?.();
      this.child.once('close', () => clearTimeout(timer));
    }
    return this.closedPromise;
  }
}

/** Exported factory keeps protocol tests independent of the user's Codex login. */
export function createCodexRuntime({
  spawnProcess = spawnAgent, idleMs = 5 * 60 * 1000, rpcTimeoutMs = 30000,
  interruptMs = 2000, maxServers = 3, maxThreads = 32,
} = {}) {
  const runtime = { spawnProcess, idleMs, rpcTimeoutMs, interruptMs,
    servers: new Map(), children: new Set(), closed: false };
  const locks = new Map();

  function getSession(options) {
    if (!options.contextKey || options.connectionTest) return null;
    const server = runtime.servers.get(identity(options).key);
    const cached = server?.sessions.get(options.contextKey);
    return cached && !server.dead ? { ...cached.state, sessionId: cached.threadId } : null;
  }

  async function run(options) {
    const id = identity(options);
    const previous = locks.get(id.key) || Promise.resolve();
    let release;
    const lock = new Promise(resolveLock => { release = resolveLock; });
    locks.set(id.key, lock);
    await previous;
    try {
      if (runtime.closed) throw fail('Codex 服务已关闭', 'CODEX_DISCONNECTED');
      if (options.signal?.aborted) throw fail('已取消', 'ABORTED');
      return await execute(id, options);
    } finally {
      release();
      if (locks.get(id.key) === lock) locks.delete(id.key);
    }
  }

  async function execute(id, options) {
    const startedAt = Date.now();
    let firstOutputMs = null, startupMs = 0;
    const emit = event => {
      if (event.type === 'answer' && event.text && firstOutputMs === null) firstOutputMs = Date.now() - startedAt;
      try { options.onEvent?.(event); } catch { /* observers cannot break protocol */ }
    };
    let server = runtime.servers.get(id.key);
    if (server && server.createdThreads >= maxThreads && !server.sessions.has(options.contextKey)) {
      server.destroy(); server = null;
    }
    if (!server) {
      for (const old of runtime.servers.values()) {
        if (runtime.servers.size < maxServers) break;
        if (!old.active) old.destroy();
      }
      emit({ type: 'status', text: '正在连接 Codex…' });
      server = new Server(id, runtime);
      runtime.servers.set(id.key, server);
    }
    clearTimeout(server.idleTimer);

    let timer, interruptTimer, abortError, submitted = false, turnId;
    let rejectTurn;
    const interrupted = new Promise((_, reject) => { rejectTurn = reject; });
    interrupted.catch(() => {});
    const stop = error => {
      if (abortError) return;
      abortError = error;
      if (options.contextKey && !options.connectionTest) server.sessions.delete(options.contextKey);
      if (submitted && turnId && !server.dead) {
        // Ask for a polite interrupt, then invalidate the process in the error
        // path so no canceled turn can leak into the next queued task.
        server.rpc('turn/interrupt', { threadId: active.threadId, turnId }, interruptMs).catch(() => {});
        interruptTimer = setTimeout(() => server.destroy(error), interruptMs);
      } else server.destroy(error);
      rejectTurn(error);
    };
    const onAbort = () => stop(fail('已取消', 'ABORTED'));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => stop(fail(`Codex 超过 ${Math.round((options.timeoutMs || 240000) / 1000)}s 未完成，已中止`, 'AGENT_TIMEOUT')), options.timeoutMs || 240000);

    let finish, failTurn;
    const completion = new Promise((resolveTurn, reject) => { finish = resolveTurn; failTurn = reject; });
    completion.catch(() => {});
    const items = new Map();
    let usage;
    const visibleAnswer = () => {
      const messages = [...items.values()].filter(item => item.type === 'agentMessage' && item.phase !== 'commentary' && item.delivery !== 'async');
      const finals = messages.filter(item => item.phase === 'final_answer');
      // Older providers omit phase; the last assistant message is the best
      // terminal-answer candidate, rather than concatenating all preambles.
      return (finals.length ? finals : messages.slice(-1)).map(item => item.text || '').join('\n\n').trim();
    };
    const updateAnswer = () => {
      const text = visibleAnswer();
      if (text.length > MAX_ANSWER) return stop(fail('Codex 回答超过长度限制', 'AGENT_OUTPUT_LIMIT'));
      if (text) emit({ type: 'answer', text });
    };
    const active = {
      threadId: null, emit,
      get turnId() { return turnId; },
      acceptTurn(id) { turnId = id; },
      noteTools: null,
      reject: error => { rejectTurn(error); failTurn(error); },
      receive(message) {
        const p = message.params || {};
        if (!active.threadId || p.threadId !== active.threadId) return;
        if (p.turnId && turnId && p.turnId !== turnId) return;
        if (message.method === 'turn/started') { turnId = p.turn?.id || turnId; return; }
        if (message.method === 'item/started' || message.method === 'item/completed') {
          const item = p.item;
          if (!item?.id) return;
          if (items.size > 1000) return stop(fail('Codex 返回的事件数量超过限制', 'AGENT_OUTPUT_LIMIT'));
          items.set(item.id, { ...items.get(item.id), ...item });
          if (item.type === 'agentMessage') {
            if (item.phase === 'commentary') emit({ type: 'status', text: String(item.text || '正在分析…').slice(0, 300) });
            else updateAnswer();
          } else if (message.method === 'item/started' && toolStatuses[item.type]) {
            emit({ type: 'status', text: toolStatuses[item.type] });
          }
        } else if (message.method === 'item/agentMessage/delta') {
          const item = items.get(p.itemId) || { id: p.itemId, type: 'agentMessage', text: '' };
          item.text += String(p.delta || '');
          if (item.text.length > MAX_ANSWER) return stop(fail('Codex 输出超过长度限制', 'AGENT_OUTPUT_LIMIT'));
          items.set(p.itemId, item);
          if (item.phase !== 'commentary') updateAnswer();
        } else if (message.method === 'thread/tokenUsage/updated') {
          usage = usageOf(p.tokenUsage?.last);
          if (usage) emit({ type: 'usage', usage });
        } else if (message.method === 'turn/completed') {
          if (turnId && p.turn?.id !== turnId) return;
          for (const item of p.turn?.items || []) if (item.id) items.set(item.id, item);
          if (abortError) { failTurn(abortError); return; }
          if (p.turn?.status !== 'completed') {
            failTurn(fail(p.turn?.error?.message || 'Codex 任务未完成', p.turn?.status === 'interrupted' ? 'ABORTED' : 'AGENT_ERROR'));
          } else {
            const answer = visibleAnswer();
            if (!answer) failTurn(fail('Codex 没有返回答案', 'AGENT_EMPTY'));
            else { emit({ type: 'answer', text: answer }); finish(answer); }
          }
        } else if (message.method === 'error' && p.willRetry !== true) {
          failTurn(rpcError(p.error || p, 'turn/start'));
        }
      },
    };
    server.active = active;
    try {
      await Promise.race([server.ready, interrupted]);
      startupMs = Date.now() - startedAt;
      if (id.profile === 'safe' && !options.connectionTest) {
        server.noteTools ||= createCodexNoteTools(options.notesDir || '');
        active.noteTools = server.noteTools;
      }
      let cached = options.contextKey && !options.connectionTest ? server.sessions.get(options.contextKey) : null;
      const resumed = !!(cached && options.expectedSessionId === cached.threadId && typeof options.continuationPrompt === 'string');
      if (!resumed) {
        if (options.contextKey && !options.connectionTest) server.sessions.delete(options.contextKey);
        const result = await Promise.race([server.rpc('thread/start', {
          cwd: id.cwd, ephemeral: true, approvalPolicy: 'never',
          ...(id.profile === 'safe' || options.connectionTest ? { sandbox: 'read-only' } : {}),
          ...(id.profile === 'safe' ? {
            config: Object.fromEntries(SAFE_DISABLED_FEATURES.map(feature => [`features.${feature}`, false])),
            ...(active.noteTools?.tools?.length ? { dynamicTools: active.noteTools.tools } : {}),
          } : {}),
        }), interrupted]);
        if (!result?.thread?.id) throw fail('Codex 未返回会话 ID', 'CODEX_PROTOCOL');
        server.createdThreads++;
        cached = { threadId: result.thread.id };
      }
      active.threadId = cached.threadId;
      emit({ type: 'status', text: resumed ? '继续当前文章的阅读会话…' : '正在准备阅读上下文…' });
      submitted = true;
      const result = await Promise.race([server.rpc('turn/start', {
        threadId: cached.threadId,
        input: [{ type: 'text', text: resumed ? options.continuationPrompt : options.prompt }],
      }), interrupted]);
      turnId = result?.turn?.id || turnId;
      const answer = await Promise.race([completion, interrupted]);
      if (options.contextKey && !options.connectionTest) server.sessions.set(options.contextKey, {
        threadId: cached.threadId,
        state: { ...(resumed ? options.contextState?.resumed : options.contextState?.fresh) },
      });
      const totalMs = Date.now() - startedAt;
      return {
        answer, sessionId: cached.threadId, resumed, ms: totalMs,
        timings: { startupMs, firstOutputMs, totalMs },
        cacheRead: usage?.cacheRead || 0, cacheWrite: usage?.cacheWrite || 0,
        ...(usage ? { usage } : {}), transport: 'app-server', persistent: false,
      };
    } catch (error) {
      if (options.contextKey && !options.connectionTest) server.sessions.delete(options.contextKey);
      // Once a turn is submitted its status may be uncertain. Do not retry it or
      // retain the process/thread for the next job after a protocol failure.
      if (submitted || !server.initialized) server.destroy(error);
      throw Object.assign(error, { submitted });
    } finally {
      clearTimeout(timer); clearTimeout(interruptTimer);
      options.signal?.removeEventListener('abort', onAbort);
      if (server.active === active) server.active = null;
      server.idle();
    }
  }

  async function close() {
    runtime.closed = true;
    // Include processes already invalidated by cancellation/idle expiry. They
    // disappear from the reusable pool before their OS process has exited.
    const children = [...runtime.children];
    for (const server of children) server.destroy();
    await Promise.all(children.map(server => new Promise(resolveClosed => {
      // Keep this timer referenced so a parent shutdown cannot bypass SIGKILL.
      const deadline = setTimeout(resolveClosed, interruptMs + 1000);
      server.closedPromise.then(() => { clearTimeout(deadline); resolveClosed(); });
    })));
  }
  return { run, getSession, close, servers: runtime.servers };
}

const sharedRuntime = createCodexRuntime();
export const runCodex = options => sharedRuntime.run(options);
export const getCodexSession = options => sharedRuntime.getSession(options);
export const closeCodexServers = () => sharedRuntime.close();
