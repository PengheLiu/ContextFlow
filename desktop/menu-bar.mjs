import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const TRAY_GUID = 'aafc29e4-269c-40ed-b346-e9bf8ad45b8b';
const rect = value => value && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(value[key])) && value.width > 0 && value.height > 0;

// These are screen-shape checks, NOT proof of physical visibility: menu-bar
// managers and macOS can also hide a status item. Always retain a Dock fallback.
export function inspectTrayPlacement(bounds, screens) {
  if (!rect(bounds)) return 'unavailable';
  if (!Array.isArray(screens) || !screens.length) return 'unknown';
  const display = screens.find(screen => rect(screen?.frame) && bounds.x >= screen.frame.x && bounds.x + bounds.width <= screen.frame.x + screen.frame.width
    && bounds.y >= screen.frame.y && bounds.y + bounds.height <= screen.frame.y + screen.frame.height);
  if (!display) return 'offscreen';
  const { left, right } = display;
  if (!rect(left) || !rect(right)) return 'clear';
  // AppKit's auxiliary regions can be 32pt high while NSStatusItem reports
  // 33pt. Check the item's horizontal footprint across the camera housing,
  // rather than rejecting that one-point native status-bar difference.
  const top = Math.min(left.y, right.y), bottom = Math.max(left.y + left.height, right.y + right.height);
  if (bounds.y >= bottom || bounds.y + bounds.height <= top) return 'clear';
  return [left, right].some(area => bounds.x >= area.x && bounds.x + bounds.width <= area.x + area.width) ? 'clear' : 'obscured';
}

export async function readMenuBarGeometry(helper, run = execute) {
  try {
    const { stdout } = await run(helper, [], { timeout: 2500, maxBuffer: 32768, encoding: 'utf8', windowsHide: true });
    const value = JSON.parse(stdout);
    if (!Array.isArray(value.screens) || value.screens.length > 32 || !value.screens.every(screen => rect(screen.frame)
      && [screen.left, screen.right].every(area => area == null || rect(area)))) return null;
    return value.screens;
  } catch { return null; }
}

/** Own one native status item. No global preferences, private selectors,
 * accessibility permissions, or other applications' menu items are touched. */
export function createMenuBar({ Tray, icon, guid = TRAY_GUID, platform = process.platform, systemPreferences, readGeometry = async () => null,
  onOpen, onChange = () => {}, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(guid)) throw new TypeError('Invalid tray GUID');
  const positionKey = `NSStatusItem Preferred Position ${guid}`;
  let tray, menu, tooltip = 'ContextFlow', screens, pending, destroyed = false, repairAttempted = false, queuedReload = false, queuedRepair = false;
  function construct() {
    tray = new Tray(icon, guid);
    // On macOS setContextMenu handles left click. Calling onOpen as well would
    // bring the entire window forward merely to inspect the service status.
    if (platform !== 'darwin') tray.on('click', onOpen);
    if (menu) tray.setContextMenu(menu);
    tray.setToolTip(tooltip);
  }
  if (platform === 'darwin') {
    // AppKit's autosave convention: initial placement near the right edge.
    // The registration domain only supplies a default; a user's saved drag
    // position wins. AppKit owns this key, so placement is still verified.
    try { systemPreferences.registerDefaults({ [positionKey]: 0 }); } catch { /* Keep the normal system placement. */ }
  }
  construct();
  function snapshot() {
    let bounds;
    try { if (tray && !tray.isDestroyed()) bounds = tray.getBounds(); } catch { /* Report unavailable, not a false positive. */ }
    return { trayAvailable: rect(bounds) === true, trayBounds: bounds,
      trayPlacement: platform === 'darwin' ? inspectTrayPlacement(bounds, screens) : rect(bounds) ? 'unknown' : 'unavailable' };
  }
  async function refresh({ reloadGeometry = false, repair = false } = {}) {
    if (destroyed) return snapshot();
    queuedReload ||= reloadGeometry || screens === undefined && !pending;
    queuedRepair ||= repair;
    if (pending) return pending;
    pending = (async () => {
      let current;
      do {
        const reload = queuedReload, repairNow = queuedRepair;
        queuedReload = false; queuedRepair = false;
        if (platform === 'darwin' && reload) {
          try { screens = await readGeometry(); } catch { screens = null; }
        }
        if (destroyed) return snapshot();
        current = snapshot();
        if (platform === 'darwin' && repairNow && !repairAttempted && ['obscured', 'offscreen'].includes(current.trayPlacement)) {
          repairAttempted = true;
          // Only repair a confirmed inaccessible placement, once per launch.
          // Destroy first: AppKit may save its old position during removal.
          tray.closeContextMenu?.(); tray.destroy();
          try { systemPreferences.setUserDefault(positionKey, 'double', 0); } catch { /* Recreate even if preferences cannot be written. */ }
          construct();
          await wait(300);
          if (destroyed) return snapshot();
          current = snapshot();
        }
      } while (queuedReload || queuedRepair);
      onChange(current);
      return current;
    })();
    try { return await pending; } finally { pending = null; }
  }
  return {
    getTray: () => tray,
    snapshot, refresh,
    setMenu(value, text) {
      const menuChanged = menu !== value, tooltipChanged = tooltip !== text;
      menu = value; tooltip = text;
      if (!destroyed && !tray.isDestroyed()) {
        if (menuChanged) tray.setContextMenu(menu);
        if (tooltipChanged) tray.setToolTip(tooltip);
      }
    },
    // Test the actual menu action, not an invented Tray click on macOS.
    openFromMenu() { const item = menu?.getMenuItemById('open'); if (item?.enabled) item.click(); },
    destroy() { destroyed = true; tray?.destroy(); },
  };
}
