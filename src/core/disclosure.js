// A native details remains the semantic source of truth. Only its body animates;
// headings keep their position, focus returns before hiding, and rapid clicks
// reverse from the current height instead of jumping to an old animation end.
export function wireDisclosure(details, { bodyClass = 'disclosure-content', duration = 180 } = {}) {
  const summary = [...details.children].find(child => child.tagName === 'SUMMARY');
  if (!summary || details.disclosure) return details.disclosure;
  const body = details.ownerDocument.createElement('div'); body.className = bodyClass;
  for (const child of [...details.childNodes]) if (child !== summary) body.append(child);
  // Animate an unpadded clip. Animating the padded content cannot reach 0px
  // (CSS clamps to its padding), causing a visible jump at the end of closing.
  const motion=details.ownerDocument.createElement('div');motion.className='disclosure-motion';
  motion.style.display='flow-root';motion.append(body);details.append(motion);
  let animation, target = details.open, generation = 0;
  const update = open => {
    details.dataset.expanded = String(open); summary.setAttribute('aria-expanded', String(open));
    motion.inert = !open;
    const label = summary.querySelector('[data-disclosure-label]');
    if (label) label.textContent = open ? '收起' : '展开';
  };
  const settle = open => {
    target = open; animation?.cancel(); animation = null;
    details.open = open; update(open); motion.style.overflow = '';
  };
  update(target);
  summary.addEventListener('click', event => {
    event.preventDefault();
    const open = animation ? !target : !details.open;
    const start = details.open ? motion.getBoundingClientRect().height : 0;
    const current = ++generation;
    animation?.cancel(); animation = null; target = open;
    if (!open && body.contains(details.getRootNode().activeElement)) summary.focus({ preventScroll: true });
    update(open);
    const reduced = details.ownerDocument.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced || !motion.animate) { settle(open); return; }
    details.open = true;
    motion.style.overflow = 'hidden';
    animation = motion.animate([{height:`${start}px`},{height:`${open ? motion.scrollHeight : 0}px`}],
      { duration, easing:'cubic-bezier(.2,0,0,1)', fill:'both' });
    animation.finished.then(() => { if (current === generation) settle(open); }, () => {});
  });
  details.addEventListener('toggle', () => { if (!animation) { target = details.open; update(target); } });
  details.disclosure = { body:motion, content:body, sync: () => { ++generation; settle(animation ? target : details.open); } };
  return details.disclosure;
}
