import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, existsSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { readJSON } from './platform.mjs';
import { validateRequest } from './protocol.mjs';

export class ServiceManager extends EventEmitter {
  constructor({ paths, runtime, core, secretKey, terminateTree, environment = process.env, fetcher = fetch, spawnProcess = spawn }) {
    super(); Object.assign(this, { paths, runtime, core, secretKey, terminateTree, environment, fetcher, spawnProcess });
    this.state = 'stopped'; this.message = ''; this.restarts = 0; this.intentionalStop = false;
    this.token = randomBytes(32).toString('base64url');
    this.port = Number(readJSON(join(paths.data, 'config.json')).port) || 7317;
  }
  snapshot() { return { state: this.state, message: this.message, port: this.port, owned: !!this.child, health: this.lastHealth || null }; }
  update(state, message = '') {
    this.state = state; this.message = message; this.emit('status', this.snapshot());
    this.emit('changed');
  }
  async health(token = this.token) {
    try {
      const res = await this.fetcher(`http://127.0.0.1:${this.port}/health`, {
        headers: { 'X-ContextFlow': '1', Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1200), redirect: 'error',
      });
      if (res.ok) { const body = await res.json(); if (body.ok && body.serviceVersion && Array.isArray(body.capabilities)) return body; }
      return { occupied: true };
    } catch (error) { return error.name === 'TimeoutError' ? { occupied: true } : null; }
  }
  async start() {
    if (this.child || this.starting) return;
    this.starting = true; this.intentionalStop = false;
    try {
      const existing = await this.health(readJSON(join(this.paths.data, 'config.json')).token || '');
      if (this.intentionalStop) { this.update('stopped', '本地服务已停止'); return; }
      if (existing) {
        this.lastHealth = existing.ok ? existing : null;
        this.update('external', '检测到旧版服务或端口占用；未启动第二个服务。请先停止旧服务，或确认接管。'); return;
      }
      if (!existsSync(this.runtime)) throw new Error('内置运行时缺失，请重新安装完整的 ContextFlow 应用。');
      mkdirSync(this.paths.logs, { recursive: true, mode: 0o700 });
      const log = join(this.paths.logs, 'service.log');
      if (existsSync(log) && statSync(log).size > 2 * 1024 * 1024) renameSync(log, `${log}.previous`);
      this.update('starting', '正在启动本地服务…');
      const child = this.spawnProcess(this.runtime, ['--no-global-search-paths', join(this.core, 'server', 'index.mjs')], {
        cwd: this.core, env: { ...this.environment, CONTEXTFLOW_DIR: this.paths.data,
          CONTEXTFLOW_DESKTOP_TOKEN: this.token, CONTEXTFLOW_SECRET_KEY: this.secretKey,
          CONTEXTFLOW_NODE: this.runtime, ELECTRON_RUN_AS_NODE: undefined,
          NODE_PATH: undefined, NODE_OPTIONS: undefined },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true, detached: process.platform !== 'win32',
      });
      this.child = child;
      child.on('message', message => {
        if (this.child === child && message?.type === 'contextflow-state-changed' && Number.isSafeInteger(message.revision) && message.revision > 0) this.emit('changed');
      });
      const logChunk = chunk => {
        // Runtime logs remain local. Diagnostic export never includes raw logs.
        try { appendFileSync(log, chunk, { mode: 0o600 }); } catch { /* full disk: report service state instead */ }
      };
      child.stdout?.on('data', logChunk); child.stderr?.on('data', logChunk);
      child.once('error', () => this.update('error', '内置服务无法启动，请查看诊断或重新安装。'));
      child.once('exit', () => {
        clearTimeout(this.stableTimer);
        if (this.child !== child) return;
        this.child = null; this.lastHealth = null;
        if (this.intentionalStop) { this.update('stopped', '本地服务已停止'); return; }
        this.update('error', '本地服务意外退出，正在尝试恢复…');
        if (++this.restarts <= 3) this.restartTimer = setTimeout(() => this.start().catch(() => {}), 2000 * this.restarts);
        else this.update('error', '服务连续退出，已停止自动重试。请打开诊断后重试。');
      });
      for (let n = 0; n < 100 && this.child === child; n++) {
        const h = await this.health();
        if (h?.desktopManaged) {
          this.lastHealth = h; this.update('running', '本地服务已就绪');
          this.stableTimer = setTimeout(() => { this.restarts = 0; }, 60000); this.stableTimer.unref(); return;
        }
        await new Promise(resolve => setTimeout(resolve, 120));
      }
      if (this.child === child) { await this.stop(); this.update('error', '服务启动超时，请查看诊断。'); }
    } catch (error) { this.update('error', error.message); }
    finally { this.starting = false; }
  }
  async request(path, init = {}, { timeoutMs = 120000 } = {}) {
    const valid = validateRequest(path, init);
    if (!this.child || this.state !== 'running') return { status: 503, body: { error: this.message || '本地服务尚未启动' } };
    try {
      const res = await this.fetcher(`http://127.0.0.1:${this.port}${valid.path}`, {
        method: valid.method, body: valid.body, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'Content-Type': 'application/json', 'X-ContextFlow': '1', Authorization: `Bearer ${this.token}` },
      });
      const body = await res.json();
      if (valid.path === '/health' && res.ok) this.lastHealth = body;
      return { status: res.status, body };
    } catch { return { status: 0, body: { error: '本地服务响应中断，请重新检查连接。' } }; }
  }
  async busy() {
    if (!this.child) return false;
    const h = await this.health();
    return !h?.ok || !!(h.jobs?.running || h.jobs?.queued);
  }
  async stop() {
    this.intentionalStop = true; clearTimeout(this.restartTimer); clearTimeout(this.stableTimer);
    const child = this.child;
    if (!child) { this.update('stopped', '本地服务已停止'); return; }
    this.update('stopping', '正在停止任务与服务…');
    const exited = once(child, 'exit').catch(() => {});
    if (child.connected) child.send({ type: 'contextflow-shutdown' }, () => {});
    else this.terminateTree(child);
    let timer;
    await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => { this.terminateTree(child, 'SIGKILL'); resolve(); }, 8000); })]);
    clearTimeout(timer);
    if (this.child === child) { await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2000))]); }
    if (this.child === child) throw new Error('服务尚未完全停止，请稍后重试。');
  }
  async restart() { if (await this.busy()) throw new Error('仍有任务执行或排队，请完成后再重启。'); await this.stop(); this.restarts = 0; await this.start(); }
}
