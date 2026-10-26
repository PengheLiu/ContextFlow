// One immutable App per article. The stable facade keeps extension messages
// pointed at the visible article while late requests keep their original owner.
export function articleSession({ create, keyOf, href, host = globalThis.window, onError = () => {}, onTransition = () => {}, limit = 8 }) {
  let current = create(), started = false, switching, disposed = false, retryAt = 0;
  const sessions = new Map([[current.key, current]]), hooks = new Map(), startFailures = new Map();
  const attach = app => { for (const [name, value] of hooks) app[name] = value; app.onRouteChange = () => check(); return app; };
  attach(current);
  function start(app) {
    // Keep route/event callbacks handled even when private storage is unavailable.
    // A failed initialization has no interactive editors and can be retried in
    // place; it must not strand the controller behind a rejected ready promise.
    app.ready = Promise.resolve().then(() => disposed ? false : app.start()).then(() => {
      startFailures.delete(app); return !disposed;
    }, error => {
      if (disposed) return false;
      startFailures.set(app, error); app.deactivate?.();
      onError(error, () => check(true), app, 'startup'); return false;
    });
    return app.ready;
  }
  async function check(force = false) {
    if (disposed || !started) return;
    if (switching) return switching;
    if (keyOf(href()) === current.key && !(force && startFailures.has(current))) return;
    if (!force && Date.now() < retryAt) return;
    switching = (async () => {
      if (keyOf(href()) === current.key && startFailures.has(current)) {
        onTransition();
        if (!await start(current)) return;
      }
      while (!disposed && keyOf(href()) !== current.key) {
        const previous = current;
        previous.suspend?.();
        try {
          await previous.ready;
          if (disposed) return;
          await previous.flushForNavigation();
          if (disposed) return;
        } catch (error) {
          if (disposed) return;
          retryAt = /图片.*(?:尚未|保存|完成)/.test(error.message) ? Date.now() + 1500 : Infinity;
          previous.navigationFailed?.(error);
          onError(error, () => check(true), previous);
          return;
        }
        const open = previous.panel?.open ?? previous.initialPanelOpen;
        onTransition(); retryAt = 0;
        previous.deactivate();
        const key = keyOf(href());
        let next = sessions.get(key);
        if (!next || next.stopped) { next = create({ initialPanelOpen: open }); sessions.set(next.key, next); }
        current = attach(next);
        current.initialPanelOpen = open;
        if (!await start(current)) return;
        // Retain active jobs, but do not retain an unbounded tour of old pages.
        for (const [savedKey, app] of sessions) {
          if (sessions.size <= limit) break;
          if (app !== current && !app.hasBackgroundWork?.()) { sessions.delete(savedKey); startFailures.delete(app); }
        }
      }
    })().finally(() => { switching = null; });
    return switching;
  }
  const listeners = [];
  const listen = name => { if (host?.addEventListener) { const fn = () => check(); host.addEventListener(name, fn); listeners.push([name, fn]); } };
  let timer;
  const facade = new Proxy(current, {
    get(_target, name) {
      if (name === 'currentArticle') return current;
      if (name === 'checkArticle') return check;
      if (name === 'togglePanel') return (...args) => {
        if (startFailures.has(current)) return check(true);
        if (switching || keyOf(href()) !== current.key) return check().then(() => {
          if (keyOf(href()) === current.key && !startFailures.has(current)) current.togglePanel?.(...args);
        });
        return current.togglePanel?.(...args);
      };
      if (name === 'disposeSession') return () => {
        disposed = true; host?.clearInterval?.(timer);
        for (const [type, fn] of listeners) host.removeEventListener(type, fn);
        onTransition();
        for (const app of sessions.values()) app.stop();
      };
      if (name === 'start') return () => {
        if (started) return current.ready;
        started = true;
        for (const name of ['popstate', 'hashchange', 'pageshow']) listen(name);
        // History API calls in a site's MAIN world cannot reliably be wrapped
        // by an isolated content script. Polling is a bounded fallback; DOM and
        // write-entry checks react sooner without injecting code into the site.
        timer = host?.setInterval?.(() => check(), 350);
        timer?.unref?.();
        start(current).then(ok => { if (ok) return check(); });
        return current.ready;
      };
      const value = current[name];
      return typeof value === 'function' ? value.bind(current) : value;
    },
    set(_target, name, value) {
      if (['openConnectionSettings', 'openReadingLibrary'].includes(name)) {
        hooks.set(name, value); for (const app of sessions.values()) app[name] = value;
      }
      current[name] = value; return true;
    },
  });
  return facade;
}
