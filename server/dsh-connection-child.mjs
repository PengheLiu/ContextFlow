// Only the installed Desktop's known model and credential components are loaded.
// This process has no Agent, tools, instructions, skills, MCP, UI or user plugins.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { DSH_CONNECTION_PROMPT, readDshProbeConfig } from './dsh-probe-config.mjs';

const runtimeDir = process.argv[2];
const requireRuntime = createRequire(join(runtimeDir, 'package.json'));
const fromRuntime = name => import(pathToFileURL(requireRuntime.resolve(name)).href);
const controller = new AbortController();
let context;
let started = false;
const send = message => new Promise(resolve => {
  if (!process.connected) return resolve();
  process.send(message, () => resolve());
});
const fail = code => Object.assign(new Error(code), { code });
const readonly = () => { throw fail('AGENT_AUTH'); };
const stop = () => controller.abort();
process.once('disconnect', stop);
process.once('SIGTERM', stop);
process.once('SIGINT', stop);

async function request(selection, createUserMessage) {
  let answer = '', successful = false;
  for await (const chunk of context.llm.stream({ ...selection, maxTokens: 128,
    messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: DSH_CONNECTION_PROMPT }] })],
    tools: [], signal: controller.signal })) {
    if (chunk.type === 'tool-call' || chunk.type.startsWith('tool-call-')
      || chunk.blockType === 'tool-call' || chunk.block?.type === 'tool-call') throw fail('AGENT_TEST_TOOLS_FORBIDDEN');
    if (chunk.type === 'text-delta') {
      answer += chunk.text || '';
      if (answer.length > 1024) throw fail('AGENT_TEST_RESPONSE');
    }
    if (chunk.type === 'finish') {
      if (chunk.reason?.kind === 'aborted') throw fail('ABORTED');
      if (chunk.reason?.kind !== 'stop') {
        const detail = JSON.stringify(chunk.reason?.failure || {});
        if (/401|403|credential|AUTH|API.?KEY|unauthori[sz]ed/i.test(detail)) throw fail('AGENT_AUTH');
        throw fail('AGENT_ERROR');
      }
      successful = true;
    }
  }
  if (!successful || answer.trim().replace(/^`+|`+$/g, '').trim().toUpperCase() !== 'OK') throw fail('AGENT_TEST_RESPONSE');
  return answer;
}

async function main() {
  const [{ Context }, llm, credentials, authorization, yaml] = await Promise.all([
    fromRuntime('@deepseek-ai/cordis'), fromRuntime('@deepseek-ai/dsh-llm'),
    fromRuntime('@deepseek-ai/dsh-credentials-local'), fromRuntime('@deepseek-ai/dsh-authorization'),
    fromRuntime('yaml'),
  ]);
  const dshHome = process.env.DSH_HOME || join(process.env.HOME || homedir(), '.dsh');
  const config = readDshProbeConfig({ dshHome, parseYaml: yaml.parseDocument });
  // Match the desktop credential fallback without reading any project .env.
  const { loadLayeredEnv } = await fromRuntime('@deepseek-ai/dsh-app-boot');
  context = new Context();
  context.provide('launchEnvironment', loadLayeredEnv('dsh', dshHome, () => {}));
  await context.plugin(llm.default);
  await context.plugin(credentials.default, { dshHome, watch: false });
  for (const method of ['set', 'unset', 'modifyRecord', 'deleteRecord']) {
    Object.defineProperty(context.credentials, method, { value: readonly, configurable: false });
  }
  if (config.selection.provider === 'deepseek-account') {
    await context.plugin(authorization.default);
    const [account, adapter] = await Promise.all([
      fromRuntime('@deepseek-ai/dsh-deepseek-account-platform'), fromRuntime('@deepseek-ai/dsh-llm-deepseek-account'),
    ]);
    await context.plugin(account.default, { desktopPlatform: process.platform, ...config.configs['deepseek-account'] });
    await context.plugin(adapter, config.configs['llm-deepseek-account']);
  } else {
    const adapter = await fromRuntime('@deepseek-ai/dsh-llm-deepseek-api-key');
    await context.plugin(adapter, config.configs['llm-deepseek']);
  }
  if (context.get('agent') || context.get('tools') || context.get('skill') || context.get('schedule')) throw fail('DSH_PROBE_UNSUPPORTED');
  controller.signal.throwIfAborted();
  const run = new Promise(resolve => {
    const receive = message => { if (message?.type === 'run' && !started) { started = true; process.off('message', receive); resolve(); } };
    process.on('message', receive);
    controller.signal.addEventListener('abort', resolve, { once: true });
  });
  await send({ type: 'ready', scope: 'connection-only', toolsDisabled: true });
  await run;
  controller.signal.throwIfAborted();
  const answer = await request(config.selection, llm.createUserMessage);
  await send({ type: 'result', answer });
}

main().catch(async cause => {
  const code = controller.signal.aborted ? 'ABORTED'
    : ['AGENT_AUTH', 'DSH_PROBE_UNSUPPORTED', 'AGENT_TEST_TOOLS_FORBIDDEN', 'AGENT_TEST_RESPONSE'].includes(cause?.code) ? cause.code
    : /credential|authorization|auth|account/i.test(`${cause?.name || ''} ${cause?.code || ''}`) ? 'AGENT_AUTH' : 'AGENT_ERROR';
  await send({ type: 'error', code });
  process.exitCode = 1;
}).finally(async () => {
  controller.abort();
  await context?.fiber.dispose().catch(() => {});
  if (process.connected) process.disconnect();
});
