// Global listeners belong to one UI lifetime, not to the lifetime of a tab.
export class EventScope {
  constructor() { this.cleanups = new Set(); this.disposed = false; }
  listen(target, type, listener, options) {
    if (this.disposed || !target?.addEventListener) return () => {};
    const capture = typeof options === 'boolean' ? options : !!options?.capture;
    target.addEventListener(type, listener, options);
    let active = true;
    const off = () => {
      if (!active) return;
      active = false;
      target.removeEventListener(type, listener, capture);
      this.cleanups.delete(off);
    };
    this.cleanups.add(off);
    return off;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of [...this.cleanups]) off();
  }
}
