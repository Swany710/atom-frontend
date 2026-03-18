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

  // -- Token / session helpers -----------------------------------------------
  var TOKEN_KEY = 'atom_jwt';
  function getToken()   { return localStorage.getItem(TOKEN_KEY); }
  function setToken(t)  { localStorage.setItem(TOKEN_KEY, t); }
  function clearToken() { localStorage.removeItem(TOKEN_KEY); }
  function isLoggedIn() { return !!localStorage.getItem(TOKEN_KEY); }

  /** Headers added to every request. Injects JWT if present. */
  function commonHeaders(extra) {
    var h = { Accept: 'application/json' };
    var tok = getToken();
    if (tok) h['X-Atom-Token'] = tok;
    return Object.assign(h, extra || {});
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

  /** POST to /auth/login — stores token, returns { accessToken, userId, email } */
  async function login(email, password) {
    const res = await request('/proxy/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }, { noRetry: true });
    if (res && res.accessToken) setToken(res.accessToken);
    return res;
  }

  /** POST to /auth/register — stores token, returns { accessToken, userId, email } */
  async function register(email, password, displayName) {
    const res = await request('/proxy/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, displayName }),
    }, { noRetry: true });
    if (res && res.accessToken) setToken(res.accessToken);
    return res;
  }

  /** Clear stored token and reload to login screen */
  function logout() {
    clearToken();
    window.location.reload();
  }

  global.AtomAPI = {
    base, setBase, loadConfig,
    get, post, del, postForm, getRaw, postRaw,
    request,
    state, withButton, confirm,
    // Auth
    login, register, logout,
    getToken, setToken, clearToken, isLoggedIn,
  };

})(window);
