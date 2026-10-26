import * as agent from './agent.mjs';
import { normalizeRoot } from './paths.mjs';

const error = (message, code) => Object.assign(new Error(message), { code });
export const CONNECTION_PROMPT = 'Connection check only. Do not use tools, read files, or access the network yourself. Reply with exactly OK, without explanation.';

// This is a connection draft, never a configuration write or tool permission.
// Environment credentials remain server-owned and belong to one saved Agent.
export function agentTestConfig(body, cfg = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['id', 'executable', 'profile', 'codexHome'].includes(key))) throw error('Agent 连接测试只接受 Agent、程序路径、Codex 配置目录和待保存权限档，不接受任务、环境变量或笔记授权', 'BAD_INPUT');
  if (typeof body.id !== 'string' || !agent.AGENT_IDS.includes(body.id)) throw error('请先选择要测试的 Agent', 'BAD_AGENT');
  if ('executable' in body && (typeof body.executable !== 'string' || body.executable.length > 4096 || /[\u0000-\u001f\u007f]/.test(body.executable))) throw error('Agent 程序路径无效，请选择程序的完整路径', 'BAD_AGENT_EXECUTABLE');
  if ('profile' in body && !['safe', 'full'].includes(body.profile)) throw error('Agent 权限档无效', 'BAD_AGENT_PROFILE');
  if ('codexHome' in body && (body.id !== 'codex' || typeof body.codexHome !== 'string' || body.codexHome.length > 4096 || /[\u0000-\u001f\u007f]/.test(body.codexHome))) throw error('Codex 配置目录无效，请选择目录的完整路径', 'BAD_AGENT_HOME');
  const previous = cfg.agent || {}, same = previous.id === body.id;
  let executable;
  try { executable = normalizeRoot('executable' in body ? body.executable : same ? previous.executable || '' : ''); }
  catch { throw error('Agent 程序路径请填写绝对路径，或使用 ~/ 开头的用户目录', 'BAD_AGENT_EXECUTABLE'); }
  const env = same ? { ...previous.env } : {};
  if (Object.hasOwn(body, 'codexHome')) {
    let home;
    try { home = normalizeRoot(body.codexHome); }
    catch { throw error('Codex 配置目录请填写绝对路径，或使用 ~/ 开头的用户目录', 'BAD_AGENT_HOME'); }
    if (home) env.CODEX_HOME = home;
    else delete env.CODEX_HOME;
  }
  return { ...cfg, agent: { ...previous, id: body.id, executable,
    profile: body.profile || (same ? previous.profile || 'safe' : 'safe'),
    env,
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
  return { id, label: installed.label, version: installed.version, path: installed.path, identity: installed.identity || '',
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
    const messages={AGENT_AUTH:prepared.id === 'dsh' ? '登录或认证失败。请在 DeepSeek Harness 桌面版完成登录并确认默认模型可用，再回来测试。' : prepared.id === 'codex' ? '当前 Codex 配置的登录或模型服务认证失败。请在当前配置目录完成登录，或检查模型服务的凭据后重试。' : '登录或认证失败。请在终端完成 CLI 登录并确认默认模型可用，再回来测试。',
      AGENT_TIMEOUT:'模型连接测试超时。请检查默认模型、网络与代理；已中止本次测试，可重试。',
      AGENT_SPAWN:'本地服务无法启动 CLI。请检查可执行程序和服务的 PATH，重新检测安装。',
      AGENT_PARSE:'CLI 输出不兼容。请更新 CLI 或更换 Agent 后重试。',
      AGENT_EMPTY:'CLI 已结束本次请求，但没有返回可展示的回答。请检查默认模型与响应接口的兼容性后重试。',
      AGENT_CONFIGURATION_CHANGED:'测试期间程序、Codex 配置或登录状态发生变化。尚未验证变化后的配置，请重新测试后保存。',
      AGENT_QUOTA:'当前模型服务额度或使用预算不足。请检查账号额度与使用限制后重试。',
      AGENT_RATE_LIMIT:'当前模型服务正在限流，请稍后重试并检查请求频率限制。',
      AGENT_MODEL_UNAVAILABLE:'当前默认模型不存在、不可用或无访问权限。请检查当前 Codex 配置目录中的模型名称与可用模型。',
      AGENT_REASONING_UNSUPPORTED:'当前模型或网关不支持所配置的推理强度。请在当前 Codex 配置目录选择模型支持的推理档后重试。',
      AGENT_NETWORK:'无法连接当前模型服务，或连接已断开。请检查网络、代理、证书及服务地址后重试。',
      AGENT_PROVIDER_UNAVAILABLE:'当前模型服务或网关暂时不可用，请检查服务状态，稍后重试。',
      AGENT_ACCESS_DENIED:'模型服务拒绝访问。请检查账号权限、网关访问策略与服务地址。',
      AGENT_PROVIDER_REQUEST:'当前模型服务拒绝了请求。请检查服务地址、Responses 接口与模型配置的兼容性。（支持代码：AGENT_PROVIDER_REQUEST）',
      CODEX_UNSUPPORTED:'当前 Codex 不支持所需协议，请更新 CLI 与 ContextFlow 后重新检测。',
      CODEX_PROTOCOL:'Codex 协议消息不兼容，请更新 CLI 与 ContextFlow 后重试。（支持代码：CODEX_PROTOCOL）',
      CODEX_RPC_TIMEOUT:'连接 Codex 的本地协议超时。请检查 CLI 是否能正常启动，重新检测后重试。',
      CODEX_DISCONNECTED:'Codex 进程已断开。请检查 CLI 与当前配置，重新检测后重试；本次不会自动重放。',
      CODEX_RPC:'Codex 未能完成请求。请查看诊断信息并联系支持。（支持代码：CODEX_RPC）',
      DSH_DESKTOP_UNSUPPORTED:'桌面版接口不兼容，请更新配套服务后重新检测。',
      DSH_PROBE_UNSUPPORTED:'当前默认模型使用了受限测试尚不支持的配置。请在桌面版确认 DeepSeek 官方账号或 API 模型的配置后重试。',
      AGENT_TEST_TOOLS_FORBIDDEN:'模型在连接测试中尝试调用工具，测试已停止。',
      DSH_TEST_ISOLATION:'无法建立禁用工具的测试会话，本次测试已停止。',ABORTED:'测试已取消。'};
    throw error(`${prepared.label}：${messages[cause.code] || (prepared.id === 'dsh' ? '未能完成连接验证。请在桌面版确认登录和默认模型可用后重试。' : '未能完成连接验证。请在终端确认 CLI 能正常回答，再回来重试。')}`,cause.code || 'AGENT_ERROR');
  }
  if (prepared.identity && agent.currentExecutionIdentity(prepared) !== prepared.identity) {
    throw error('测试期间程序、Codex 配置或登录状态发生变化。尚未验证变化后的配置，请重新测试后保存。', 'AGENT_CONFIGURATION_CHANGED');
  }
  if (String(result.answer || '').trim().replace(/^`+|`+$/g, '').trim().toUpperCase() !== 'OK') {
    throw error('Agent 已启动，但没有完成固定短消息验证。请检查 CLI 的登录、默认模型或服务连接后重试。', 'AGENT_TEST_RESPONSE');
  }
  return { ok: true, agent: prepared.id, label: prepared.label, version: prepared.version,
    path: prepared.path || '', identity: prepared.identity || '', executable: prepared.executable || '', configuredProfile: prepared.profile || 'safe',
    safeSupport: prepared.safeSupport, connectionTestSupported: prepared.connectionTestSupported,
    profile: 'safe', scope: 'connection-only', checkedAt: Date.now(), ms: Date.now() - started };
}
