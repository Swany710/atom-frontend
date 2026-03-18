'use strict';

const express  = require('express');
const https    = require('https');
const http     = require('http');
const path     = require('path');
const app      = express();

const PORT = process.env.PORT || 3000;

// ─── Startup env validation ────────────────────────────────────────────────────
const BACKEND_BASE = (process.env.API_BASE_URL || 'https://atom-backend-production-8a1e.up.railway.app')
  .replace(/\/+$/, '');

if (!process.env.API_BASE_URL) console.warn('⚠️  API_BASE_URL not set — using default:', BACKEND_BASE);
if (!process.env.API_KEY)      console.warn('⚠️  API_KEY not set — requests forwarded without auth');

// ─── Hop-by-hop headers ────────────────────────────────────────────────────────
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade',
]);

const PROXY_TIMEOUT_MS = 65_000;

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

  // If the frontend sends a user JWT, use it; otherwise fall back to API key
  const userToken = req.headers['x-atom-token'];
  delete headers['x-atom-token']; // strip before forwarding to backend
  if (userToken) {
    headers['Authorization'] = `Bearer ${userToken}`;
  } else {
    const apiKey = process.env.API_KEY || '';
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
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
