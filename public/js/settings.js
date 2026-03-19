/**
 * settings.js — Settings modal, OAuth connection flows (Gmail / Outlook).
 * Depends on: api.js (AtomAPI), chat.js (toggleProfileDropdown)
 *
 * Email OAuth routes live at /email/oauth/* (not under /api/v1/),
 * so we hit the proxy directly at /proxy/email/oauth/*.
 */

const OAUTH_BASE = '/proxy/email/oauth';

/**
 * Returns fetch() headers that include the logged-in user's JWT so the proxy
 * can forward it as Authorization: Bearer, ensuring every OAuth request is
 * scoped to the requesting user — not the server owner.
 */
function _oauthHeaders(extra) {
    const h = Object.assign({}, extra || {});
    const tok = AtomAPI.getToken();
    if (tok) h['X-Atom-Token'] = tok;
    return h;
}

// ── Modal open / close ─────────────────────────────────────────────────────

async function openSettings() {
    toggleProfileDropdown();
    const modal = document.getElementById('settingsModal');
    if (modal) modal.classList.add('visible');
    await refreshSettingsStatus();
}

function closeSettings() {
    const modal = document.getElementById('settingsModal');
    if (modal) modal.classList.remove('visible');
}

// ── Status refresh ─────────────────────────────────────────────────────────

async function refreshSettingsStatus() {
    // Show which account is logged in by decoding the stored JWT
    const accountEl = document.getElementById('accountEmail');
    if (accountEl) {
        try {
            const tok = AtomAPI.getToken();
            if (tok) {
                const payload = JSON.parse(atob(tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
                accountEl.textContent = payload.email || '—';
            } else {
                accountEl.textContent = '—';
            }
        } catch (_) {
            accountEl.textContent = '—';
        }
    }
    await Promise.all([refreshGmailStatus(), refreshOutlookStatus()]);
}

async function refreshGmailStatus() {
    const statusEl      = document.getElementById('gmailStatusBadge');
    const emailEl       = document.getElementById('gmailEmailDisplay');
    const connectBtn    = document.getElementById('gmailConnectBtn');
    const disconnectBtn = document.getElementById('gmailDisconnectBtn');
    const setupNote     = document.getElementById('gmailSetupNote');
    const calStatusEl   = document.getElementById('calendarStatusBadge');

    if (!statusEl) return;
    statusEl.textContent = '⏳ Checking…';

    try {
        const r    = await fetch(OAUTH_BASE + '/gmail-status', { headers: _oauthHeaders() });
        const data = await r.json();

        if (data.connected) {
            statusEl.textContent        = '✅ Connected';
            statusEl.style.color        = '#00d4dc';
            if (emailEl)       emailEl.textContent          = data.emailAddress ?? '';
            if (connectBtn)    connectBtn.textContent        = '🔄 Reconnect (switch account)';
            if (disconnectBtn) disconnectBtn.style.display   = 'block';
            if (setupNote)     setupNote.style.display       = 'none';
            if (calStatusEl) {
                calStatusEl.textContent = '✅ Active (via Gmail OAuth)';
                calStatusEl.style.color = '#00d4dc';
            }
        } else {
            statusEl.textContent        = '❌ Not connected';
            statusEl.style.color        = '#ef4444';
            if (emailEl)       emailEl.textContent          = '';
            if (connectBtn)    connectBtn.textContent        = '🔗 Connect Gmail';
            if (disconnectBtn) disconnectBtn.style.display   = 'none';
            if (calStatusEl) {
                calStatusEl.textContent = '⚠️ Connect Gmail first';
                calStatusEl.style.color = '#f59e0b';
            }
            if (setupNote && data.setupRequired) {
                setupNote.style.display = 'block';
            }
        }
    } catch (e) {
        statusEl.textContent = '⚠️ Status unavailable';
        statusEl.style.color = '#f59e0b';
    }
}

async function refreshOutlookStatus() {
    const statusEl      = document.getElementById('outlookStatusBadge');
    const emailEl       = document.getElementById('outlookEmailDisplay');
    const connectBtn    = document.getElementById('outlookConnectBtn');
    const disconnectBtn = document.getElementById('outlookDisconnectBtn');
    const setupNote     = document.getElementById('outlookSetupNote');

    if (!statusEl) return;
    statusEl.textContent = '⏳ Checking…';

    try {
        const r    = await fetch(OAUTH_BASE + '/outlook-status', { headers: _oauthHeaders() });
        const data = await r.json();

        if (data.connected) {
            statusEl.textContent        = '✅ Connected';
            statusEl.style.color        = '#00d4dc';
            if (emailEl)       emailEl.textContent          = data.emailAddress ?? '';
            if (connectBtn)    connectBtn.textContent        = '🔄 Reconnect (switch account)';
            if (disconnectBtn) disconnectBtn.style.display   = 'block';
            if (setupNote)     setupNote.style.display       = 'none';
        } else {
            statusEl.textContent        = '❌ Not connected';
            statusEl.style.color        = '#ef4444';
            if (emailEl)       emailEl.textContent          = '';
            if (connectBtn)    connectBtn.textContent        = '🔗 Connect Outlook';
            if (disconnectBtn) disconnectBtn.style.display   = 'none';
            if (setupNote && data.setupRequired) {
                setupNote.style.display = 'block';
            }
        }
    } catch (e) {
        statusEl.textContent = '⚠️ Status unavailable';
        statusEl.style.color = '#f59e0b';
    }
}

// ── Gmail OAuth flow ───────────────────────────────────────────────────────

async function connectGmail() {
    try {
        const resp = await fetch(OAUTH_BASE + '/url?provider=gmail', { headers: _oauthHeaders() });

        if (!resp.ok) {
            const errText = await resp.text();
            let parsed;
            try { parsed = JSON.parse(errText); } catch { parsed = null; }
            const msg = parsed?.message ?? errText ?? `HTTP ${resp.status}`;
            throw new Error(`Backend returned ${resp.status}: ${msg}`);
        }

        const text     = await resp.text();
        const oauthUrl = text.replace(/^"|"$/g, '').trim();

        if (!oauthUrl.startsWith('https://accounts.google.com') &&
            !oauthUrl.startsWith('https://login.microsoftonline.com')) {
            throw new Error(
                `Unexpected OAuth URL from backend (first 120 chars): ${oauthUrl.slice(0, 120)}`
            );
        }

        const popup = window.open(
            oauthUrl,
            'gmail-oauth',
            'width=500,height=650,left=200,top=100,resizable=yes,scrollbars=yes'
        );

        if (!popup) {
            alert('Popup was blocked. Please allow popups for this page and try again.');
            return;
        }

        const expectedOrigin = window.location.origin;
        const handler = async (event) => {
            if (event.origin !== expectedOrigin) return;
            if (event.data?.type === 'ATOM_GMAIL_CONNECTED') {
                window.removeEventListener('message', handler);
                popup.close();
                if (event.data.success) {
                    await refreshSettingsStatus();
                } else {
                    alert('Gmail connection failed: ' + (event.data.error ?? 'Unknown error'));
                }
            }
        };
        window.addEventListener('message', handler);

        const pollClose = setInterval(async () => {
            if (popup.closed) {
                clearInterval(pollClose);
                window.removeEventListener('message', handler);
                await refreshSettingsStatus();
            }
        }, 1000);

    } catch (e) {
        alert(
            'Could not start Gmail connection:\n' + e.message +
            '\n\n─── Check your Railway backend env vars ───\n' +
            '• GOOGLE_CLIENT_ID\n' +
            '• GOOGLE_CLIENT_SECRET\n' +
            '• GOOGLE_REDIRECT_URI  (must be your BACKEND URL + /email/oauth/callback)\n' +
            '• OAUTH_STATE_SECRET   (any random 32+ char string)'
        );
    }
}

async function disconnectGmail() {
    if (!AtomAPI.confirm('Disconnect Gmail? You can reconnect at any time.')) return;
    const disconnectBtn = document.getElementById('gmailDisconnectBtn');
    const restore = disconnectBtn ? AtomAPI.withButton(disconnectBtn, 'Disconnecting…') : () => {};

    try {
        const resp = await fetch(OAUTH_BASE + '/disconnect?provider=gmail', { method: 'DELETE', headers: _oauthHeaders() });
        const data = await resp.json();
        if (data.success) {
            await refreshSettingsStatus();
        } else {
            alert('Disconnect failed: ' + (data.error ?? 'Unknown error'));
        }
    } catch (e) {
        alert('Could not disconnect: ' + e.message);
    } finally {
        restore();
        if (disconnectBtn) disconnectBtn.textContent = '🔌 Disconnect Gmail';
    }
}

// ── Outlook OAuth flow ─────────────────────────────────────────────────────

async function connectOutlook() {
    try {
        const resp = await fetch(OAUTH_BASE + '/url?provider=outlook', { headers: _oauthHeaders() });

        if (!resp.ok) {
            const errText = await resp.text();
            let parsed;
            try { parsed = JSON.parse(errText); } catch { parsed = null; }
            const msg = parsed?.message ?? errText ?? `HTTP ${resp.status}`;
            throw new Error(`Backend returned ${resp.status}: ${msg}`);
        }

        const text     = await resp.text();
        const oauthUrl = text.replace(/^"|"$/g, '').trim();

        if (!oauthUrl.startsWith('https://login.microsoftonline.com')) {
            throw new Error(
                `Unexpected OAuth URL from backend (first 120 chars): ${oauthUrl.slice(0, 120)}`
            );
        }

        const popup = window.open(
            oauthUrl,
            'outlook-oauth',
            'width=500,height=650,left=200,top=100,resizable=yes,scrollbars=yes'
        );

        if (!popup) {
            alert('Popup was blocked. Please allow popups for this page and try again.');
            return;
        }

        const expectedOrigin = window.location.origin;
        const handler = async (event) => {
            if (event.origin !== expectedOrigin) return;
            if (event.data?.type === 'ATOM_OUTLOOK_CONNECTED') {
                window.removeEventListener('message', handler);
                popup.close();
                if (event.data.success) {
                    await refreshOutlookStatus();
                } else {
                    alert('Outlook connection failed: ' + (event.data.error ?? 'Unknown error'));
                }
            }
        };
        window.addEventListener('message', handler);

        const pollClose = setInterval(async () => {
            if (popup.closed) {
                clearInterval(pollClose);
                window.removeEventListener('message', handler);
                await refreshOutlookStatus();
            }
        }, 1000);

    } catch (e) {
        alert(
            'Could not start Outlook connection:\n' + e.message +
            '\n\n─── Check your Railway backend env vars ───\n' +
            '• MICROSOFT_CLIENT_ID\n' +
            '• MICROSOFT_CLIENT_SECRET\n' +
            '• MICROSOFT_REDIRECT_URI  (must be your BACKEND URL + /email/oauth/callback)\n' +
            '• MICROSOFT_TENANT_ID     (use "common" for personal + work accounts)\n' +
            '• OAUTH_STATE_SECRET      (any random 32+ char string)'
        );
    }
}

async function disconnectOutlook() {
    if (!AtomAPI.confirm('Disconnect Outlook? You can reconnect at any time.')) return;
    const disconnectBtn = document.getElementById('outlookDisconnectBtn');
    const restore = disconnectBtn ? AtomAPI.withButton(disconnectBtn, 'Disconnecting…') : () => {};

    try {
        const resp = await fetch(OAUTH_BASE + '/disconnect?provider=outlook', { method: 'DELETE', headers: _oauthHeaders() });
        const data = await resp.json();
        if (data.success) {
            await refreshOutlookStatus();
        } else {
            alert('Disconnect failed: ' + (data.error ?? 'Unknown error'));
        }
    } catch (e) {
        alert('Could not disconnect: ' + e.message);
    } finally {
        restore();
        if (disconnectBtn) disconnectBtn.textContent = '🔌 Disconnect Outlook';
    }
}

// ── Global OAuth popup message listener ───────────────────────────────────
// Handles redirects that post back without a specific handler registered
// (e.g. popup was opened by a different code path).

window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) return;
    if (event.data?.type === 'ATOM_GMAIL_CONNECTED')   refreshGmailStatus();
    if (event.data?.type === 'ATOM_OUTLOOK_CONNECTED') refreshOutlookStatus();
});
