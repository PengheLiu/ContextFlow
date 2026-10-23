import * as agent from './agent.mjs';
import { normalizeRoot } from './paths.mjs';

const error = (message, code) => Object.assign(new Error(message), { code });
export const CONNECTION_PROMPT = 'Connection check only. Do not use tools, read files, or access the network yourself. Reply with exactly OK, without explanation.';

// This is a connection draft, never a configuration write or tool permission.
// Environment credentials remain server-owned and belong to one saved Agent.
export function agentTestConfig(body, cfg = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['id', 'executable', 'profile'].includes(key))) throw error('Agent 连接测试只接受 Agent、程序路径和待保存权限档，不接受任务、环境变量或笔记授权', 'BAD_INPUT');
  if (typeof body.id !== 'string' || !agent.AGENT_IDS.includes(body.id)) throw error('请先选择要测试的 Agent', 'BAD_AGENT');
  if ('executable' in body && (typeof body.executable !== 'string' || body.executable.length > 4096 || /[\u0000-\u001f\u007f]/.test(body.executable))) throw error('Agent 程序路径无效，请选择程序的完整路径', 'BAD_AGENT_EXECUTABLE');
  if ('profile' in body && !['safe', 'full'].includes(body.profile)) throw error('Agent 权限档无效', 'BAD_AGENT_PROFILE');
  const previous = cfg.agent || {}, same = previous.id === body.id;
  let executable;
  try { executable = normalizeRoot('executable' in body ? body.executable : same ? previous.executable || '' : ''); }
  catch { throw error('Agent 程序路径请填写绝对路径，或使用 ~/ 开头的用户目录', 'BAD_AGENT_EXECUTABLE'); }
  return { ...cfg, agent: { ...previous, id: body.id, executable,
    profile: body.profile || (same ? previous.profile || 'safe' : 'safe'),
    env: same ? { ...previous.env } : {},
  } };
}

export async function prepareAgentTest(id, cfg, detect = agent.detect) {
  if (typeof id !== 'string' || !agent.AGENT_IDS.includes(id)) throw error('请先选择要测试的 Agent', 'BAD_AGENT');
  const testConfig = agentTestConfig({ id }, cfg);
  const installed = (await detect(true, testConfig.agent)).find(row => row.id === id);
  if (!installed?.available) throw error(`${agent.AGENTS[id].label} 未安装或本地服务找不到可执行程序。安装后重新检测；终端别名不等于可执行程序。`, 'NO_AGENT');
  if (!(installed.connectionTestSupported ?? installed.safeSupport !== 'unsupported')) {
    throw error(`${installed.label} 当前版本暂不支持受限的连接测试。${id === 'dsh' ? '请重新检测安装或更新桌面版。' : '请改选支持受限连接测试的 Agent。'}`, 'AGENT_SAFE_UNSUPPORTED');
  }
  return { id, label: installed.label, version: installed.version, path: installed.path,
    executable: testConfig.agent.executable, profile: testConfig.agent.profile,
    safeSupport: installed.safeSupport, connectionTestSupported: installed.connectionTestSupported ?? installed.safeSupport !== 'unsupported',
    // Never send one CLI's explicitly configured credentials to another CLI.
    env: { ...testConfig.agent.env } };
}

export async function testAgentConnection(prepared, { signal, run = agent.run } = {}) {
  const started = Date.now();
  let result;
  try {
    result = await run({ agent: prepared.id, prompt: CONNECTION_PROMPT,
      profile: 'safe', connectionTest: true, notesDir: '', resume: false, bin: prepared.path,
      maxTurns: 1, timeoutMs: 45000, env: prepared.env, signal });
  } catch (cause) {
    const messages={AGENT_AUTH:prepared.id === 'dsh' ? '登录或认证失败。请在 DeepSeek Harness 桌面版完成登录并确认默认模型可用，再回来测试。' : '登录或认证失败。请在终端完成 CLI 登录并确认默认模型可用，再回来测试。',
      AGENT_TIMEOUT:'45 秒内未得到回答。请检查 CLI 默认模型与网络；已中止本次测试，可重试。',
      AGENT_SPAWN:'本地服务无法启动 CLI。请检查可执行程序和服务的 PATH，重新检测安装。',
      AGENT_PARSE:'CLI 输出不兼容。请更新 CLI 或更换 Agent 后重试。',
      DSH_DESKTOP_UNSUPPORTED:'桌面版接口不兼容，请更新配套服务后重新检测。',
      DSH_PROBE_UNSUPPORTED:'当前默认模型使用了受限测试尚不支持的配置。请在桌面版确认 DeepSeek 官方账号或 API 模型的配置后重试。',
      AGENT_TEST_TOOLS_FORBIDDEN:'模型在连接测试中尝试调用工具，测试已停止。',
      DSH_TEST_ISOLATION:'无法建立禁用工具的测试会话，本次测试已停止。',ABORTED:'测试已取消。'};
    throw error(`${prepared.label}：${messages[cause.code] || (prepared.id === 'dsh' ? '未能完成连接验证。请在桌面版确认登录和默认模型可用后重试。' : '未能完成连接验证。请在终端确认 CLI 能正常回答，再回来重试。')}`,cause.code || 'AGENT_ERROR');
  }
  if (String(result.answer || '').trim().replace(/^`+|`+$/g, '').trim().toUpperCase() !== 'OK') {
    throw error('Agent 已启动，但没有完成固定短消息验证。请检查 CLI 的登录、默认模型或服务连接后重试。', 'AGENT_TEST_RESPONSE');
  }
  return { ok: true, agent: prepared.id, label: prepared.label, version: prepared.version,
    path: prepared.path || '', executable: prepared.executable || '', configuredProfile: prepared.profile || 'safe',
    safeSupport: prepared.safeSupport, connectionTestSupported: prepared.connectionTestSupported,
    profile: 'safe', scope: 'connection-only', checkedAt: Date.now(), ms: Date.now() - started };
}
