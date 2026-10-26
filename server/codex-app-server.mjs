// Codex's product protocol is newline-delimited JSON-RPC over a private stdio pipe.
// Threads live only in this process. The reading database remains the durable source
// for rebuilding context after idle shutdown, cancellation, or a Codex upgrade.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, statSync, realpathSync } from 'node:fs';
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
  try { const s = statSync(path); return [realpathSync(path), s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs]; }
  catch (error) { return ['unavailable', error.code || 'UNKNOWN']; }
}

// Shared with discovery/readiness. This opaque identity reads metadata only;
// configuration, credentials, directory names and timestamps never leave it.
export function codexConfigurationIdentity(env = process.env) {
  const userHome = resolve(tmpdir(), env.HOME || env.USERPROFILE || homedir());
  const home = resolve(tmpdir(), env.CODEX_HOME || join(userHome, '.codex'));
  return createHash('sha256').update(JSON.stringify({ home, userHome,
    config: fileStamp(join(home, 'config.toml')), auth: fileStamp(join(home, 'auth.json')),
  })).digest('hex');
}

function identity(options) {
  const env = options.env || {};
  const bin = resolveCodexExecutable(env, options.bin);
  const cwd = resolve(options.notesDir || tmpdir());
  const notesRoot = options.notesDir ? resolve(options.notesDir) : null;
  const profile = options.connectionTest ? 'safe' : options.profile || 'safe';
  // Hash the environment rather than retaining credentials in diagnostic keys.
  // Only metadata is read: never inspect the contents of auth.json/config.toml.
  const key = createHash('sha256').update(JSON.stringify({
    bin, cwd, notesRoot, profile, env: Object.entries(env).sort(([a], [b]) => a.localeCompare(b)),
    configuration: codexConfigurationIdentity(env),
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

// Provider errors can arrive as structured TurnError data or JSON embedded in
// an RPC message. Read only known diagnostic fields and return fixed wording:
// upstream bodies may contain authorization headers, URLs or personal context.
export function classifyCodexError(error, method = 'turn/start', fallback = 'CODEX_RPC') {
  if (error?.code === -32601 && ['initialize', 'thread/start'].includes(method)) {
    return fail('当前 Codex 不支持所需的 app-server 协议，请更新 Codex', 'CODEX_UNSUPPORTED', { submitted: false });
  }
  const messages = [], codes = new Set(), infos = new Set(), params = new Set(), statuses = new Set();
  const visit = (value, depth = 0) => {
    if (!value || depth > 5) return;
    if (typeof value === 'string') {
      const text = value.slice(0, 8192); messages.push(text);
      const status = text.match(/\b(?:http(?:\s+(?:error|status(?:\s+code)?))?|status(?:\s+code)?)\s*[:=]?\s*([45]\d{2})\b/i);
      if (status) statuses.add(Number(status[1]));
      const first = text.indexOf('{'), last = text.lastIndexOf('}');
      if (first >= 0 && last > first) try { visit(JSON.parse(text.slice(first, last + 1)), depth + 1); } catch { /* not JSON */ }
      return;
    }
    if (typeof value !== 'object' || Array.isArray(value)) return;
    for (const key of ['status', 'statusCode', 'httpStatusCode']) if (Number.isInteger(value[key]) && value[key] >= 400 && value[key] <= 599) statuses.add(value[key]);
    for (const key of ['code', 'type']) if (typeof value[key] === 'string') codes.add(value[key].toLowerCase());
    if (typeof value.param === 'string') params.add(value.param.toLowerCase());
    if (typeof value.codexErrorInfo === 'string') infos.add(value.codexErrorInfo);
    else if (value.codexErrorInfo && typeof value.codexErrorInfo === 'object') for (const [name, details] of Object.entries(value.codexErrorInfo)) {
      infos.add(name); visit(details, depth + 1);
    }
    for (const key of ['message', 'additionalDetails', 'error', 'data']) visit(value[key], depth + 1);
  };
  visit(error);
  const text = messages.join('\n'), hasCode = (...names) => names.some(name => codes.has(name));
  const result = (message, code) => fail(message, code, {
    ...(typeof error?.code === 'number' ? { rpcCode: error.code } : {}),
    ...(statuses.size === 1 ? { httpStatus: [...statuses][0] } : {}),
  });
  if (statuses.has(401) || infos.has('unauthorized') || hasCode('invalid_api_key', 'authentication_error', 'unauthorized', 'token_expired', 'invalid_authentication', 'invalid_token', 'authentication_failed', 'unauthenticated') || /not logged in|\bunauthori[sz]ed\b|invalid api key|authentication (?:failed|required)|please.{0,15}(?:run.{0,5})?\/?login/i.test(text)) {
    return result('Codex 登录或认证失败，请在当前配置目录完成登录，或检查所配置模型服务的凭据。', 'AGENT_AUTH');
  }
  if (statuses.has(402) || infos.has('usageLimitExceeded') || infos.has('sessionBudgetExceeded') || hasCode('insufficient_quota', 'quota_exceeded', 'billing_hard_limit_reached', 'usage_limit_reached')) return result('当前模型服务的可用额度或使用预算不足，请检查账号额度与使用限制后重试。', 'AGENT_QUOTA');
  if (statuses.has(429) || infos.has('rateLimitExceeded') || hasCode('rate_limit_exceeded', 'rate_limit_error', 'too_many_requests')) return result('当前模型服务正在限流，请稍后重试并检查账号的请求频率限制。', 'AGENT_RATE_LIMIT');
  if (hasCode('unsupported_reasoning_effort', 'reasoning_effort_not_supported') || ([...params].some(param => /^reasoning(?:[._]effort)?$/.test(param)) && hasCode('unsupported_value', 'invalid_value', 'unsupported_parameter', 'invalid_parameter', 'invalid_request_error')) || /(?:reasoning[ ._-]*(?:effort)?[^\n]{0,100}(?:not supported|unsupported|invalid|not allowed)|(?:does not support|unsupported|invalid)[^\n]{0,60}reasoning)/i.test(text)) return result('当前模型或网关不支持 Codex 配置的推理强度。请在当前 Codex 配置中选择该模型支持的推理档后重试；本次未切换模型。', 'AGENT_REASONING_UNSUPPORTED');
  if (hasCode('model_not_found', 'model_not_available', 'model_access_denied', 'unsupported_model', 'model_unavailable', 'invalid_model', 'model_not_supported') || params.has('model') && hasCode('unsupported_value', 'invalid_value', 'invalid_parameter') || /(?:model[^\n]{0,80}(?:not found|does not exist|not available|unavailable|not supported|unsupported|no access)|(?:no access|access denied)[^\n]{0,60}model)/i.test(text)) return result('当前 Codex 默认模型不存在、不可用或当前账号没有访问权限。请检查模型名称及服务端可用模型后重试。', 'AGENT_MODEL_UNAVAILABLE');
  if (hasCode('etimedout', 'esockettimedout') || statuses.has(408) || /(?:connection|request|connect|operation|read) timed? out|timeout (?:was )?reached/i.test(text)) return result('连接模型服务超时，请检查网络、代理与服务状态后重试。', 'AGENT_TIMEOUT');
  if (hasCode('econnrefused', 'enotfound', 'eai_again', 'econnreset', 'enetunreach', 'cert_has_expired', 'unable_to_verify_leaf_signature') || /connection refused|dns (?:error|failed|failure)|failed to (?:connect|resolve)|network (?:is unreachable|error)|certificate (?:verify|verification|has expired)|tls (?:error|handshake)/i.test(text) || [...infos].some(info => ['responseStreamDisconnected', 'responseStreamConnectionFailed', 'httpConnectionFailed'].includes(info)) && !statuses.size) return result('无法连接当前模型服务，或回答连接已断开。请检查网络、代理、证书和服务地址后重试。', 'AGENT_NETWORK');
  if ([...statuses].some(status => status >= 500) || infos.has('internalServerError') || infos.has('serverOverloaded')) return result('当前模型服务或网关暂时不可用，请检查服务状态，稍后重试。', 'AGENT_PROVIDER_UNAVAILABLE');
  if (statuses.has(403)) return result('当前模型服务拒绝了访问，请检查账号权限、网关访问策略与服务地址。', 'AGENT_ACCESS_DENIED');
  if (statuses.size || hasCode('invalid_request_error', 'unsupported_value', 'unsupported_parameter', 'bad_request') || infos.has('badRequest')) return result('当前模型服务拒绝了 Codex 请求。请检查服务地址、Responses 接口与当前模型配置是否兼容。（支持代码：AGENT_PROVIDER_REQUEST）', 'AGENT_PROVIDER_REQUEST');
  if ([-32700, -32600, -32601, -32602].includes(error?.code)) return result('Codex 协议消息不兼容，请更新 CLI 与 ContextFlow 后重新检测。（支持代码：CODEX_PROTOCOL）', 'CODEX_PROTOCOL');
  const code = fallback === 'AGENT_ERROR' ? 'AGENT_ERROR' : 'CODEX_RPC';
  return result(`Codex 未能完成本次请求，请查看诊断信息并联系支持。（支持代码：${code}）`, code);
}
const rpcError = (error, method) => classifyCodexError(error, method);

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
            failTurn(p.turn?.status === 'interrupted' ? fail('已取消', 'ABORTED') : classifyCodexError(p.turn?.error, 'turn/start', 'AGENT_ERROR'));
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
