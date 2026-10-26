const version = value => /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(value || '') ? value : 'unknown';
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
export function diagnosticReport(snapshot = {}) {
  const service = snapshot.service || {}, health = service.health || {};
  return {
    format: 'ContextFlowDesktopDiagnostics', schemaVersion: 1,
    appVersion: version(snapshot.version), serviceVersion: version(health.serviceVersion),
    platform: ['darwin', 'win32'].includes(snapshot.platform) ? snapshot.platform : 'unknown',
    architecture: ['arm64', 'x64'].includes(snapshot.architecture) ? snapshot.architecture : 'unknown',
    service: ['stopped', 'starting', 'running', 'stopping', 'external', 'error', 'unavailable'].includes(service.state) ? service.state : 'error',
    owned: service.owned === true, bridgeReady: snapshot.bridgeReady === true,
    systemIntegration: { trayAvailable: snapshot.systemIntegration?.trayAvailable === true,
      trayPlacement: ['clear', 'obscured', 'offscreen', 'unknown', 'unavailable'].includes(snapshot.systemIntegration?.trayPlacement) ? snapshot.systemIntegration.trayPlacement : 'unknown',
      dockVisible: snapshot.platform === 'darwin' ? snapshot.systemIntegration?.dockVisible === true : null,
      windowVisible: snapshot.systemIntegration?.windowVisible === true },
    pairingStorage: snapshot.pairingError ? 'unreadable' : 'ready',
    browserConnections: snapshot.pairingError ? null : count(snapshot.pairings?.length),
    capabilities: ['llm.models', 'llm.test', 'llm.draft', 'jobs.abort', 'jobs.stream', 'agent.test', 'connection.checks']
      .filter(capability => health.capabilities?.includes(capability)),
    tasks: { running: count(health.jobs?.running), queued: count(health.jobs?.queued) },
    records: { total: count(health.stats?.total), articles: count(health.stats?.articles) },
  };
}
