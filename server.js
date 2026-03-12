'use strict';

const express = require('express');
const https   = require('https');
const http    = require('http');
const path    = require('path');
const app     = express();

const PORT = process.env.PORT || 3000;

// ─── Startup env validation ────────────────────────────────────────────────────
const BACKEND_BASE = (process.env.API_BASE_URL || 'https://atom-backend-production-8a1e.up.railway.app')
  .replace(/\/+$/, '');

if (!process.env.API_BASE_URL) {
  console.warn('⚠️   API_BASE_URL not set — using default:', BACKEND_BASE);
}
if (!process.env.API_KEY) {
  console.warn('⚠️   API_KEY not set — requests will be forwarded without Authorization header');
}

// ─── Hop-by-hop headers to strip before forwarding ────────────────────────────
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade',
]);

// ─── Request body size limit ───────────────────────────────────────────────────
// Multipart audio uploads can be ~1-5 MB; text payloads are tiny.
// express.raw with a high limit handles both without breaking multipart streaming.
app.use('/proxy', (req, _res, next) => {
  // Only apply limit to non-streaming paths; streaming (audio upload) is piped raw.
  next();
});

// ─── Proxy timeout (ms) ───────────────────────────────────────────────────────
const PROXY_TIMEOUT_MS = 65_000; // slightly over the 60 s AI timeout

// ─── Backend proxy ────────────────────────────────────────────────────────────
// ALL /proxy/* requests are forwarded to the real Railway backend.
// Server-to-server: no browser CORS restriction applies.
app.all('/proxy/*', (req, res) => {
  // /proxy/api/v1/ai/health  →  https://backend.railway.app/api/v1/ai/health
  const targetPath = req.path.replace(/^\/proxy/, '') || '/';
  const search     = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';

  let targetUrl;
  try {
    targetUrl = new URL(targetPath + search, BACKEND_BASE);
  } catch (urlErr) {
    console.error('❌  Invalid proxy target URL:', targetPath, urlErr.message);
    return res.status(400).json({ error: 'invalid_target', message: 'Malformed proxy path' });
  }

  const protocol = targetUrl.protocol === 'https:' ? https : http;

  // Forward headers; strip hop-by-hop and override host
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
  }
  delete headers['host'];

  // Inject API key server-side
  const apiKey = process.env.API_KEY || '';
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const options = {
    hostname : targetUrl.hostname,
    port     : targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
    path     : targetUrl.pathname + targetUrl.search,
    method   : req.method,
    headers,
    timeout  : PROXY_TIMEOUT_MS,
  };

  const label = `${req.method} ${targetPath}`;

  const proxyReq = protocol.request(options, (proxyRes) => {
    if (!res.headersSent) {
      res.status(proxyRes.statusCode);
      // Forward response headers (audio/mpeg etc. must pass through)
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        if (!HOP_BY_HOP.has(k.toLowerCase())) {
          try { res.setHeader(k, v); } catch (_) {}
        }
      }
    }
    proxyRes.pipe(res);
  });

  // Socket / connection timeout
  proxyReq.on('timeout', () => {
    console.error(`⏱️   Proxy timeout (${PROXY_TIMEOUT_MS}ms):`, label, '→', targetUrl.href);
    proxyReq.destroy();
    if (!res.headersSent) {
      res.status(504).json({ error: 'gateway_timeout', message: 'Backend did not respond in time' });
    }
  });

  proxyReq.on('error', (err) => {
    console.error(`❌  Proxy error [${label}]:`, err.message, '→', targetUrl.href);
    if (!res.headersSent) {
      res.status(502).json({ error: 'proxy_error', message: err.message, target: targetUrl.href });
    }
  });

  // Pipe request body (handles multipart audio uploads transparently)
  req.pipe(proxyReq);
});

// ─── Runtime config ────────────────────────────────────────────────────────────
app.get('/api/config', (_req, res) => {
  res.json({
    apiBaseUrl : '/proxy/api/v1',   // always use our proxy
    apiKey     : '',                // key injected server-side by proxy
  });
});

// ─── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.get('*', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀  Atom-Frontend  →  http://0.0.0.0:${PORT}`);
  console.log(`🔀  Proxying API   →  ${BACKEND_BASE}`);
});
