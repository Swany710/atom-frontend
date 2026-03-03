const express = require('express');
const https   = require('https');
const http    = require('http');
const path    = require('path');
const app     = express();

const PORT = process.env.PORT || 3000;

// ─── Backend proxy ────────────────────────────────────────────────────────────
// ALL /proxy/* requests are forwarded to the real Railway backend.
// This runs server-to-server, so there is no browser CORS restriction at all.
const BACKEND_BASE = (process.env.API_BASE_URL || 'https://atom-backend-production-8a1e.up.railway.app')
  .replace(/\/+$/, '');          // strip trailing slash

app.all('/proxy/*', (req, res) => {
  // /proxy/api/v1/ai/health  →  https://backend.railway.app/api/v1/ai/health
  const targetPath = req.path.replace(/^\/proxy/, '') || '/';
  const search     = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const targetUrl  = new URL(targetPath + search, BACKEND_BASE);

  const protocol = targetUrl.protocol === 'https:' ? https : http;

  // Copy headers; remove 'host' so the backend sees its own hostname
  const headers = Object.assign({}, req.headers);
  delete headers['host'];

  // Inject API key server-side if configured
  const apiKey = process.env.API_KEY || '';
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const options = {
    hostname : targetUrl.hostname,
    port     : targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
    path     : targetUrl.pathname + targetUrl.search,
    method   : req.method,
    headers,
  };

  const proxyReq = protocol.request(options, (proxyRes) => {
    res.status(proxyRes.statusCode);
    // Forward response headers (allows audio/mpeg etc. to pass through)
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      res.setHeader(k, v);
    }
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    console.error('❌  Proxy error:', err.message, '→', targetUrl.href);
    if (!res.headersSent) {
      res.status(502).json({ error: 'proxy_error', message: err.message, target: targetUrl.href });
    }
  });

  // Pipe request body (handles multipart audio uploads transparently)
  req.pipe(proxyReq);
});

// ─── Runtime config (kept for compatibility) ──────────────────────────────────
app.get('/api/config', (_req, res) => {
  res.json({
    apiBaseUrl : '/proxy/api/v1',   // always use our proxy now
    apiKey     : '',                // key injected server-side by proxy
  });
});

// ─── Static files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.get('*', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

app.listen(PORT, () => {
  console.log(`🚀  Atom-Frontend  →  http://0.0.0.0:${PORT}`);
  console.log(`🔀  Proxying API   →  ${BACKEND_BASE}`);
});
