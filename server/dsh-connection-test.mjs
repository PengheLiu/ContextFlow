// A separate one-shot carrier for a fixed model-only Desktop connection check.
// It never enters the agent/tool runtime or reuses a reading worker.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveDshInstallation } from './dsh-installation.mjs';
import { DSH_CONNECTION_PROMPT } from './dsh-probe-config.mjs';
import { execAgent, spawnAgent, terminateTree } from './platform.mjs';

const execFileAsync = promisify(execAgent);
const error = (message, code) => Object.assign(new Error(message), { code, submitted: false });
const MESSAGES = {
  AGENT_AUTH: 'DSH 登录或认证失败，请在桌面版确认当前账号和模型可用',
  AGENT_TIMEOUT: 'DSH 连接测试超时，已中止',
  ABORTED: '测试已取消',
  AGENT_TEST_TOOLS_FORBIDDEN: 'DSH 模型尝试调用工具，连接测试已拒绝执行',
  DSH_PROBE_UNSUPPORTED: '当前 DSH 模型配置暂不支持受限连接测试，请使用桌面版内置的官方模型和纯数据配置',
  DSH_DESKTOP_UNSUPPORTED: '当前桌面版尚未验证受限连接测试，请重新检测安装或检查版本',
  AGENT_TEST_RESPONSE: 'DSH 模型未完成固定短消息验证，请检查桌面版默认模型',
  AGENT_ERROR: 'DSH 未能完成连接测试，请在桌面版确认当前模型可用',
};

export function createDshConnectionTester({ spawnProcess = spawnAgent, checkVersion, interruptMs = 2000 } = {}) {
  const jobs = new Set();
  let closed = false;
  async function run(options) {
    if (closed) throw error('DSH 服务已关闭', 'DSH_DISCONNECTED');
    if (options.profile !== 'safe' || !options.connectionTest || options.notesDir
      || options.prompt !== DSH_CONNECTION_PROMPT) throw error('DSH 连接测试只接受固定短消息与隔离测试档', 'AGENT_TEST_SCOPE');
    const installation = resolveDshInstallation({ env: options.env || {}, bin: options.bin });
    if (!installation.appPath || !installation.available) throw error(MESSAGES.DSH_DESKTOP_UNSUPPORTED, 'DSH_DESKTOP_UNSUPPORTED');
    const controller = new AbortController();
    const startedAt = Date.now();
    let child, result, failure, finished = false, ready = false, stopTimer, hardTimer;
    let settle;
    const completion = new Promise(resolve => { settle = resolve; });
    const stop = cause => {
      failure ||= cause;
      controller.abort();
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      terminateTree(child);
      stopTimer ||= setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) terminateTree(child, 'SIGKILL');
      }, interruptMs);
    };
    const job = { stop: () => stop(error('DSH 服务已关闭', 'DSH_DISCONNECTED')), completion };
    jobs.add(job);
    const onAbort = () => stop(error(MESSAGES.ABORTED, 'ABORTED'));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => stop(error(MESSAGES.AGENT_TIMEOUT, 'AGENT_TIMEOUT')), Math.min(options.timeoutMs || 45000, 45000));
    const finish = () => {
      if (finished) return;
      finished = true; settle();
    };
    try {
      if (options.signal?.aborted) throw error(MESSAGES.ABORTED, 'ABORTED');
      const id = { ...installation, env: options.env || {} };
      const version = checkVersion
        ? await checkVersion(id, controller.signal)
        : (await execFileAsync(installation.bin, ['--version'], { env: id.env, signal: controller.signal,
          timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 65536 })).stdout.trim();
      if (failure) throw failure;
      if (version !== '0.2.1-rc.2') throw error(MESSAGES.DSH_DESKTOP_UNSUPPORTED, 'DSH_DESKTOP_UNSUPPORTED');
      if (closed || controller.signal.aborted) throw failure || error(MESSAGES.ABORTED, 'ABORTED');
      const resources = join(installation.appPath, 'Contents/Resources');
      const executable = join(installation.appPath, 'Contents/MacOS/DeepSeek Harness');
      const argv = ['--expose-internals', fileURLToPath(new URL('./dsh-connection-child.mjs', import.meta.url)),
        join(resources, 'app.asar/dsh')];
      child = spawnProcess(executable, argv, { cwd: tmpdir(),
        env: { ...id.env, ELECTRON_RUN_AS_NODE: '1', DSH_CLIENT_VERSION: version },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      // Do not forward provider diagnostics, profile values or credential output.
      child.stdout?.resume(); child.stderr?.resume();
      child.on('message', message => {
        if (finished || failure || !message || typeof message !== 'object') return;
        if (message.type === 'ready') {
          if (ready || message.scope !== 'connection-only' || message.toolsDisabled !== true) {
            stop(error(MESSAGES.AGENT_ERROR, 'AGENT_ERROR')); return;
          }
          ready = true;
          try { child.send({ type: 'run' }); } catch { stop(error(MESSAGES.AGENT_ERROR, 'AGENT_ERROR')); }
        } else if (message.type === 'result') {
          if (!ready || result || typeof message.answer !== 'string' || message.answer.length > 1024) {
            stop(error(MESSAGES.AGENT_ERROR, 'AGENT_ERROR')); return;
          }
          result = { answer: message.answer, persistent: false, resumed: false,
            transport: 'dsh-desktop-model-test', ms: Date.now() - startedAt };
          // The child disposes its own services and exits after this message.
          hardTimer = setTimeout(() => stop(error(MESSAGES.AGENT_ERROR, 'AGENT_ERROR')), 1000);
        } else if (message.type === 'error') {
          const code = Object.hasOwn(MESSAGES, message.code) ? message.code : 'AGENT_ERROR';
          stop(error(MESSAGES[code], code));
        }
      });
      child.once('error', () => stop(error('无法启动 DSH 桌面连接测试', 'AGENT_SPAWN')));
      child.once('close', (code, signal) => {
        if (!failure && (!result || code !== 0 || signal)) failure = error(MESSAGES.AGENT_ERROR, 'AGENT_ERROR');
        finish();
      });
      await completion;
      if (failure) throw failure;
      return result;
    } catch (cause) {
      if (!failure) failure = cause?.name === 'AbortError'
        ? error(MESSAGES.ABORTED, 'ABORTED') : cause;
      if (child && !finished) { stop(failure); await completion; }
      throw failure;
    } finally {
      clearTimeout(timer); clearTimeout(stopTimer); clearTimeout(hardTimer);
      options.signal?.removeEventListener('abort', onAbort);
      finish(); jobs.delete(job);
    }
  }
  async function close() {
    closed = true;
    const pending = [...jobs];
    for (const job of pending) job.stop();
    await Promise.all(pending.map(job => job.completion));
  }
  return { run, close };
}
