/**
 * chat.js — Text chat, conversation display, status updates, response panel.
 * Depends on: api.js (AtomAPI)
 */

// ── Shared state (written here, read by voice.js) ─────────────────────────
window.conversationMessages = [];
window.conversationId       = null;
window.inputMode            = 'live';   // 'live' | 'text' | 'vtt'

// ── Backend status ─────────────────────────────────────────────────────────

async function checkBackendStatus() {
    try {
        updateStatus('Connecting to backend...', 'processing');
        updateMemoryStatus('connecting', 'Connecting...');
        const status = await AtomAPI.get('/ai/health', { timeoutMs: 10_000 });
        console.log('✅ Backend status:', status);
        updateMemoryStatus('connected', 'Backend Connected');
        updateStatus('Ready! Try voice or text commands.', 'success');
        updateSidebarFooter(true, 'Backend connected');
    } catch (error) {
        console.error('❌ Backend connection failed:', error.message);
        updateMemoryStatus('error', 'Backend Unavailable');
        updateStatus(`Backend unavailable — ${error.message}`, 'error');
        updateSidebarFooter(false, 'Backend unavailable');
        // Auto-retry once after 5 seconds
        setTimeout(async () => {
            try {
                await AtomAPI.get('/ai/health', { timeoutMs: 10_000, noRetry: true });
                updateMemoryStatus('connected', 'Backend Connected');
                updateStatus('Ready! Try voice or text commands.', 'success');
                updateSidebarFooter(true, 'Backend connected');
            } catch (_) { /* silent */ }
        }, 5000);
    }
}

async function testAI() {
    updateStatus('Testing AI...', 'processing');
    await processTextCommand('Hello Atom! This is a test of your AI capabilities.');
}

async function testBackend() {
    updateStatus('Testing backend connection...', 'processing');
    await checkBackendStatus();
}

// ── Text command ───────────────────────────────────────────────────────────

async function processTextCommand(text) {
    const sendBtn = document.getElementById('sendButton');
    const restore = AtomAPI.withButton(sendBtn, '⏳');
    try {
        updateStatus('Processing with AI...', 'processing');
        addMessageToConversation('user', text);

        const payload = { message: text, ...(window.conversationId && { conversationId: window.conversationId }) };
        const result  = await AtomAPI.post('/ai/text', payload, { timeoutMs: 60_000 });

        if (result.conversationId) window.conversationId = result.conversationId;
        addMessageToConversation('assistant', result.message);
        updateStatus('Response generated successfully!', 'success');
        pinResponseArea();
        window.playResponseAudio && playResponseAudio(result.message);
    } catch (error) {
        console.error('Error processing text:', error);
        updateStatus('Error: ' + error.message, 'error');
        addMessageToConversation('assistant', `Sorry, I encountered an error: ${error.message}`);
        pinResponseArea();
    } finally {
        restore();
    }
}

// ── Conversation display ───────────────────────────────────────────────────

function addMessageToConversation(role, content) {
    window.conversationMessages.push({ role, content, timestamp: new Date() });
    updateConversationDisplay();
}

function updateConversationDisplay() {
    const responseContent = document.getElementById('responseContent');
    if (!responseContent) return;

    if (window.conversationMessages.length === 0) {
        responseContent.innerHTML = `
            <div class="conversation-welcome">
                <div>👋 Hello! I'm Atom, your personal AI assistant.</div>
                <div style="margin-top:1rem;color:#999;">I can help with daily tasks, planning, questions, and more. Try voice or text!</div>
            </div>`;
        return;
    }

    let html = '<div class="conversation-thread">';
    window.conversationMessages.forEach((message, idx) => {
        const cleanContent = (message.content || '')
            .replace(/🎤\s*"/g, '"')
            .replace(/[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]/gu, '')
            .trim();

        if (message.role === 'user') {
            html += `
                <div class="conversation-message user-message">
                    <div class="message-sender">You</div>
                    <div class="message-content">${cleanContent}</div>
                </div>`;
        } else {
            const isConfirmation = message.content.includes('Shall I go ahead') ||
                                   message.content.includes('Shall I proceed');
            if (isConfirmation && message.awaitingConfirmation !== false) {
                html += `
                    <div class="conversation-message assistant-message confirm-card" id="confirm-${idx}">
                        <div class="message-sender">Atom — Action needed</div>
                        <div class="message-content confirm-body">${cleanContent.replace(/\n/g, '<br>')}</div>
                        <div class="confirm-buttons">
                            <button class="confirm-yes-btn" onclick="confirmAction(${idx})">Confirm</button>
                            <button class="confirm-no-btn"  onclick="cancelAction(${idx})">Cancel</button>
                        </div>
                    </div>`;
            } else {
                html += `
                    <div class="conversation-message assistant-message">
                        <div class="message-sender">Atom</div>
                        <div class="message-content">${cleanContent.replace(/\n/g, '<br>')}</div>
                    </div>`;
            }
        }
    });

    html += '</div>';
    html += `<div class="conversation-stats"><small>${window.conversationMessages.length} messages • Claude (Anthropic)</small></div>`;

    responseContent.innerHTML = html;
    const container = document.querySelector('.response-content-container');
    if (container) container.scrollTop = container.scrollHeight;
}

// ── Input mode selector ────────────────────────────────────────────────────
//
// Three modes:
//   live — full realtime voice (waveform + mic button active)
//   text — text only (waveform hidden, voice off)
//   vtt  — voice-to-text dictation (speak → text box → review → Send)

function setInputMode(mode) {
    window.inputMode = mode;

    const waveContainer = document.querySelector('.waveform-container');
    const waveControls  = document.querySelector('.wave-controls');
    const vttContainer  = document.getElementById('vttButtonContainer');
    const statusText    = document.getElementById('statusText');

    // Update mode button styles
    document.querySelectorAll('.atom-mode-btn').forEach(btn => {
        btn.style.background = 'transparent';
        btn.style.color      = '#94a3b8';
        btn.style.fontWeight = 'normal';
    });
    const activeBtn = document.getElementById('mode-' + mode);
    if (activeBtn) {
        activeBtn.style.background = 'rgba(0,212,220,0.18)';
        activeBtn.style.color      = '#00d4dc';
        activeBtn.style.fontWeight = '600';
    }

    if (mode === 'live') {
        if (waveContainer) waveContainer.style.display = '';
        if (waveControls)  waveControls.style.display  = '';
        if (vttContainer)  vttContainer.style.display  = 'none';
        if (statusText)    statusText.style.display     = '';
        // Stop VTT if running
        if (typeof stopVoiceToText === 'function' && isVttActive) stopVoiceToText();
        updateStatus('Click the mic or waveform to start listening.', 'info');

    } else if (mode === 'text') {
        if (waveContainer) waveContainer.style.display = 'none';
        if (waveControls)  waveControls.style.display  = 'none';
        if (vttContainer)  vttContainer.style.display  = 'none';
        if (statusText)    statusText.style.display     = 'none';
        // Stop live voice if running
        if (typeof cleanupRealtime === 'function' && isRealtimeActive) cleanupRealtime();
        // Stop VTT if running
        if (typeof stopVoiceToText === 'function' && isVttActive) stopVoiceToText();

    } else if (mode === 'vtt') {
        if (waveContainer) waveContainer.style.display = 'none';
        if (waveControls)  waveControls.style.display  = 'none';
        if (vttContainer)  vttContainer.style.display  = '';
        if (statusText)    statusText.style.display     = '';
        // Stop live voice if running
        if (typeof cleanupRealtime === 'function' && isRealtimeActive) cleanupRealtime();
        updateStatus('Click "Dictate" to speak — your words appear in the text box below.', 'info');
    }
}

// ── Text input ─────────────────────────────────────────────────────────────

function setupTextInput() {
    const textInput = document.getElementById('textInput');
    if (!textInput) return;

    textInput.addEventListener('input', function () {
        this.style.height = 'auto';
        this.style.height = Math.min(this.scrollHeight, 120) + 'px';
        const sendButton = document.getElementById('sendButton');
        if (sendButton) sendButton.disabled = this.value.trim() === '';
    });

    const sendButton = document.getElementById('sendButton');
    if (sendButton) sendButton.disabled = true;

    // Wire main dashboard text input
    const mainInput = document.getElementById('mainTextInput');
    if (mainInput) {
        mainInput.addEventListener('input', function () {
            this.style.height = 'auto';
            this.style.height = Math.min(this.scrollHeight, 110) + 'px';
            document.getElementById('mainSendButton').disabled = this.value.trim() === '';
        });
    }
}

function handleTextInputKeydown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendTextFromInput();
    }
}

async function sendTextFromInput() {
    const textInput = document.getElementById('textInput');
    const message   = textInput.value.trim();
    if (!message) return;

    textInput.value = '';
    textInput.style.height = 'auto';
    const sendButton = document.getElementById('sendButton');
    if (sendButton) sendButton.disabled = true;

    await sendTextMessage(message);
}

async function sendTextMessage(text) {
    await processTextCommand(text);
}

// ── Main dashboard text input ──────────────────────────────────────────────

function handleMainTextKeydown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendTextFromMainInput();
    }
}

async function sendTextFromMainInput() {
    const input   = document.getElementById('mainTextInput');
    const sendBtn = document.getElementById('mainSendButton');
    const message = input.value.trim();
    if (!message) return;
    input.value = '';
    input.style.height = 'auto';
    if (sendBtn) sendBtn.disabled = true;
    // Reset the VTT buffer so next dictation starts fresh
    if (window.resetVttBuffer) window.resetVttBuffer();
    try {
        await sendTextMessage(message);
    } finally {
        if (sendBtn) sendBtn.disabled = true;
    }
}

// ── Confirm / cancel action cards ──────────────────────────────────────────

function confirmAction(msgIndex) {
    const message = window.conversationMessages[msgIndex];
    if (!message) return;
    message.awaitingConfirmation = false;
    updateConversationDisplay();
    sendTextMessage('Yes, please proceed.');
}

function cancelAction(msgIndex) {
    const message = window.conversationMessages[msgIndex];
    if (!message) return;
    message.awaitingConfirmation = false;
    updateConversationDisplay();
    sendTextMessage('No, cancel that action.');
}

// ── Status / memory indicator ──────────────────────────────────────────────

function updateStatus(message, type = 'normal') {
    const statusText = document.getElementById('statusText');
    if (!statusText) return;
    statusText.textContent = message;
    statusText.classList.remove('listening', 'processing', 'success', 'error', 'warning', 'info');
    if (type !== 'normal') statusText.classList.add(type);
}

function updateMemoryStatus(type, text) {
    const memoryStatus     = document.getElementById('memoryStatus');
    const memoryStatusText = document.getElementById('memoryStatusText');
    if (memoryStatus)     memoryStatus.className = `memory-status ${type}`;
    if (memoryStatusText) memoryStatusText.textContent = text;
}

// ── Response panel (pin / unpin / close) ───────────────────────────────────

let responseAreaPinned = false;
let unpinTimeout       = null;

function handleResponseAreaClick(event) {
    event.stopPropagation();
    const responseArea = document.getElementById('responseArea');
    if (!responseAreaPinned) {
        responseAreaPinned = true;
        responseArea.classList.add('pinned');
        if (unpinTimeout) clearTimeout(unpinTimeout);
        unpinTimeout = setTimeout(unpinResponseArea, 5000);
    }
}

function unpinResponseArea() {
    const responseArea = document.getElementById('responseArea');
    responseAreaPinned = false;
    responseArea.classList.remove('pinned');
    if (unpinTimeout) { clearTimeout(unpinTimeout); unpinTimeout = null; }
}

function closePanel() {
    const responseArea = document.getElementById('responseArea');
    responseAreaPinned = false;
    responseArea.classList.remove('pinned');
}

function pinResponseArea() {
    const responseArea = document.getElementById('responseArea');
    responseAreaPinned = true;
    responseArea.classList.add('pinned');
}

// ── Clear conversation ─────────────────────────────────────────────────────

function clearConversation() {
    window.conversationMessages = [];
    window.conversationId       = null;
    updateConversationDisplay();
    updateStatus('Conversation cleared. Ready for new commands!', 'info');
}

// ── Profile dropdown ───────────────────────────────────────────────────────

function toggleProfileDropdown() {
    const dropdown = document.getElementById('profileDropdown');
    if (!dropdown) return;
    dropdown.classList.toggle('visible');
}

// ── Sidebar footer ─────────────────────────────────────────────────────────

function updateSidebarFooter(connected, text) {
    const dot  = document.getElementById('sidebarStatusDot');
    const label = document.getElementById('sidebarStatusText');
    if (dot) {
        dot.style.background = connected ? '#22c55e' : '#ef4444';
        dot.style.boxShadow  = connected
            ? '0 0 6px rgba(34,197,94,0.6)'
            : '0 0 6px rgba(239,68,68,0.6)';
    }
    if (label) label.textContent = text || (connected ? 'Connected' : 'Disconnected');
}

// ── Utility ────────────────────────────────────────────────────────────────

function esc(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
