// 只依据实际能力判断兼容性，不要求扩展与服务版本号完全相同。
export const MODEL_DRAFT_CAPABILITY = 'llm.draft';
export function companionInfo(service) {
  return {
    serviceVersion: typeof service?.serviceVersion === 'string' ? service.serviceVersion : null,
    modelDraftSupported: Array.isArray(service?.capabilities) && service.capabilities.includes(MODEL_DRAFT_CAPABILITY),
    agentTestSupported: Array.isArray(service?.capabilities) && service.capabilities.includes('agent.test'),
    connectionChecksSupported: Array.isArray(service?.capabilities) && service.capabilities.includes('connection.checks'),
    llmConfigured: service?.llmConfigured === true,
    explainConfigured: service?.explainConfigured === true,
  };
}
