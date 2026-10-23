// Chromium may mark its automatic first focus as :focus-visible. Explicit
// input modality prevents a programmatic focus from exposing the skip link.
export function installInputModality({ root = document, win = root.defaultView } = {}) {
  const html = root.documentElement;
  const reset = () => html.removeAttribute('data-input-modality');
  const keyboard = event => { if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) html.dataset.inputModality = 'keyboard'; };
  const pointer = () => { html.dataset.inputModality = 'pointer'; };
  const visibility = () => { if (root.hidden) reset(); };
  reset();
  root.addEventListener('keydown', keyboard, true);
  root.addEventListener('pointerdown', pointer, true);
  root.addEventListener('visibilitychange', visibility);
  win?.addEventListener('blur', reset);
  return () => {
    root.removeEventListener('keydown', keyboard, true);
    root.removeEventListener('pointerdown', pointer, true);
    root.removeEventListener('visibilitychange', visibility);
    win?.removeEventListener('blur', reset);
    reset();
  };
}
