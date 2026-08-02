'use strict';

const express  = require('express');
const https    = require('https');
const http     = require('http');
const path     = require('path');
const zlib     = require('zlib');
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
      // Same-origin only. The api.openai.com entries (and the wss: one) existed
      // for the OpenAI Realtime live-voice mode, removed 2026-07-28. Speech now
      // goes ElevenLabs → Claude → ElevenLabs, all via the /proxy path on this
      // origin, so the browser has no reason to reach OpenAI directly. Leaving
      // the allowance in place only widened where injected script could talk to.
      connectSrc:  ["'self'"],
      imgSrc:      ["'self'", 'data:'],
      fontSrc:     ["'self'"],
      objectSrc:   ["'none'"],
      frameAncestors: ["'none'"],                   // equivalent to X-Frame-Options: DENY
    },
  },
}));

// ─── Trust proxy ───────────────────────────────────────────────────────────────
// Railway terminates TLS and forwards, so without this req.ip is the edge
// address for every visitor. That address is what we hand the backend as
// X-Forwarded-For, and the backend uses it as the anonymous rate-limit bucket.
//
// This defaults to 0 OUTSIDE production, and that default is load-bearing.
// `trust proxy: n` tells Express to believe the (n+1)th-from-last entry of a
// client-supplied X-Forwarded-For header. If nothing is actually in front of
// this process, "trust one hop" means trusting a header the client wrote — so
// a client can pick its own rate-limit bucket and walk around login throttling
// by sending a different value each request. In production Railway's edge
// appends the observed address, so one hop is real; run it anywhere without a
// proxy and it is a hole.
//
// Set TRUST_PROXY_HOPS explicitly to the true depth of your chain (add one per
// additional CDN/proxy). Too low and everyone shares a bucket; too high and
// clients can forge one. Too low is the safe direction to be wrong in.
const TRUST_PROXY_HOPS = Number(
  process.env.TRUST_PROXY_HOPS ?? (process.env.NODE_ENV === 'production' ? 1 : 0),
);
app.set('trust proxy', Number.isFinite(TRUST_PROXY_HOPS) ? TRUST_PROXY_HOPS : 0);

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

// ─── Session cookie ────────────────────────────────────────────────────────────
// The JWT used to live in localStorage, where any successful XSS could read it
// and exfiltrate a 24-hour credential. The CSP above is the primary defence and
// it is strict, but "one bug away from total account takeover" is a bad place to
// stand. The token now lives in an httpOnly cookie that page JavaScript cannot
// read at all; this proxy is the only thing that ever sees it.
//
// httpOnly  — unreadable from document.cookie, so XSS cannot exfiltrate it
// sameSite  — 'strict' blocks the cookie on cross-site requests, which is what
//             makes CSRF a non-issue now that auth rides on a cookie instead of
//             an explicit header. Frontend and API proxy are same-origin, so
//             strict costs nothing.
// secure    — HTTPS only in production; off locally so http://localhost works
// path '/'  — the proxy and the app share the origin
const SESSION_COOKIE = 'atom_session';
const IS_PROD = process.env.NODE_ENV === 'production';

function sessionCookieOptions(maxAgeMs) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure:   IS_PROD,
    path:     '/',
    ...(maxAgeMs ? { maxAge: maxAgeMs } : {}),
  };
}

/**
 * Minimal cookie-header parser.
 *
 * Deliberately not pulling in cookie-parser: this needs exactly one cookie, and
 * a security fix is a poor moment to widen the dependency surface.
 */
function readCookie(req, name) {
  const header = req.headers?.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

/** Decode a JWT payload WITHOUT verifying it. */
function decodeJwtPayload(token) {
  // The signature is verified by the backend on every request — this is only
  // used to render the signed-in user's name and role, never to grant access.
  // Anything gated on the result is re-checked server-side.
  const parts = String(token || '').split('.');
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/** Paths whose JSON response carries a freshly-minted token we must capture. */
const TOKEN_ISSUING_PATHS = [/^\/auth\/login$/, /^\/auth\/register$/];
const issuesToken = (p) => TOKEN_ISSUING_PATHS.some((re) => re.test(p));

/**
 * Undo Content-Encoding so a token-issuing response can actually be parsed.
 *
 * This proxy forwards the browser's Accept-Encoding upstream, and Railway's edge
 * honours it — so the login response arrived gzipped, `Buffer.concat(chunks)
 * .toString('utf8')` produced binary garbage, JSON.parse threw, and the catch
 * fell through to "not a token response, pass it through byte-for-byte". Net
 * effect: no session cookie was ever set (every later /proxy/* call 401s with
 * "You must be logged in"), AND the raw JWT was handed to page JavaScript —
 * precisely what moving it into an httpOnly cookie was meant to prevent.
 */
function decodeBody(buf, encoding) {
  switch (String(encoding || '').trim().toLowerCase()) {
    case 'gzip':    return zlib.gunzipSync(buf);
    case 'deflate': return zlib.inflateSync(buf);
    case 'br':      return zlib.brotliDecompressSync(buf);
    default:        return buf;
  }
}

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

  // Belt: on the two paths whose body we have to read, ask upstream for
  // plaintext instead of blindly forwarding the browser's
  // "Accept-Encoding: gzip, deflate, br". Braces: decodeBody() in the response
  // handler still copes if something compresses anyway. Every other path keeps
  // normal compression — those are streamed through untouched.
  const captureToken = issuesToken(targetUrl.pathname);
  if (captureToken) delete headers['accept-encoding'];

  // The browser must never influence what the backend believes about the
  // client address. The backend runs with `trust proxy` and uses the resulting
  // IP as the anonymous rate-limit bucket, so a client that could set its own
  // X-Forwarded-For could evade login rate limiting entirely. Drop whatever
  // came in and state the address WE observed.
  delete headers['x-forwarded-for'];
  delete headers['x-real-ip'];
  headers['X-Forwarded-For'] = req.ip;

  // Auth forwarding:
  //   Logged-in user  → forward their JWT; the backend scopes data to them.
  //   Anonymous       → only allowlisted paths (login/register/health) pass,
  //                     signed with the API key so the backend accepts them.
  //   Anything else   → 401. The API key must NEVER be attached to arbitrary
  //                     anonymous requests — it is the owner/admin credential.
  //
  // The token comes from the httpOnly session cookie. The legacy X-Atom-Token
  // header is still accepted so a stale open tab keeps working through its
  // current session, but it is never issued any more and is always stripped
  // before forwarding.
  const cookieToken = readCookie(req, SESSION_COOKIE);
  const userToken   = cookieToken || req.headers['x-atom-token'];
  delete headers['x-atom-token']; // strip before forwarding to backend
  delete headers['cookie'];       // the backend has no use for browser cookies
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

    // Login / register: buffer the (tiny) JSON response so the freshly-minted
    // accessToken can be moved out of the response body and into an httpOnly
    // cookie. The browser gets the rest of the payload but never the token —
    // that is the whole point of the change. Everything else streams as before.
    if (captureToken) {
      const chunks = [];
      proxyRes.on('data', (c) => chunks.push(c));
      proxyRes.on('end', () => {
        let body;
        try {
          body = JSON.parse(
            decodeBody(Buffer.concat(chunks), proxyRes.headers['content-encoding'])
              .toString('utf8'),
          );
        } catch (_) { body = null; }

        if (body && typeof body.accessToken === 'string') {
          const claims = decodeJwtPayload(body.accessToken);
          // Match the cookie lifetime to the token's own expiry so the browser
          // drops it exactly when it stops being useful. Falls back to 24h,
          // which is the backend's JWT_EXPIRES_IN default.
          const maxAge = claims?.exp
            ? Math.max(0, claims.exp * 1000 - Date.now())
            : 24 * 60 * 60 * 1000;

          res.cookie(SESSION_COOKIE, body.accessToken, sessionCookieOptions(maxAge));
          delete body.accessToken;

          const out = Buffer.from(JSON.stringify(body), 'utf8');
          res.setHeader('Content-Type', 'application/json');
          // We are re-emitting PLAINTEXT. Any Content-Encoding copied from
          // upstream now describes bytes that no longer exist, and the browser
          // would fail to decode a body that was never compressed.
          res.removeHeader('Content-Encoding');
          res.setHeader('Content-Length', out.length);
          return res.end(out);
        }

        // A 2xx on a token-issuing path that yields no accessToken means the
        // capture silently failed and the body — token and all — is about to be
        // handed to page JavaScript. Never fail quietly here: this is the exact
        // shape of the gzip bug that cost a full debugging session.
        if (proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
          console.error(
            '[proxy] token capture FAILED on', targetUrl.pathname,
            '— no accessToken parsed from a', proxyRes.statusCode, 'response',
            `(content-encoding: ${proxyRes.headers['content-encoding'] || 'none'}).`,
            'No session cookie was set; the client will 401 on every authed call.',
          );
        }

        // Not a token response (a 401, a validation error): pass it through
        // byte-for-byte. Content-Length was already copied from upstream.
        return res.end(Buffer.concat(chunks));
      });
      proxyRes.on('error', () => { if (!res.writableEnded) res.end(); });
      return;
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

// ─── Session ───────────────────────────────────────────────────────────────────
// The page can no longer read the JWT, so it can no longer decode its own
// claims. This endpoint hands back the DISPLAY claims only — never the token.
//
// These values drive UI affordances (which name to show, whether to render the
// admin tab). They are not a security boundary: the backend re-checks the role
// on every request that matters, so a user who lies to their own browser about
// being an admin simply gets a tab full of 403s.
app.get('/api/session', (req, res) => {
  const token  = readCookie(req, SESSION_COOKIE);
  const claims = token ? decodeJwtPayload(token) : null;

  if (!claims) return res.json({ authenticated: false });

  // Expired token: clear the cookie so the app lands on the login screen
  // instead of firing a round of doomed requests first.
  if (claims.exp && claims.exp * 1000 <= Date.now()) {
    res.clearCookie(SESSION_COOKIE, sessionCookieOptions());
    return res.json({ authenticated: false });
  }

  res.json({
    authenticated: true,
    userId: claims.sub  ?? null,
    email:  claims.email ?? null,
    role:   claims.role  ?? 'member',
    orgId:  claims.org   ?? null,
  });
});

// Logout has to happen server-side now — the cookie is httpOnly, so the page
// cannot clear it itself.
app.post('/api/logout', (_req, res) => {
  res.clearCookie(SESSION_COOKIE, sessionCookieOptions());
  res.json({ ok: true });
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
