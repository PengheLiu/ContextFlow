// Keep an independent launcher on macOS. A native status item and valid bounds
// do not prove that the user can see it (menu-bar overflow, a notch or a manager).
// Native messaging helpers never instantiate this controller.
export function createVisibility({ app, platform = process.platform, getTray = () => null }) {
  let revision = 0, pendingDockShow;
  const trayAvailable = () => {
    try {
      const tray = getTray();
      if (!tray || tray.isDestroyed()) return false;
      const bounds = tray.getBounds();
      return ['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds?.[key])) && bounds.width > 0 && bounds.height > 0;
    } catch { return false; }
  };
  const dockVisible = () => {
    try { return app.dock.isVisible() === true; } catch { return false; }
  };
  function showDock() {
    if (platform !== 'darwin') return Promise.resolve();
    if (dockVisible()) return Promise.resolve();
    if (pendingDockShow) return pendingDockShow;
    const pending = Promise.resolve().then(() => app.dock.show());
    pendingDockShow = pending;
    const clear = () => { if (pendingDockShow === pending) pendingDockShow = undefined; };
    pending.then(clear, clear);
    return pending;
  }
  async function present(window, { focus = true } = {}) {
    ++revision;
    if (!window || window.isDestroyed()) return;
    // A packaged LSUIElement app may not finish dock.show() until a window is
    // visible. Showing the window must never wait on that native transition.
    showDock().catch(() => {});
    if (window.isMinimized()) window.restore();
    if (focus) { window.show(); window.focus(); }
    else window.showInactive();
  }
  function closeToBackground(window) {
    const ticket = ++revision;
    if (!window || window.isDestroyed()) return false;
    if (platform === 'darwin') {
      if (dockVisible()) { window.hide(); return true; }
      // Until the independent launcher is confirmed, keep the existing window.
      // A reopen or a different window invalidates this pending close request.
      showDock().then(() => {
        if (ticket === revision && !window.isDestroyed() && dockVisible()) window.hide();
      }).catch(() => { /* A failed Dock restore must never strand the window. */ });
      return false;
    }
    if (trayAvailable()) { window.hide(); return true; }
    window.minimize(); return false;
  }
  return { present, closeToBackground, trayAvailable, ensureLauncher: showDock };
}
