/**
 * Headless harness for the session-token capture in server.js.
 *
 * Boots the REAL server.js against a stub backend on ephemeral ports and drives
 * it with fetch(), so this fails when the proxy drifts.
 *
 * WHY THIS EXISTS
 * The proxy forwards the browser's `Accept-Encoding: gzip, deflate, br` upstream
 * (accept-encoding is not a hop-by-hop header), and Railway's edge honours it.
 * The token-capture branch then did `Buffer.concat(chunks).toString('utf8')` and
 * JSON.parse on those bytes. On a compressed response that throws, and the catch
 * fell through to "not a token response, pass it through byte-for-byte".
 *
 * Two failures, neither of them loud:
 *   1. No session cookie was ever set. Login looked fine — the backend returned
 *      200 and showApp() runs unconditionally — but every subsequent /proxy/*
 *      call was anonymous and got 401 "You must be logged in to use this
 *      endpoint". Presented as "can't reach the backend", and as Gmail/Outlook
 *      refusing to connect.
 *   2. The raw accessToken was handed straight to page JavaScript, silently
 *      undoing the httpOnly-cookie change whose entire purpose is that an XSS
 *      cannot read the JWT.
 *
 * The three cases below are the ones that matter: no compression, compression
 * negotiated via Accept-Encoding, and a backend that compresses regardless of
 * what we ask for (which is what exercises the decodeBody fallback).
 *
 *   npm run test:proxy
 */

const { spawn } = require('child_process');
const http = require('http');
const zlib = require('zlib');
const path = require('path');

const SERVER_JS = process.argv[2] || path.join(__dirname, '..', 'server.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Stub backend standing in for Atom-Backend's POST /auth/login. */
function startStub(mode) {
    // mode: 'plain' | 'negotiated' | 'always'
    const claims = {
        sub: 'user-1', email: 'e@x.com', role: 'owner',
        exp: Math.floor(Date.now() / 1000) + 86_400,
    };
    const token = 'hdr.' + Buffer.from(JSON.stringify(claims)).toString('base64') + '.sig';
    const payload = JSON.stringify({ accessToken: token, user: { id: 'user-1' } });

    return new Promise((resolve) => {
        const srv = http.createServer((req, res) => {
            const asked = /gzip/.test(req.headers['accept-encoding'] || '');
            const gzip = mode === 'always' || (mode === 'negotiated' && asked);
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            if (gzip) {
                const out = zlib.gzipSync(Buffer.from(payload));
                res.setHeader('Content-Encoding', 'gzip');
                res.setHeader('Content-Length', out.length);
                res.end(out);
            } else {
                res.end(payload);
            }
        });
        srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
    });
}

/** Boot the real server.js. It logs the env PORT, not the bound port, so pin one. */
function startFrontend(port, backendPort) {
    const p = spawn(process.execPath, [SERVER_JS], {
        env: {
            ...process.env,
            PORT: String(port),
            API_BASE_URL: `http://127.0.0.1:${backendPort}`,
            API_KEY: 'k'.repeat(40),
            NODE_ENV: 'development',   // secure:false so the cookie survives http
        },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    p.stderr.on('data', (d) => {
        if (process.env.PROXY_HARNESS_DEBUG) process.stderr.write('[server.js] ' + d);
    });
    return p;
}

let pass = 0, fail = 0;
function assert(c, m) { if (!c) throw new Error(m); }

async function check(name, fn) {
    try { await fn(); console.log(`  PASS  ${name}`); pass++; }
    catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

/** Run one login through the proxy and report what the browser would receive. */
async function login(mode, fePort) {
    const stub = await startStub(mode);
    const fe = startFrontend(fePort, stub.port);
    await wait(1200);
    try {
        const res = await fetch(`http://127.0.0.1:${fePort}/proxy/auth/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept-Encoding': 'gzip, deflate, br',   // what a real browser sends
            },
            body: JSON.stringify({ email: 'e@x.com', password: 'stub-value-unused' }),
        });
        // .text() throws if Content-Encoding lies about the bytes — that is itself
        // a regression, so let it surface rather than swallowing it.
        const body = await res.text();
        return {
            status: res.status,
            setCookie: res.headers.get('set-cookie') || '',
            body,
        };
    } finally {
        fe.kill();
        stub.srv.close();
        await wait(150);
    }
}

(async () => {
console.log('\nproxy session-token capture (server.js)\n');

const CASES = [
    ['uncompressed backend',                       'plain',      4801],
    ['backend gzips when Accept-Encoding allows',  'negotiated', 4802],
    ['backend gzips regardless of Accept-Encoding', 'always',    4803],
];

for (const [label, mode, port] of CASES) {
    await check(`${label}: sets the session cookie`, async () => {
        const r = await login(mode, port);
        assert(r.status === 200, `expected 200, got ${r.status}`);
        assert(/atom_session=/.test(r.setCookie),
            'no atom_session cookie — the client will 401 on every authed call');
        assert(/HttpOnly/i.test(r.setCookie),
            'session cookie is not HttpOnly — page JS can read the JWT');
    });

    await check(`${label}: never leaks accessToken to the page`, async () => {
        const r = await login(mode, port + 40);
        assert(!r.body.includes('accessToken'),
            'raw accessToken reached the response body — httpOnly cookie defeated');
    });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
})();
