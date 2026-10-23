export const STEPS = ['connect', 'tools', 'notes', 'finish'];
export function journeyView(preferences = {}, destination = '', syncStatus = {}, binding = '') {
  const value = preferences.onboarding || {};
  return {
    step: STEPS.includes(value.step) ? value.step : 'connect', dismissed: value.dismissed === true,
    destination: binding, notesConfirmed: !!destination && value.notesDestination === destination,
    notesVerified: syncStatus.verified === true,
    lastSyncAt: syncStatus.verified === true && Number.isSafeInteger(syncStatus.lastSyncAt) ? syncStatus.lastSyncAt : null,
  };
}
export function updateJourney(preferences, patch, destination = '', binding = '') {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).length === 0 ||
    Object.keys(patch).some(key => !['step', 'dismissed', 'notesConfirmed', 'expectedDestination'].includes(key)) ||
    ('step' in patch && !STEPS.includes(patch.step)) ||
    ('expectedDestination' in patch && (typeof patch.expectedDestination !== 'string' || patch.expectedDestination.length > 32768)) ||
    ['dismissed', 'notesConfirmed'].some(key => key in patch && typeof patch[key] !== 'boolean')) throw new Error('无效的准备进度');
  const onboarding = { ...preferences.onboarding, version: 1 };
  for (const key of ['step', 'dismissed']) if (key in patch) onboarding[key] = patch[key];
  if ('notesConfirmed' in patch) {
    if (patch.notesConfirmed && !destination) throw new Error('请先选择并保存笔记位置。');
    if (patch.notesConfirmed && (!binding || patch.expectedDestination !== binding)) throw new Error('笔记位置已更改，请重新核对后再确认。');
    onboarding.notesDestination = patch.notesConfirmed ? destination : '';
  }
  return { ...preferences, onboarding };
}
