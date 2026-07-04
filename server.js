'use strict';

const express  = require('express');
const https    = require('https');
const http     = require('http');
const path     = require('path');
const helmet   = require('helmet');
const app      = express();

// ─── Security headers ──────────────────────────────────────────────────────────
// Sets X-Content-Type-Options, X-Frame-Options, Strict-Transport-Security,
// Referrer-Policy, X-XSS-Protection, and a Content-Security-Policy that
// restricts scripts, styles, and media to this origin only.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      // Scripts: same-origin files ONLY. All former inline <script> blocks
      // live in /js/boot.js, and every inline onclick=/onkeydown= attribute
      // was migrated to data-action/data-enter handled by /js/dispatch.js —
      // so no 'unsafe-inline' and Helmet's default script-src-attr 'none'
      // stands. Injected markup can no longer execute script.
      scriptSrc:   ["'self'"],
      styleSrc:    ["'self'", "'unsafe-inline'"],   // inline style="" attrs still used in markup
      mediaSrc:    ["'self'", 'blob:'],             // blob: URLs for recorded audio playback
      connectSrc:  ["'self'", "wss://api.openai.com", "https://api.openai.com"],  // API proxy + OpenAI Realtime WebSocket
      imgSrc:      ["'self'", 'data:'],
      fontSrc:     ["'self'"],
      objectSrc:   ["'none'"],
      frameAncestors: ["'none'"],                   // equivalent to X-Frame-Options: DENY
    },
  },
}));

const PORT = process.env.PORT || 3000;

// ─── Startup env validation ────────────────────────────────────────────────────
const BACKEND_BASE = (process.env.API_BASE_URL || 'http://localhost:3000')
  .replace(/\/+$/, '');

if (!process.env.API_BASE_URL) console.warn('⚠️  API_BASE_URL not set — using default:', BACKEND_BASE);
if (!process.env.API_KEY)      console.warn('⚠️  API_KEY not set — requests forwarded without auth');

// ─── Hop-by-hop headers ────────────────────────────────────────────────────────
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade',
]);

const PROXY_TIMEOUT_MS = 65_000;

// ─── Anonymous allowlist ───────────────────────────────────────────────────────
// SECURITY: the proxy signs requests with the server-side API_KEY, which the
// backend treats as OWNER-level credentials. Previously EVERY anonymous request
// got that signature — meaning anyone who could reach this frontend had full
// access to the owner's email, calendar, and CRM without logging in.
//
// Now only these paths may pass through without a logged-in user (JWT).
// Everything else returns 401 until the browser supplies X-Atom-Token.
const ANON_ALLOWED = [
  /^\/auth\/login$/,       // must be reachable to log in at all
  /^\/auth\/register$/,    // beta signup
  /^\/health(\/|$)/,       // liveness probes
];

function isAnonAllowed(backendPath) {
  return ANON_ALLOWED.some((re) => re.test(backendPath));
}

// ─── Backend HTTP proxy ────────────────────────────────────────────────────────
app.all('/proxy/*', (req, res) => {
  const targetPath = req.path.replace(/^\/proxy/, '') || '/';
  const search     = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';

  let targetUrl;
  try {
    targetUrl = new URL(targetPath + search, BACKEND_BASE);
  } catch (urlErr) {
    return res.status(400).json({ error: 'invalid_target', message: 'Malformed proxy path' });
  }

  const protocol = targetUrl.protocol === 'https:' ? https : http;

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
  }
  delete headers['host'];

  // Auth forwarding:
  //   Logged-in user  → forward their JWT; the backend scopes data to them.
  //   Anonymous       → only allowlisted paths (login/register/health) pass,
  //                     signed with the API key so the backend accepts them.
  //   Anything else   → 401. The API key must NEVER be attached to arbitrary
  //                     anonymous requests — it is the owner/admin credential.
  const userToken = req.headers['x-atom-token'];
  delete headers['x-atom-token']; // strip before forwarding to backend
  if (userToken) {
    headers['Authorization'] = `Bearer ${userToken}`;
  } else if (isAnonAllowed(targetUrl.pathname)) {
    const apiKey = process.env.API_KEY || '';
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  } else {
    return res.status(401).json({
      error: 'login_required',
      message: 'You must be logged in to use this endpoint.',
    });
  }

  const options = {
    hostname : targetUrl.hostname,
    port     : targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
    path     : targetUrl.pathname + targetUrl.search,
    method   : req.method,
    headers,
    timeout  : PROXY_TIMEOUT_MS,
  };

  const proxyReq = protocol.request(options, (proxyRes) => {
    if (!res.headersSent) {
      res.status(proxyRes.statusCode);
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        if (!HOP_BY_HOP.has(k.toLowerCase())) {
          try { res.setHeader(k, v); } catch (_) {}
        }
      }
    }
    proxyRes.pipe(res);
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (!res.headersSent) res.status(504).json({ error: 'gateway_timeout' });
  });

  proxyReq.on('error', (err) => {
    if (!res.headersSent) res.status(502).json({ error: 'proxy_error', message: err.message });
  });

  req.pipe(proxyReq);
});

// ─── Runtime config ────────────────────────────────────────────────────────────
app.get('/api/config', (_req, res) => {
  res.json({ apiBaseUrl: '/proxy/api/v1', apiKey: '' });
});

// ─── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── Start ────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`🚀  Atom-Frontend  →  http://0.0.0.0:${PORT}`);
  console.log(`🔀  Proxying API   →  ${BACKEND_BASE}`);
});
