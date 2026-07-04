/**
 * dispatch.js — CSP-safe replacement for inline event-handler attributes.
 *
 * WHY THIS EXISTS
 * The UI used to be wired with inline attributes (onclick="sendMessage()"),
 * which forces the Content-Security-Policy to allow 'unsafe-inline' script —
 * neutering XSS protection. This module replaces every inline handler with
 * declarative data-* attributes handled by delegated listeners, so the CSP
 * can drop 'unsafe-inline' entirely.
 *
 * SUPPORTED ATTRIBUTES
 *   data-action="fn"                  → click calls window.fn(element, event)
 *   data-action="fn('a', 2)"          → click calls window.fn('a', 2)
 *   data-action="fnA;fnB"             → click calls both, in order
 *   data-action="AtomAPI.logout"      → dotted paths resolve from window
 *   data-action="stop"                → click swallowed (replaces
 *                                       onclick="event.stopPropagation()")
 *   data-action-self="fn"             → click calls fn ONLY if the click landed
 *                                       on the element itself, not a child
 *                                       (overlay-dismiss pattern)
 *   data-enter="fn"                   → keydown calls fn() when key === Enter
 *   data-keydown="fn"                 → keydown calls fn(event)
 *
 * ARGUMENT SYNTAX (deliberately minimal — this is NOT eval)
 *   'single-quoted strings', numbers, true, false, null.
 * Anything else is rejected with a console error. No expressions, no
 * property access, no template strings — so injected markup can at worst call
 * an existing global with literal args, never run arbitrary code.
 */
(function () {
  'use strict';

  // fn('a', 1, true) — capture name and raw arg list
  var CALL_RE = /^\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*(?:\(\s*(.*?)\s*\))?\s*$/;

  function resolveFn(path) {
    var parts = path.split('.');
    var ctx = window;
    for (var i = 0; i < parts.length - 1; i++) {
      ctx = ctx ? ctx[parts[i]] : undefined;
    }
    var fn = ctx ? ctx[parts[parts.length - 1]] : undefined;
    return typeof fn === 'function' ? { fn: fn, ctx: ctx } : null;
  }

  /** Parse a comma-separated list of literals. Returns null on anything unsafe. */
  function parseArgs(raw) {
    if (!raw) return [];
    var args = [];
    var re = /\s*(?:'((?:[^'\\]|\\.)*)'|(-?\d+(?:\.\d+)?)|(true|false|null))\s*(?:,|$)/g;
    var idx = 0, m;
    while (idx < raw.length && (m = re.exec(raw)) !== null) {
      if (m.index !== idx) return null; // junk between tokens
      if (m[1] !== undefined)      args.push(m[1].replace(/\\'/g, "'"));
      else if (m[2] !== undefined) args.push(Number(m[2]));
      else                         args.push(m[3] === 'true' ? true : m[3] === 'false' ? false : null);
      idx = re.lastIndex;
    }
    return idx === raw.length ? args : null;
  }

  function runSpec(spec, el, event) {
    spec.split(';').forEach(function (one) {
      one = one.trim();
      if (!one || one === 'stop') return; // 'stop' = swallow the event
      var m = CALL_RE.exec(one);
      if (!m) { console.error('[dispatch] unparseable action:', one); return; }
      var resolved = resolveFn(m[1]);
      if (!resolved) { console.error('[dispatch] unknown function:', m[1]); return; }
      var args = parseArgs(m[2]);
      if (args === null) { console.error('[dispatch] unsafe args rejected:', one); return; }
      try {
        resolved.fn.apply(resolved.ctx, args);
      } catch (err) {
        console.error('[dispatch] action failed:', one, err);
      }
    });
  }

  document.addEventListener('click', function (e) {
    // Nearest actionable ancestor wins; 'stop' swallows without bubbling
    // further up the data-action chain (mirrors old stopPropagation()).
    var el = e.target.closest('[data-action], [data-action-self]');
    if (!el) return;

    var selfSpec = el.getAttribute('data-action-self');
    if (selfSpec !== null) {
      if (e.target === el) runSpec(selfSpec, el, e);
      return;
    }
    runSpec(el.getAttribute('data-action'), el, e);
  });

  document.addEventListener('keydown', function (e) {
    var el = e.target.closest ? e.target.closest('[data-enter], [data-keydown]') : null;
    if (!el) return;

    var keySpec = el.getAttribute('data-keydown');
    if (keySpec !== null) {
      var m = CALL_RE.exec(keySpec);
      var resolved = m && resolveFn(m[1]);
      if (resolved) resolved.fn.call(resolved.ctx, e);
      else console.error('[dispatch] unknown keydown handler:', keySpec);
      return;
    }

    if (e.key === 'Enter') {
      var enterSpec = el.getAttribute('data-enter');
      if (enterSpec !== null) runSpec(enterSpec, el, e);
    }
  });
})();
