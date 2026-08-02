/**
 * boot.js - app bootstrap + auth screen wiring.
 * Moved out of an inline <script> block in index.html so the CSP can
 * drop 'unsafe-inline' for scripts (see server.js).
 */

document.addEventListener('DOMContentLoaded', async function() {
    setupTextInput(); // wire input listeners regardless of login state
    // The JWT lives in an httpOnly cookie the page cannot read, so login state
    // comes from the proxy. This MUST be awaited before isLoggedIn() — every
    // session accessor reads the object it populates.
    await AtomAPI.loadSession();
    if (AtomAPI.isLoggedIn()) { showApp(); }
    // else: auth screen visible by default
});

// ─── Auth screen ───────────────────────────────────────────────────
function authSwitchTab(tab) {
    document.getElementById('authFormLogin').style.display    = tab === 'login'    ? '' : 'none';
    document.getElementById('authFormRegister').style.display = tab === 'register' ? '' : 'none';
    document.getElementById('authTabLogin').classList.toggle('active', tab === 'login');
    document.getElementById('authTabRegister').classList.toggle('active', tab === 'register');
    document.getElementById('authError').textContent = '';
}
async function handleAuthLogin() {
    const email = document.getElementById('authLoginEmail').value.trim();
    const password = document.getElementById('authLoginPassword').value;
    const btn = document.getElementById('authLoginBtn');
    const errEl = document.getElementById('authError');
    errEl.textContent = '';
    if (!email || !password) { errEl.textContent = 'Please enter email and password.'; return; }
    btn.disabled = true; btn.textContent = 'Signing in...';
    try { await AtomAPI.login(email, password); showApp(); }
    catch (e) { errEl.textContent = e.message || 'Login failed.'; }
    finally { btn.disabled = false; btn.textContent = 'Sign In'; }
}
async function handleAuthRegister() {
    const name = document.getElementById('authRegName').value.trim();
    const company = document.getElementById('authRegCompany').value.trim();
    const email = document.getElementById('authRegEmail').value.trim();
    const password = document.getElementById('authRegPassword').value;
    const inviteCode = document.getElementById('authRegInvite').value.trim();
    const btn = document.getElementById('authRegisterBtn');
    const errEl = document.getElementById('authError');
    errEl.textContent = '';
    if (!email || !password) { errEl.textContent = 'Email and password are required.'; return; }
    if (password.length < 8) { errEl.textContent = 'Password must be at least 8 characters.'; return; }
    if (!inviteCode) { errEl.textContent = 'An invite code is required.'; return; }
    btn.disabled = true; btn.textContent = 'Creating account...';
    try {
        await AtomAPI.register(email, password, name || undefined, inviteCode, company || undefined);
        showApp();
    }
    catch (e) { errEl.textContent = e.message || 'Registration failed.'; }
    finally { btn.disabled = false; btn.textContent = 'Create Account'; }
}
document.addEventListener('keydown', function(e) {
    if (e.key !== 'Enter') return;
    const s = document.getElementById('authScreen');
    if (!s || s.classList.contains('hidden')) return;
    if (document.getElementById('authFormLogin').style.display !== 'none') handleAuthLogin();
    else handleAuthRegister();
});
function showApp() {
    document.getElementById('authScreen').classList.add('hidden');
    bootApp();
}
async function bootApp() {
    await AtomAPI.loadConfig();
    applyRoleGating(); // show/hide admin nav based on the JWT role
    // initializeWaveform() already starts the animation loop — calling
    // startWaveformAnimation() again here ran a SECOND rAF loop, drawing twice
    // per frame and advancing the animation clock at double speed.
    initializeWaveform();
    setupTextInput();
    checkBackendStatus();
    // Reflect the persisted "Always read" preference on the toggle
    if (typeof updateAlwaysReadUI === 'function') updateAlwaysReadUI();
    updateConversationDisplay();
    // Click outside response area collapses it — but interacting with the
    // composer (text box, Send, dictate, mode icons) must NOT close the chat.
    document.addEventListener('click', function(e) {
        const responseArea = document.getElementById('responseArea');
        if (!responseArea || !responseArea.classList.contains('pinned')) return;
        if (e.target.closest && e.target.closest(
            '.response-area, .main-text-bar, .mode-icons, #vttButtonContainer, #muteBtn, #alwaysReadBtn, .chat-hover-zone'
        )) return;
        unpinResponseArea();
    });
    // Hovering the right edge of the dashboard opens the chat panel
    const hoverZone = document.getElementById('chatHoverZone');
    if (hoverZone) hoverZone.addEventListener('mouseenter', pinResponseArea);
}
