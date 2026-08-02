/**
 * api.js — Centralized API client for Atom frontend.
 *
 * All fetch() calls go through window.AtomAPI so:
 *   - base URL is managed in one place
 *   - timeouts are enforced consistently
 *   - JSON parsing / error extraction is uniform
 *   - safe-read retry (idempotent GETs retry once on network failure)
 *   - auth headers are injected centrally (currently empty — proxy adds key)
 */

(function (global) {
  'use strict';

  // Resolved from /api/config on boot; updated by loadConfig()
  let _base = '/proxy/api/v1';
  const DEFAULT_TIMEOUT_MS = 20_000;
  const RETRY_TIMEOUT_MS   = 30_000;

  /** Returns base URL string (no trailing slash). */
  function base() { return _base; }

  /** Update the base URL (called by loadConfig). */
  function setBase(url) { _base = url.replace(/\/+$/, ''); }

  // -- Session ---------------------------------------------------------------
  //
  // The JWT used to live in localStorage, which meant any successful XSS could
  // read a 24-hour credential straight out of the page and walk off with the
  // account. It now lives in an httpOnly cookie set by the proxy (server.js):
  // the browser attaches it to same-origin requests automatically and page
  // JavaScript cannot read it at all.
  //
  // What we keep here is the non-secret half — the display claims, fetched from
  // /api/session at boot. Nothing here is a security boundary; the backend
  // re-checks identity and role on every request. Lying to this object gets you
  // a UI tab full of 403s, not access.
  var _session = null;   // { authenticated, userId, email, role, orgId }

  /**
   * Load the session from the proxy. Must be awaited before the first
   * isLoggedIn()/getUserId() call — boot.js does this.
   */
  async function loadSession() {
    try {
      var res = await fetch('/api/session', {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      _session = res.ok ? await res.json() : { authenticated: false };
    } catch (_) {
      _session = { authenticated: false };
    }
    return _session;
  }

  function isLoggedIn() { return !!(_session && _session.authenticated); }
  function getUserId()  { return (_session && _session.userId) || null; }
  function getUserEmail() { return (_session && _session.email) || null; }

  /** Org role: 'owner' | 'admin' | 'member' (null if not logged in) */
  function getUserRole() { return (_session && _session.role) || null; }

  /** True when the current user may see org-admin UI (backend re-enforces) */
  function isOrgAdmin() {
    var r = getUserRole();
    return r === 'owner' || r === 'admin';
  }

  /**
   * Headers added to every request.
   *
   * No token header any more — the session cookie rides along automatically on
   * same-origin requests. `credentials: 'same-origin'` in request() is what
   * actually carries it.
   */
  function commonHeaders(extra) {
    return Object.assign({ Accept: 'application/json' }, extra || {});
  }

  function authHeaders(extra) {
    return commonHeaders(extra);
  }

  /**
   * Core request helper.
   *
   * @param {string}  path     - relative path, e.g. '/ai/text' or full URL
   * @param {object}  opts     - fetch options (method, body, headers, …)
   * @param {object}  [cfg]
   * @param {number}  [cfg.timeoutMs]  - abort after N ms (default 20 000)
   * @param {boolean} [cfg.raw]        - resolve with Response instead of parsed body
   * @param {boolean} [cfg.noRetry]    - disable automatic safe-read retry
   * @returns {Promise<any>}
   */
  async function request(path, opts, cfg) {
    cfg = cfg || {};
    const timeoutMs = cfg.timeoutMs || DEFAULT_TIMEOUT_MS;
    const url = (path.startsWith('http') || path.startsWith('/proxy/')) ? path : _base + path;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const fetchOpts = Object.assign({}, opts, {
      signal  : controller.signal,
      headers : commonHeaders(opts && opts.headers),
      // Carries the httpOnly session cookie. Explicit rather than relying on
      // the default — this is the only thing authenticating the request now.
      credentials: 'same-origin',
    });

    try {
      const res = await fetch(url, fetchOpts);
      clearTimeout(timer);

      if (cfg.raw) return res;

      // Try JSON first, fall back to text
      const contentType = res.headers.get('content-type') || '';
      let body;
      if (contentType.includes('application/json')) {
        body = await res.json();
      } else {
        body = await res.text();
      }

      if (!res.ok) {
        const message =
          (body && typeof body === 'object' && (body.message || body.error)) ||
          (typeof body === 'string' && body) ||
          `HTTP ${res.status}`;

        // Expired/invalid session: the backend returns 401 for a stale JWT.
        // Clear the dead token and return to the login screen instead of
        // surfacing a confusing "invalid API key" error in every panel.
        // (Skip /auth/ requests — a failed login attempt is a normal 401.)
        if (res.status === 401 && isLoggedIn() && !url.includes('/auth/')) {
          // The cookie is httpOnly, so the page can't clear it itself — ask the
          // proxy to, then reload into the login screen.
          _session = null;
          try {
            await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
          } catch (_) { /* reloading anyway */ }
          location.reload();
          return new Promise(() => {}); // halt callers — page is reloading
        }

        const err = new Error(message);
        err.status = res.status;
        err.body   = body;
        throw err;
      }

      return body;
    } catch (err) {
      clearTimeout(timer);

      // Retry safe reads once on network / abort errors
      const isRetriable =
        !cfg.noRetry &&
        (!opts || !opts.method || opts.method.toUpperCase() === 'GET') &&
        (err.name === 'AbortError' || err.name === 'TypeError' || err.name === 'NetworkError');

      if (isRetriable) {
        console.warn('[AtomAPI] retrying after error:', err.message, url);
        return request(path, opts, Object.assign({}, cfg, { timeoutMs: RETRY_TIMEOUT_MS, noRetry: true }));
      }

      throw err;
    }
  }

  // ── Convenience methods ────────────────────────────────────────────────

  function get(path, cfg) {
    return request(path, { method: 'GET' }, cfg);
  }

  function post(path, data, cfg) {
    return request(path, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify(data),
    }, cfg);
  }

  function del(path, cfg) {
    return request(path, { method: 'DELETE' }, cfg);
  }

  function patch(path, data, cfg) {
    return request(path, {
      method  : 'PATCH',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify(data),
    }, cfg);
  }

  function postForm(path, formData, cfg) {
    // Don't set Content-Type — browser sets it with boundary for multipart
    return request(path, { method: 'POST', body: formData }, cfg);
  }

  /** GET that returns the raw Response (for streaming audio etc.) */
  function getRaw(path, cfg) {
    return request(path, { method: 'GET' }, Object.assign({}, cfg, { raw: true }));
  }

  /** POST that returns the raw Response (for streaming audio etc.) */
  function postRaw(path, data, cfg) {
    return request(path, {
      method  : 'POST',
      headers : { 'Content-Type': 'application/json' },
      body    : JSON.stringify(data),
    }, Object.assign({}, cfg, { raw: true }));
  }

  // ── UI state helpers ───────────────────────────────────────────────────

  /**
   * Standardised async-state handler for a container element.
   *
   * Usage:
   *   const s = AtomAPI.state(el);
   *   s.loading();
   *   try { const data = await AtomAPI.get(…); s.success(); render(data); }
   *   catch(e) { s.error(e.message); }
   */
  function state(el) {
    return {
      loading(msg) {
        if (!el) return;
        el.innerHTML =
          `<div class="async-loading"><span class="spinner"></span>${msg || 'Loading…'}</div>`;
      },
      empty(msg) {
        if (!el) return;
        el.innerHTML = `<div class="async-empty">${msg || 'Nothing here yet.'}</div>`;
      },
      error(msg) {
        if (!el) return;
        el.innerHTML =
          `<div class="async-error">⚠️ ${msg || 'Something went wrong.'}</div>`;
      },
      success() { /* caller populates el */ },
    };
  }

  /**
   * Disable a button while an async operation is in flight.
   * Returns a restore function.
   *
   * @param {HTMLElement} btn
   * @param {string}      [loadingText]
   * @returns {() => void}
   */
  function withButton(btn, loadingText) {
    if (!btn) return () => {};
    const orig = btn.textContent;
    btn.disabled    = true;
    btn.textContent = loadingText || orig;
    return function restore() {
      btn.disabled    = false;
      btn.textContent = orig;
    };
  }

  /**
   * Simple confirmation dialog using the existing confirm() API.
   * Returns true if user confirmed.
   */
  function confirm(msg) {
    return window.confirm(msg);
  }

  // ── Bootstrap ──────────────────────────────────────────────────────────

  /** Called once on page load to resolve the API base URL. */
  async function loadConfig() {
    try {
      const cfg = await fetch('/api/config').then(r => r.json());
      if (cfg && cfg.apiBaseUrl) setBase(cfg.apiBaseUrl);
    } catch (e) {
      console.warn('[AtomAPI] Could not load /api/config — using default base:', _base);
    }
  }

  // ── Export ─────────────────────────────────────────────────────────────

  // ─── Auth helpers ─────────────────────────────────────────────────────────

  /**
   * POST to /auth/login.
   *
   * The proxy strips accessToken out of the response and sets it as an httpOnly
   * cookie, so it never reaches this code. We refresh the session claims from
   * /api/session instead.
   */
  async function login(email, password) {
    const res = await request('/proxy/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }, { noRetry: true });
    await loadSession();
    return res;
  }

  /**
   * POST to /auth/register — invite-only. As with login, the token is captured
   * by the proxy into an httpOnly cookie and never surfaces here.
   * companyName names the new organization (ignored for org-bound invites,
   * where the user joins the inviting company instead).
   */
  async function register(email, password, displayName, inviteCode, companyName) {
    const res = await request('/proxy/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, displayName, inviteCode, companyName }),
    }, { noRetry: true });
    await loadSession();
    return res;
  }

  /** Clear the session cookie (proxy-side — it's httpOnly) and reload. */
  async function logout() {
    _session = null;
    try {
      await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
    } catch (_) { /* reload regardless — nothing works without the cookie */ }
    window.location.reload();
  }

  global.AtomAPI = {
    base, setBase, loadConfig,
    get, post, del, patch, postForm, getRaw, postRaw,
    request,
    state, withButton, confirm,
    // Auth
    login, register, logout,
    loadSession, isLoggedIn,
    getUserId, getUserEmail, getUserRole, isOrgAdmin, authHeaders,
  };

})(window);
