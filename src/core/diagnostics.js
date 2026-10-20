// A deliberately small, allowlisted report. Never serialize server responses,
// exceptions, config, UA strings, browser tabs or reading data into support text.
const STATES = new Set(['connected','unpaired','unavailable','unauthorized','update-required','incompatible','error']);
const version = value => typeof value === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(value) ? value : 'unknown';
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
export const DIAGNOSTIC_GUIDANCE = {
  connected:'本地连接正常。模型与 Agent 是否能回答，请到「连接与设置」分别主动测试；此检查不会调用 AI。',
  unpaired:'尚未配对。批注、阅读库和导出可离线使用；需要 AI 或笔记同步时，再到「连接与设置」配对。',
  unavailable:'本地服务没有响应。先启动服务再重新检查，不要重新配对。',
  unauthorized:'配对授权失效。到「连接与设置」重新生成本扩展的配对码，现有阅读记录不会删除。',
  'update-required':'本地服务能力不足。请下载匹配版本、保留配置与数据并重启；不需要重新配对。',
  incompatible:'本地端口上的服务不兼容。请确认启动的是 ContextFlow 配套服务。',
  error:'连接状态暂时无法确认。请检查服务运行状态后重试；无需删除配置或阅读记录。',
};
export function diagnosticReport({extensionVersion, connection, storage, browserVersion}) {
  const state=STATES.has(connection?.state) ? connection.state : 'error';
  const service=connection?.service;
  return {
    format:'contextflow-support',version:1,createdAt:new Date().toISOString(),
    extensionVersion:version(extensionVersion),browserVersion:version(browserVersion),
    connection:state,serviceVersion:version(service?.serviceVersion),
    capabilities: service ? {
      modelDraft:service.modelDraftSupported===true,agentTest:service.agentTestSupported===true,
      sharedChecks:service.connectionChecksSupported===true,
    } : null,
    configured:service ? {llm:service.llmConfigured===true,explain:service.explainConfigured===true} : null,
    storage:storage ? {storedRows:count(storage.storedRows),pendingOperations:count(storage.pendingOperations),images:count(storage.images)} : null,
  };
}
