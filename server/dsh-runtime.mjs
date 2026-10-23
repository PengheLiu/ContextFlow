// Own a Web backend from the installed desktop runtime (and the legacy CLI).
// Never attach to or stop the user's existing desktop process.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { statSync, mkdtempSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import WebSocket from 'ws';
import { resolveDshInstallation } from './dsh-installation.mjs';
import { createDshConnectionTester } from './dsh-connection-test.mjs';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execAgent, spawnAgent, terminateTree } from './platform.mjs';

const execFileAsync = promisify(execAgent);
const fail = (message, code = 'AGENT_ERROR', extra = {}) => Object.assign(new Error(message), { code, ...extra });
const MAX_FRAME = 2 * 1024 * 1024;
const MAX_ANSWER = 1024 * 1024;
const deferred = () => {
  let resolvePromise, reject;
  const promise = new Promise((resolve, rejectPromise) => { resolvePromise = resolve; reject = rejectPromise; });
  promise.catch(() => {});
  return { promise, resolve: resolvePromise, reject };
};

function stamp(path) {
  try { const s = statSync(path); return [s.mtimeMs, s.size, s.ino]; } catch { return null; }
}
function identity(options) {
  const env = options.env || {};
  const installation = resolveDshInstallation({ env, bin: options.bin });
  const bin = installation.bin;
  const cwd = resolve(options.notesDir || tmpdir());
  const dshHome = env.DSH_HOME || join(env.HOME || homedir(), '.dsh');
  const profile = options.profile || 'safe';
  const stable = {
    bin, binary: stamp(bin), bundle: installation.appPath ? stamp(join(installation.appPath, 'Contents/Resources/app.asar')) : null, cwd, notesDir: options.notesDir ? cwd : null, profile, dshHome,
    env: Object.entries(env).sort(([a], [b]) => a.localeCompare(b)),
  };
  const lockKey = createHash('sha256').update(JSON.stringify(stable)).digest('hex');
  const key = createHash('sha256').update(JSON.stringify({
    ...stable,
    // Stat only: authentication material never enters this process or its logs.
    config: ['cordis.patch.yml', '.credentials.yaml', 'settings.yaml', 'profiles/web/cordis.patch.yml', 'profiles/web/package.json', 'profiles/desktop/cordis.patch.yml', 'profiles/desktop/package.json']
      .map(path => stamp(join(dshHome, path))),
  })).digest('hex');
  return { key, lockKey, bin, env, cwd, profile, dshHome, appPath: installation.appPath, source: installation.source };
}

async function probeVersion(id, signal) {
  const { stdout } = await execFileAsync(id.bin, ['--version'], {
    env: id.env, timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 65536, signal,
  });
  return stdout.trim();
}
function rpcFailure(error) {
  const message = String(error?.message || 'DSH 请求失败').slice(0, 500);
  if (/unauthori[sz]ed|authentication|not logged in|api.?key|\b401\b/i.test(message)) {
    return fail('DSH 登录或认证失败，请检查所选 DSH 配置目录', 'AGENT_AUTH');
  }
  return fail(message, 'DSH_RPC', { rpcCode: error?.code });
}

class DshServer {
  constructor(id, runtime) {
    Object.assign(this, id);
    this.runtime = runtime;
    this.sessions = new Map();
    this.owned = new Set();
    this.active = null;
    this.dead = false;
    this.createdSessions = 0;
    this.stdout = '';
    this.stderr = '';
    this.endpoint = deferred();
    this.death = deferred();
    this.controller = new AbortController();
    this.sockets = new Set();
    const resources = this.appPath && join(this.appPath, 'Contents/Resources');
    const bundle = resources && join(resources, 'app.asar/dsh');
    const executable = this.modern ? join(this.appPath, 'Contents/MacOS/DeepSeek Harness') : this.bin;
    const argv = this.modern ? ['--expose-internals', fileURLToPath(new URL('./dsh-desktop-host.mjs', import.meta.url)),
      bundle, join(this.dshHome, 'profiles/desktop'), join(resources, 'runtime/primary-runtime'),
      join(resources, 'runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs'), join(resources, 'runtime/bin')]
      : ['--profile', 'web', '--host', '127.0.0.1', '--port', '0'];
    this.stateDir = this.modern ? mkdtempSync(join(tmpdir(), 'contextflow-dsh-worker-')) : null;
    try { this.child = runtime.spawnProcess(executable, argv, {
      env: this.modern ? { ...this.env, ELECTRON_RUN_AS_NODE: '1', DSH_CLIENT_VERSION: '0.2.1-rc.2', CONTEXTFLOW_DSH_STATE_DIR: this.stateDir } : this.env,
      cwd: this.cwd, stdio: ['ignore', 'pipe', 'pipe', ...(this.modern ? ['ipc'] : [])],
    }); } catch (error) {
      if (this.stateDir) rmSync(this.stateDir, { recursive: true, force: true });
      throw error;
    }
    if (this.modern) this.child.on('message', message => {
      if (message?.type === 'ready') {
        if (message.profile !== 'desktop' || message.backgroundScheduling !== false) {
          this.destroy(fail('DSH 桌面工作进程未确认配置隔离', 'DSH_DESKTOP_START')); return;
        }
        this.readEndpoint(message.url);
      }
      else if (message?.type === 'fatal') this.destroy(fail('DSH 桌面运行时启动失败，请先打开桌面版完成配置', 'DSH_DESKTOP_START'));
      // Platform-session IPC may contain credentials for the desktop UI. Ignore
      // it completely: the backend resolves its own login without our handling it.
    });
    runtime.children.add(this);
    this.closedPromise = new Promise(resolveClosed => this.child.once('close', async () => {
      if (this.stateDir) await rm(this.stateDir, { recursive: true, force: true }).catch(() => {});
      runtime.children.delete(this); resolveClosed();
    }));
    this.child.stdout.setEncoding?.('utf8');
    this.child.stdout.on('data', chunk => this.readStdout(String(chunk)));
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + String(chunk)).slice(-4000); });
    this.child.on('error', () => this.destroy(fail('无法启动 DeepSeek Harness', 'AGENT_SPAWN')));
    this.child.on('close', () => this.destroy(!this.initialized && /unknown (?:option|profile)|unrecognized|unexpected argument/i.test(this.stderr)
      ? fail('当前 DSH 不支持已验证的常驻接口', this.modern ? 'DSH_DESKTOP_UNSUPPORTED' : 'DSH_UNSUPPORTED', { submitted: false })
      : fail('DSH 进程已退出，本次任务不会自动重放', 'DSH_DISCONNECTED')));
    this.ready = this.initialize();
    this.ready.catch(() => {});
  }

  readStdout(chunk) {
    this.stdout += chunk;
    let at;
    while ((at = this.stdout.indexOf('\n')) >= 0) {
      const line = this.stdout.slice(0, at).trim(); this.stdout = this.stdout.slice(at + 1);
      // Desktop readiness comes solely from its owned IPC channel.
      if (!this.modern && line.startsWith('dsh web: ')) this.readEndpoint(line.slice(9));
      if (line.length > 65536) return this.destroy(fail('DSH 日志超过长度限制', 'AGENT_OUTPUT_LIMIT'));
    }
    if (this.stdout.length > 65536) this.destroy(fail('DSH 日志超过长度限制', 'AGENT_OUTPUT_LIMIT'));
  }

  readEndpoint(value) {
    if (this.base || typeof value !== 'string') return;
    const found = (this.modern
      ? /^http:\/\/127\.0\.0\.1:(\d{1,5})\/\?token=([A-Za-z0-9_-]{16,256})$/
      : /^http:\/\/127\.0\.0\.1:(\d{1,5})\/?$/).exec(value);
    if (!found || Number(found[1]) < 1 || Number(found[1]) > 65535) {
      this.destroy(fail('DSH 返回了无效的本地服务地址', 'DSH_PROTOCOL')); return;
    }
    this.base = `http://127.0.0.1:${Number(found[1])}`;
    this.launchToken = found[2]; this.endpoint.resolve(this.base);
  }

  async initialize() {
    const timer = setTimeout(() => this.destroy(fail('DSH 常驻服务启动超时', 'DSH_START_TIMEOUT')), this.runtime.startupMs);
    try {
      await Promise.race([this.endpoint.promise, this.death.promise]);
      if (this.modern) {
        await Promise.race([this.connectOperator(), this.death.promise]);
        await Promise.race([this.openFeed('remote'), this.death.promise]);
      } else await Promise.race([
        Promise.all([this.openFeed('mux'), this.openFeed('host')]), this.death.promise,
      ]);
      this.initialized = true;
    } finally { clearTimeout(timer); }
  }

  async connectOperator() {
    // Exchange only the token received from our own child. No desktop cookies,
    // existing ports, redirects, or user credential files are inspected.
    const token = this.launchToken; this.launchToken = null;
    const response = await this.runtime.fetcher(`${this.base}/connect?token=${token}&interactions=none`, {
      method: 'GET', redirect: 'manual', signal: this.controller.signal,
    });
    try {
      const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
      if (response.status !== 302 || response.headers.get('location') !== './api/remote.mux'
        || !cookie || cookie.length > 8192 || !/^[A-Za-z0-9_-]+=[A-Za-z0-9_.-]+$/.test(cookie)) {
        throw fail('DSH 桌面运行时认证失败', 'AGENT_AUTH');
      }
      this.cookie = cookie;
    } finally { await response.body?.cancel(); }
  }

  follow(sessionId) {
    this.unfollow();
    const following = { streamId: randomUUID(), sessionId, ready: deferred(), opened: false };
    this.following = following;
    this.mux.send(JSON.stringify({ type: 'open', streamId: following.streamId, endpoint: 'session/follow',
      payload: { args: { request: { address: { kind: 'session', sessionId }, assistantStream: true, maxMessages: 1 } } } }));
    this.mux.send(JSON.stringify({ type: 'end', streamId: following.streamId }));
    return following.ready.promise;
  }

  unfollow() {
    const following = this.following; this.following = null;
    if (following && !this.dead) {
      try { this.mux.send(JSON.stringify({ type: 'cancel', streamId: following.streamId })); } catch { /* closing */ }
    }
  }

  receiveModern(message) {
    const following = this.following;
    if (!following || message?.streamId !== following.streamId) return;
    if (message.type === 'error') { this.destroy(rpcFailure(message.error)); return; }
    if (message.type === 'end') { this.destroy(fail('DSH 会话事件流提前结束', 'DSH_DISCONNECTED')); return; }
    if (message.type !== 'item' || !message.value) throw fail('DSH 事件信封无效', 'DSH_PROTOCOL');
    const value = message.value;
    if (value.type === 'snapshot') {
      if (following.opened || value.header?.id !== following.sessionId || !Number.isSafeInteger(value.cursor)) {
        throw fail('DSH 会话快照无效', 'DSH_PROTOCOL');
      }
      following.opened = true; this.active?.baseline(value); following.ready.resolve(); return;
    }
    if (!following.opened) throw fail('DSH 会话事件缺少初始快照', 'DSH_PROTOCOL');
    if (value.type === 'event') this.active?.receive({ type: 'session/event', sessionId: following.sessionId, event: value.event });
    else if (value.type === 'assistant-stream') this.active?.receive({ ...value, sessionId: following.sessionId });
  }

  openFeed(kind) {
    const opened = deferred();
    let socket;
    try { socket = this.runtime.createSocket(`${this.base.replace('http:', 'ws:')}/api/${this.modern ? 'remote.mux' : `events.${kind}`}`,
      this.modern ? { headers: { Cookie: this.cookie }, maxPayload: MAX_FRAME } : undefined); }
    catch { opened.reject(fail('DSH 事件连接失败', 'DSH_DISCONNECTED')); return opened.promise; }
    this.sockets.add(socket);
    if (this.modern) this.mux = socket;
    socket.addEventListener('open', () => opened.resolve());
    socket.addEventListener('message', event => {
      if (this.dead) return;
      if (typeof event.data !== 'string' || event.data.length > MAX_FRAME) {
        this.destroy(fail('DSH 事件超过长度限制或格式无效', 'DSH_PROTOCOL')); return;
      }
      try { this.modern ? this.receiveModern(JSON.parse(event.data)) : this.receive(JSON.parse(event.data)); }
      catch { this.destroy(fail('DSH 返回了无效的事件', 'DSH_PROTOCOL')); }
    });
    const disconnected = () => {
      this.sockets.delete(socket);
      const error = fail('DSH 事件连接已断开，本次任务不会自动重放', 'DSH_DISCONNECTED');
      opened.reject(error);
      if (!this.dead) this.destroy(error);
    };
    socket.addEventListener('error', disconnected);
    socket.addEventListener('close', disconnected);
    // The feeds are downlink-only: no subscription or keepalive messages.
    return opened.promise;
  }

  async post(path, body, timeoutMs = this.runtime.rpcTimeoutMs) {
    if (this.dead) throw fail('DSH 连接已断开', 'DSH_DISCONNECTED');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.runtime.fetcher(this.base + path, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(this.cookie ? { Cookie: this.cookie } : {}) },
        body: JSON.stringify(body), redirect: 'error',
        signal: AbortSignal.any([this.controller.signal, controller.signal]),
      });
      if ([401, 403].includes(response.status)) throw fail('DSH 拒绝了本地连接，请检查认证与访问设置', 'AGENT_AUTH');
      if (response.status === 404 && path === '/api/session.create') {
        throw fail('当前 DSH 缺少所需的会话接口', 'DSH_UNSUPPORTED', { submitted: false });
      }
      if (!response.ok) throw fail(`DSH 请求失败（HTTP ${response.status}）`, 'DSH_RPC');
      const reader = response.body?.getReader();
      if (!reader) throw fail('DSH 返回空响应', 'DSH_PROTOCOL');
      const decoder = new TextDecoder(); let text = '';
      try {
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          text += decoder.decode(part.value, { stream: true });
          if (text.length > MAX_FRAME) throw fail('DSH 响应超过长度限制', 'AGENT_OUTPUT_LIMIT');
        }
        text += decoder.decode();
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      try { return JSON.parse(text); } catch { throw fail('DSH 返回了无效响应', 'DSH_PROTOCOL'); }
    } catch (error) {
      if (error.code && error.name !== 'AbortError') throw error;
      if (controller.signal.aborted) throw fail('DSH 请求超时', 'DSH_RPC_TIMEOUT');
      throw fail('DSH 本地连接已中断', 'DSH_DISCONNECTED');
    } finally { clearTimeout(timer); }
  }

  async rpc(method, payload, rpcId = randomUUID()) {
    const endpoint = this.modern ? method.replace('.', '/') : method;
    const request = this.modern ? { args: { request: { ...payload, ...(method === 'session.prompt' ? { requestId: rpcId } : {}) } } } : payload;
    const result = await this.post(`/api/${endpoint}`, { type: 'client-request', rpcId, method: endpoint, payload: request });
    if (result?.type !== 'server-response' || result.rpcId !== rpcId || typeof result.result?.ok !== 'boolean') {
      throw fail('DSH 响应与请求不匹配', 'DSH_PROTOCOL');
    }
    if (!result.result.ok) throw rpcFailure(result.result.error);
    return result.result.value;
  }

  receive(envelope) {
    if (envelope?.type !== 'server-request' || !envelope.payload || envelope.method !== envelope.payload.type) {
      throw fail('DSH 事件信封无效', 'DSH_PROTOCOL');
    }
    const p = envelope.payload;
    if (p.type === 'stream/error') { this.destroy(rpcFailure(p.error)); return; }
    if (!this.owned.has(p.sessionId)) return;
    if (p.type === 'approval/requested' || p.type === 'question/requested') {
      const result = p.type === 'approval/requested'
        ? { ok: true, value: { sessionId: p.sessionId, approvalId: p.approvalId, outcome: 'rejected' } }
        : { ok: false, error: { code: 'cancelled', message: 'ContextFlow 暂不支持交互问答', details: {} } };
      this.post('/api/respond', { type: 'client-response', rpcId: envelope.rpcId, result })
        .catch(error => { if (!this.dead) this.destroy(error); });
      this.active?.emit({ type: 'status', text: '需要额外授权或输入的操作未执行' });
      return;
    }
    if (p.type === 'host/agent-error') { this.destroy(rpcFailure({ message: p.message })); return; }
    this.active?.receive(p);
  }

  idle() {
    clearTimeout(this.idleTimer);
    if (!this.dead) {
      this.idleTimer = setTimeout(() => this.destroy(), this.runtime.idleMs);
      this.idleTimer.unref?.();
    }
  }

  destroy(error = fail('DSH 会话已释放', 'DSH_DISCONNECTED')) {
    if (this.dead) return this.closedPromise;
    this.dead = true; clearTimeout(this.idleTimer);
    this.sessions.clear(); this.owned.clear(); this.controller.abort(); this.death.reject(error);
    this.following?.ready.reject(error); this.following = null; this.cookie = null; this.launchToken = null;
    if (this.runtime.servers.get(this.key) === this) this.runtime.servers.delete(this.key);
    this.active?.reject(error); this.active = null;
    for (const socket of this.sockets) try { socket.close(); } catch { /* closing */ }
    this.sockets.clear();
    if (this.child.exitCode == null && this.child.signalCode == null) {
      terminateTree(this.child);
      const timer = setTimeout(() => {
        if (this.child.exitCode == null && this.child.signalCode == null) terminateTree(this.child, 'SIGKILL');
      }, this.runtime.interruptMs);
      timer.unref?.(); this.child.once('close', () => clearTimeout(timer));
    }
    return this.closedPromise;
  }
}

export function createDshRuntime({ spawnProcess = spawnAgent, fetcher = fetch,
  createSocket = (url, options) => new WebSocket(url, options), checkVersion = probeVersion,
  idleMs = 5 * 60 * 1000, startupMs = 30000, rpcTimeoutMs = 30000,
  interruptMs = 2000, maxServers = 3, maxSessions = 32,
} = {}) {
  const connectionTester = createDshConnectionTester({ spawnProcess, checkVersion, interruptMs });
  const runtime = { spawnProcess, fetcher, createSocket, checkVersion, idleMs, startupMs, rpcTimeoutMs,
    interruptMs, servers: new Map(), children: new Set(), probes: new Set(), closed: false };
  const locks = new Map();

  function getSession(options) {
    if (!options.contextKey || options.connectionTest || options.profile !== 'full') return null;
    const server = runtime.servers.get(identity(options).key);
    const cached = server?.sessions.get(options.contextKey);
    return cached && !server.dead ? { ...cached.state, sessionId: cached.sessionId } : null;
  }

  async function run(options) {
    if (options.connectionTest) return connectionTester.run(options);
    if (options.profile !== 'full' || options.connectionTest) throw fail('DeepSeek Harness 的安全权限边界未验证，仅可在高级完整权限中使用', 'AGENT_SAFE_UNSUPPORTED');
    const id = identity(options);
    const previous = locks.get(id.lockKey) || Promise.resolve();
    let release; const lock = new Promise(resolveLock => { release = resolveLock; });
    locks.set(id.lockKey, lock); await previous;
    try {
      if (runtime.closed) throw fail('DSH 服务已关闭', 'DSH_DISCONNECTED');
      if (options.signal?.aborted) throw fail('已取消', 'ABORTED');
      // A previous queued turn may have bootstrapped profile files meanwhile.
      return await execute(identity(options), options);
    } finally { release(); if (locks.get(id.lockKey) === lock) locks.delete(id.lockKey); }
  }

  async function execute(id, options) {
    const startedAt = Date.now(); let firstOutputMs = null, startupMs = 0, submitted = false;
    const done = deferred(), interrupted = deferred(), versionController = new AbortController();
    let server, timer, sessionId, cancelPending, stoppedError;
    const emit = event => {
      if (event.type === 'answer' && event.text && firstOutputMs === null) firstOutputMs = Date.now() - startedAt;
      try { options.onEvent?.(event); } catch { /* observers cannot break a task */ }
    };
    const stop = error => {
      if (stoppedError) return;
      stoppedError = error;
      if (submitted && sessionId && server && !server.dead) {
        cancelPending ||= server.rpc('session.cancel', { sessionId }).catch(() => {});
      }
      interrupted.reject(error);
      versionController.abort();
      if (!submitted) server?.destroy(error);
    };
    const onAbort = () => stop(fail('已取消', 'ABORTED'));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => stop(fail('DSH 超过本次任务时限，已中止', 'AGENT_TIMEOUT')), options.timeoutMs || 240000);
    try {
      server = runtime.servers.get(id.key);
      if (server && server.createdSessions >= maxSessions && !server.sessions.has(options.contextKey)) { server.destroy(); server = null; }
      if (!server) {
        // Desktop's bundled Host and the legacy Web profile use different
        // protocols. Verify the release before launching either carrier.
        const checking = Promise.resolve().then(() => runtime.checkVersion(id, versionController.signal));
        const probe = { promise: checking, stop: () => stop(fail('DSH 服务已关闭', 'DSH_DISCONNECTED')) };
        runtime.probes.add(probe);
        checking.then(() => runtime.probes.delete(probe), () => runtime.probes.delete(probe));
        const version = await Promise.race([checking, interrupted.promise]);
        if (!['0.1.0-rc.6', '0.2.1-rc.2'].includes(version)) throw fail('该 DSH 版本尚未验证常驻协议', id.source === 'desktop' ? 'DSH_DESKTOP_UNSUPPORTED' : 'DSH_UNSUPPORTED', { submitted: false });
        id.modern = version === '0.2.1-rc.2';
        if (id.modern && !id.appPath) throw fail('请安装并选择 DeepSeek Harness 桌面版', 'DSH_DESKTOP_UNSUPPORTED', { submitted: false });
        if (runtime.closed || options.signal?.aborted) throw fail('已取消', 'ABORTED');
        for (const old of runtime.servers.values()) {
          if (runtime.servers.size < maxServers) break;
          if (!old.active) old.destroy();
        }
        emit({ type: 'status', text: '正在连接 DeepSeek Harness…' });
        server = new DshServer(id, runtime); runtime.servers.set(id.key, server);
      }
      clearTimeout(server.idleTimer);
      let observedTurn, boundTurn, lastSeq = -1, step = null, streamAttempt, streamIndex = 0, streamRevision = 0, committed = '', preview = '';
      const promptId = randomUUID(), blocks = new Map(), usages = new Map();
      const usage = () => usages.size ? [...usages.values()].reduce((sum, value) => ({
        in: sum.in + (value.uncachedInputTokens ?? value.inputTokens) + (value.cacheReadTokens || 0) + (value.cacheWriteTokens || 0),
        out: sum.out + value.outputTokens, cacheRead: sum.cacheRead + (value.cacheReadTokens || 0),
        cacheWrite: sum.cacheWrite + (value.cacheWriteTokens || 0),
      }), { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }) : undefined;
      const updateUsage = (key, value) => {
        if (Number.isFinite(value?.uncachedInputTokens ?? value?.inputTokens) && Number.isFinite(value?.outputTokens)) {
          usages.set(key, value); emit({ type: 'usage', usage: usage() });
        }
      };
      const answer = text => {
        if (text.length > MAX_ANSWER) { stop(fail('DSH 回答超过长度限制', 'AGENT_OUTPUT_LIMIT')); return; }
        if (text) emit({ type: 'answer', text });
      };
      const active = { emit, baseline(snapshot) { lastSeq = snapshot.cursor; streamRevision = snapshot.assistantStream?.revision || 0; }, reject: error => { stoppedError ||= error; interrupted.reject(error); }, receive(p) {
        if (!sessionId || p.sessionId !== sessionId) return;
        if (p.type === 'assistant-stream') {
          const frame = p.frame;
          if (!Number.isSafeInteger(frame?.revision) || frame.revision <= streamRevision) return;
          if (frame.revision !== streamRevision + 1) { stop(fail('DSH 增量事件不连续', 'DSH_PROTOCOL')); return; }
          streamRevision = frame.revision;
          if (frame.type === 'start') {
            streamAttempt = frame.turn === boundTurn ? { id: frame.attemptId, turn: frame.turn, step: frame.step } : null; streamIndex = 0;
            if (streamAttempt) { step = frame.step; blocks.clear(); preview = ''; }
            return;
          }
          if (!streamAttempt || frame.attemptId !== streamAttempt.id) return;
          if (frame.type === 'end') { streamAttempt = null; return; }
          if (frame.type !== 'chunk' || frame.index !== streamIndex++) { stop(fail('DSH 增量事件顺序无效', 'DSH_PROTOCOL')); return; }
          active.chunk({ turn: streamAttempt.turn, step: streamAttempt.step, chunk: frame.chunk });
          return;
        }
        if (p.type !== 'session/event') return;
        const event = p.event;
        if (!Number.isSafeInteger(event?.seq) || event.seq <= lastSeq) return;
        lastSeq = event.seq;
        const d = event.data || {};
        if (event.type === 'turn/start') { observedTurn = d.turn; return; }
        if (event.type === 'user/message' && d.source?.rpcId === promptId) {
          boundTurn = observedTurn; return;
        }
        if (boundTurn === undefined || d.turn !== boundTurn) return;
        if (event.type === 'assistant/chunk') { active.chunk(d);        } else if (event.type === 'assistant/message') {
          committed = (d.message?.content || []).filter(block => block.type === 'text').map(block => String(block.text || '')).join('');
          answer(committed); updateUsage(d.step, d.usage);
        } else if (event.type === 'tool/call') emit({ type: 'status', text: '正在调用工具查询资料…' });
        else if (event.type === 'turn/end') {
          if (d.reason?.kind !== 'completed') done.reject(fail(String(d.reason?.error?.message || 'DSH 本次任务未成功完成').slice(0, 500), d.reason?.kind === 'aborted' ? 'ABORTED' : 'AGENT_ERROR'));
          else if (!committed.trim()) done.reject(fail('DSH 没有返回完整答案', 'AGENT_EMPTY'));
          else done.resolve(committed.trim());
        }
      }, chunk(d) {
          if (d.step !== step) { step = d.step; blocks.clear(); preview = ''; }
          if (d.chunk?.type === 'text-delta') {
            blocks.set(d.chunk.index ?? 0, (blocks.get(d.chunk.index ?? 0) || '') + String(d.chunk.text || ''));
            preview = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, value]) => value).join(''); answer(preview);
          } else if (d.chunk?.type === 'reasoning-delta') emit({ type: 'status', text: '正在分析…' });
          else if (d.chunk?.type === 'usage') updateUsage(d.step, d.chunk.usage);

      } };
      server.active = active;
      await Promise.race([server.ready, interrupted.promise]); startupMs = Date.now() - startedAt;
      // A first launch creates Web-profile metadata. Record the post-boot
      // fingerprint so the next lookup sees this process, while later edits
      // still invalidate it. Locks use the stable launch identity above.
      const settled = identity(options);
      if (settled.key !== server.key) {
        if (runtime.servers.get(server.key) === server) runtime.servers.delete(server.key);
        server.key = settled.key; runtime.servers.set(server.key, server);
      }
      let cached = options.contextKey ? server.sessions.get(options.contextKey) : null;
      const resumed = !!(cached && options.expectedSessionId === cached.sessionId && typeof options.continuationPrompt === 'string');
      if (!resumed) {
        if (options.contextKey) server.sessions.delete(options.contextKey);
        const created = await Promise.race([server.rpc('session.create', { cwd: id.cwd, sessionId: `contextflow-${randomUUID()}` }), interrupted.promise]);
        if (typeof created?.sessionId !== 'string' || !created.sessionId || created.sessionId.length > 200) throw fail('DSH 未返回有效会话 ID', 'DSH_PROTOCOL');
        cached = { sessionId: created.sessionId }; server.createdSessions++;
        server.owned.add(cached.sessionId);
      }
      sessionId = cached.sessionId;
      if (server.modern) await Promise.race([server.follow(sessionId), interrupted.promise]);
      emit({ type: 'status', text: resumed ? '继续当前文章的阅读会话…' : '正在准备阅读上下文…' });
      submitted = true;
      const failed = done.promise.then(() => new Promise(() => {}));
      const accepted = await Promise.race([server.rpc('session.prompt', {
        sessionId, mode: 'queue', content: [{ type: 'text', text: resumed ? options.continuationPrompt : options.prompt }],
      }, promptId), failed, interrupted.promise]);
      // A completed event may precede the POST response. Still validate the
      // response before committing the result to the caller.
      if (accepted?.accepted !== true) throw fail('DSH 未确认接受任务', 'DSH_PROTOCOL');
      const final = await Promise.race([done.promise, interrupted.promise]);
      if (stoppedError) throw stoppedError;
      if (options.contextKey) server.sessions.set(options.contextKey, { sessionId,
        state: { ...(resumed ? options.contextState?.resumed : options.contextState?.fresh) } });
      const totalMs = Date.now() - startedAt, tokens = usage();
      return { answer: final, sessionId, resumed, ms: totalMs, transport: server.modern ? 'dsh-desktop' : 'dsh-web', persistent: !server.modern,
        timings: { startupMs, firstOutputMs, totalMs }, ...(tokens ? { usage: tokens } : {}),
        cacheRead: tokens?.cacheRead || 0, cacheWrite: tokens?.cacheWrite || 0 };
    } catch (error) {
      if (cancelPending) await new Promise(resolveCancel => {
        const deadline = setTimeout(resolveCancel, Math.min(interruptMs, 200));
        cancelPending.finally(() => { clearTimeout(deadline); resolveCancel(); });
      });
      server?.destroy(error);
      throw Object.assign(stoppedError || error, { submitted });
    } finally {
      clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort);
      if (server) { server.unfollow(); server.active = null; server.idle(); }
    }
  }

  async function close() {
    runtime.closed = true;
    const probes = [...runtime.probes]; for (const probe of probes) probe.stop();
    const children = [...runtime.children]; for (const server of children) server.destroy();
    const pending = [...children.map(server => server.closedPromise), ...probes.map(probe => probe.promise.catch(() => {}))];
    await Promise.all([connectionTester.close(), ...pending.map(completion => new Promise(resolveClosed => {
      const timer = setTimeout(resolveClosed, interruptMs + 1000);
      completion.then(() => { clearTimeout(timer); resolveClosed(); });
    }))]);
  }
  return { run, getSession, close, servers: runtime.servers };
}

const sharedRuntime = createDshRuntime();
export const runDsh = options => sharedRuntime.run(options);
export const getDshSession = options => sharedRuntime.getSession(options);
export const closeDshServers = () => sharedRuntime.close();
