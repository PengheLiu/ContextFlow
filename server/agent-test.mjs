import * as agent from './agent.mjs';

const error = (message, code) => Object.assign(new Error(message), { code });
export const CONNECTION_PROMPT = 'Connection check only. Do not use tools, read files, or access the network yourself. Reply with exactly OK, without explanation.';

export async function prepareAgentTest(id, cfg, detect = agent.detect) {
  if (typeof id !== 'string' || !agent.AGENT_IDS.includes(id)) throw error('请先选择要测试的 Agent', 'BAD_AGENT');
  const installed = (await detect()).find(row => row.id === id);
  if (!installed?.available) throw error(`${agent.AGENTS[id].label} 未安装或本地服务找不到可执行程序。安装后重新检测；终端别名不等于可执行程序。`, 'NO_AGENT');
  if (installed.safeSupport === 'unsupported') throw error(`${installed.label} 暂不支持受限的连接测试。为避免测试获得完整权限，请改选支持安全档的 Agent；不会自动切换权限。`, 'AGENT_SAFE_UNSUPPORTED');
  return { id, label: installed.label, version: installed.version, path: installed.path,
    // Never send one CLI's explicitly configured credentials to another CLI.
    env: cfg?.agent?.id === id ? { ...cfg.agent.env } : {} };
}

export async function testAgentConnection(prepared, { signal, run = agent.run } = {}) {
  const started = Date.now();
  let result;
  try {
    result = await run({ agent: prepared.id, prompt: CONNECTION_PROMPT,
      profile: 'safe', connectionTest: true, notesDir: '', resume: false,
      maxTurns: 1, timeoutMs: 45000, env: prepared.env, signal });
  } catch (cause) {
    const messages={AGENT_AUTH:'登录或认证失败。请在终端完成 CLI 登录并确认默认模型可用，再回来测试。',
      AGENT_TIMEOUT:'45 秒内未得到回答。请检查 CLI 默认模型与网络；已中止本次测试，可重试。',
      AGENT_SPAWN:'本地服务无法启动 CLI。请检查可执行程序和服务的 PATH，重新检测安装。',
      AGENT_PARSE:'CLI 输出不兼容。请更新 CLI 或更换 Agent 后重试。',ABORTED:'测试已取消。'};
    throw error(`${prepared.label}：${messages[cause.code] || '未能完成连接验证。请在终端确认 CLI 能正常回答，再回来重试。'}`,cause.code || 'AGENT_ERROR');
  }
  if (String(result.answer || '').trim().replace(/^`+|`+$/g, '').trim().toUpperCase() !== 'OK') {
    throw error('Agent 已启动，但没有完成固定短消息验证。请检查 CLI 的登录、默认模型或服务连接后重试。', 'AGENT_TEST_RESPONSE');
  }
  return { ok: true, agent: prepared.id, label: prepared.label, version: prepared.version,
    profile: 'safe', scope: 'connection-only', checkedAt: Date.now(), ms: Date.now() - started };
}
