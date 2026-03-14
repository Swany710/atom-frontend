/**
 * voice.js — OpenAI Realtime API voice interface for Atom.
 *
 * Architecture:
 *   1. POST /ai/realtime-token  → backend vends ephemeral OpenAI client secret
 *   2. WebSocket to wss://api.openai.com/v1/realtime with that token
 *   3. Browser mic → PCM16 chunks → WebSocket → OpenAI (server VAD detects turns)
 *   4. OpenAI audio delta events → Web Audio API → speaker
 *   5. Interruptions: any new mic input during playback sends session.update
 *      to cancel the current response immediately
 *
 * Falls back to legacy REST pipeline if WebSocket fails.
 */

// ── State ─────────────────────────────────────────────────────────────────────
let realtimeWs        = null;   // WebSocket to OpenAI Realtime
let micStream         = null;   // MediaStream from getUserMedia
let micProcessor      = null;   // ScriptProcessorNode capturing PCM
let audioCtx          = null;   // Single shared AudioContext
let playbackNode      = null;   // AudioBufferSourceNode for TTS playback
let isRealtimeActive  = false;  // true while WS session is open
let isRecording       = false;  // true while mic is live
let isSpeakingWave    = false;  // true while Atom is speaking
let isProcessingWave  = false;  // true while waiting for response
let voiceResponseOn   = true;
let currentAudio      = null;   // legacy Audio element (fallback)
let pendingAudioChunks = [];    // realtime audio delta buffers
let isPlayingRealtime  = false;
let realtimeSessionId  = null;
let responseBuffer     = '';    // accumulates transcript deltas

// ── Legacy recording state (fallback) ────────────────────────────────────────
let mediaRecorder    = null;
let audioChunks      = [];
let recordedMimeType = 'audio/webm';

// ── Waveform ──────────────────────────────────────────────────────────────────
let waveCanvas, waveCtx, waveW, waveH;
let analyser, audioDataArray;
let wavePhase  = 0;
let waveEnergy = 0;
let waveformAnimationId = null;

const WAVE_COLORS = [
    { pos: 0,    r: 0,   g: 212, b: 220 },
    { pos: 0.25, r: 60,  g: 100, b: 255 },
    { pos: 0.55, r: 130, g: 60,  b: 240 },
    { pos: 0.78, r: 190, g: 50,  b: 210 },
    { pos: 1,    r: 230, g: 50,  b: 130 },
];

function initializeWaveform() {
    waveCanvas = document.getElementById('waveCanvas');
    if (!waveCanvas) return;
    waveCtx = waveCanvas.getContext('2d');
    resizeWaveCanvas();
    window.addEventListener('resize', resizeWaveCanvas);
    startWaveformAnimation();
}

function resizeWaveCanvas() {
    if (!waveCanvas) return;
    const dpr  = window.devicePixelRatio || 1;
    const rect = waveCanvas.getBoundingClientRect();
    waveCanvas.width  = rect.width  * dpr;
    waveCanvas.height = rect.height * dpr;
    waveCtx.scale(dpr, dpr);
    waveW = rect.width;
    waveH = rect.height;
}

function getAudioEnergy() {
    if (!analyser || !audioDataArray) return 0;
    analyser.getByteFrequencyData(audioDataArray);
    const sum = audioDataArray.reduce((a, b) => a + b, 0);
    return (sum / audioDataArray.length) / 255;
}

function drawWave() {
    if (!waveCtx || !waveW || !waveH) return;
    waveCtx.clearRect(0, 0, waveW, waveH);
    const cy = waveH / 2;

    let targetEnergy;
    if (isRecording)        targetEnergy = 0.38 + getAudioEnergy() * 0.62;
    else if (isSpeakingWave)  targetEnergy = 0.45 + getAudioEnergy() * 0.55;
    else if (isProcessingWave) targetEnergy = 0.54;
    else                    targetEnergy = 0.22;

    waveEnergy += (targetEnergy - waveEnergy) * 0.04;
    waveEnergy  = Math.max(0.01, Math.min(1, waveEnergy));
    wavePhase  += isRecording ? 0.052 : isSpeakingWave ? 0.042 : isProcessingWave ? 0.03 : 0.012;

    const N = 256, maxAmp = cy * 0.90 * waveEnergy;
    const ampArr = new Float32Array(N + 1);
    for (let i = 0; i <= N; i++) {
        const t = i / N, env = Math.pow(Math.sin(t * Math.PI), 0.55);
        ampArr[i] = (
              Math.sin(t * Math.PI * 2.15 + wavePhase) * 0.40
            + Math.sin(t * Math.PI * 3.60 + wavePhase * 1.18 + 0.9) * 0.26
            + Math.sin(t * Math.PI * 5.40 + wavePhase * 0.73 + 1.8) * 0.16
            + Math.sin(t * Math.PI * 1.55 + wavePhase * 0.41 + 3.1) * 0.18
        ) * maxAmp * env;
    }

    const upper = [], lower = [];
    for (let i = 0; i <= N; i++) {
        const x = (i / N) * waveW;
        upper.push({ x, y: cy + ampArr[i] });
        lower.push({ x, y: cy - ampArr[i] });
    }

    [{ scale: 1.30, alpha: 0.13 }, { scale: 1.14, alpha: 0.28 }, { scale: 1.00, alpha: 0.92 }]
    .forEach(({ scale, alpha }) => {
        const u = upper.map(p => ({ x: p.x, y: cy + (p.y - cy) * scale }));
        const l = lower.map(p => ({ x: p.x, y: cy + (p.y - cy) * scale }));
        const grad = waveCtx.createLinearGradient(0, 0, waveW, 0);
        grad.addColorStop(0,    `rgba(0,212,220,${alpha})`);
        grad.addColorStop(0.25, `rgba(50,90,245,${alpha})`);
        grad.addColorStop(0.55, `rgba(160,60,235,${alpha})`);
        grad.addColorStop(0.80, `rgba(195,45,205,${alpha})`);
        grad.addColorStop(1,    `rgba(232,48,128,${alpha})`);
        waveCtx.beginPath();
        waveCtx.moveTo(u[0].x, u[0].y);
        for (let i = 1; i < u.length - 1; i++) {
            const mx = (u[i].x + u[i+1].x)/2, my = (u[i].y + u[i+1].y)/2;
            waveCtx.quadraticCurveTo(u[i].x, u[i].y, mx, my);
        }
        waveCtx.lineTo(u[u.length-1].x, u[u.length-1].y);
        for (let i = l.length-1; i > 0; i--) {
            const mx = (l[i].x + l[i-1].x)/2, my = (l[i].y + l[i-1].y)/2;
            waveCtx.quadraticCurveTo(l[i].x, l[i].y, mx, my);
        }
        waveCtx.lineTo(l[0].x, l[0].y);
        waveCtx.closePath();
        waveCtx.fillStyle = grad;
        waveCtx.fill();
    });
}

function startWaveformAnimation() {
    function loop() { drawWave(); waveformAnimationId = requestAnimationFrame(loop); }
    loop();
}

// ── Audio context ─────────────────────────────────────────────────────────────

function getAudioCtx() {
    if (!audioCtx || audioCtx.state === 'closed') {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.8;
        audioDataArray = new Uint8Array(analyser.frequencyBinCount);
        analyser.connect(audioCtx.destination);
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
}

// ── PCM helpers ───────────────────────────────────────────────────────────────

/** Float32 → Int16 PCM, base64 encoded — what OpenAI Realtime expects */
function float32ToBase64Pcm16(float32Array) {
    const buf = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
        const s = Math.max(-1, Math.min(1, float32Array[i]));
        buf[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    const bytes = new Uint8Array(buf.buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

/** base64 PCM16 → Float32Array → AudioBuffer for Web Audio playback */
function base64Pcm16ToFloat32(b64) {
    const binary = atob(b64);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const int16  = new Int16Array(bytes.buffer);
    const float  = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float[i] = int16[i] / 32768;
    return float;
}

// ── Realtime audio playback queue ─────────────────────────────────────────────

let playbackQueue      = [];   // Float32Array chunks queued for playback
let playbackScheduled  = 0;    // next start time in AudioContext clock
let playbackStarted    = false;

function scheduleAudioChunk(float32) {
    const ctx = getAudioCtx();
    if (!playbackStarted || playbackScheduled < ctx.currentTime) {
        playbackScheduled = ctx.currentTime + 0.05; // 50ms initial buffer
        playbackStarted   = true;
    }
    const buf = ctx.createBuffer(1, float32.length, 24000);
    buf.copyToChannel(float32, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(analyser);
    src.start(playbackScheduled);
    playbackScheduled += buf.duration;
    isSpeakingWave = true;
    src.onended = () => {
        // If nothing else scheduled, mark as done
        if (playbackScheduled <= ctx.currentTime + 0.05) {
            isSpeakingWave = false;
        }
    };
}

function stopAllPlayback() {
    isSpeakingWave    = false;
    playbackStarted   = false;
    playbackScheduled = 0;
    if (currentAudio) { try { currentAudio.pause(); } catch(e){} currentAudio = null; }
    // Stop any in-flight Web Audio nodes by suspending + resuming
    if (audioCtx && audioCtx.state === 'running') {
        // Don't close — just drain the queue
        playbackScheduled = 0;
        playbackStarted   = false;
    }
}

// ── Realtime WebSocket session ────────────────────────────────────────────────

async function startRealtimeSession() {
    try {
        updateStatus('Connecting to Atom...', 'processing');

        // 1. Get ephemeral token from our backend
        const token = await AtomAPI.post('/ai/realtime-token', {}, { timeoutMs: 10_000 });
        if (!token?.clientSecret) throw new Error('No client secret returned');

        // 2. Open WebSocket to OpenAI Realtime
        const ws = new WebSocket(
            'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17',
            ['realtime', `openai-insecure-api-key.${token.clientSecret}`, 'openai-beta.realtime-v1']
        );

        realtimeWs = ws;
        realtimeSessionId = token.sessionId;

        ws.onopen = () => {
            console.log('✅ Realtime WS connected');
            isRealtimeActive = true;
            startMicCapture();
        };

        ws.onmessage = (event) => handleRealtimeEvent(JSON.parse(event.data));

        ws.onerror = (err) => {
            console.error('Realtime WS error:', err);
            updateStatus('Voice connection error — retrying...', 'error');
            cleanupRealtime();
        };

        ws.onclose = (evt) => {
            console.log('Realtime WS closed:', evt.code, evt.reason);
            isRealtimeActive = false;
            isRecording      = false;
            updateRecordingUI(false);
            if (evt.code !== 1000) {
                updateStatus('Voice disconnected. Click mic to reconnect.', 'info');
            }
        };

    } catch (err) {
        console.error('Failed to start realtime session:', err);
        updateStatus('Realtime unavailable — using standard voice', 'info');
        // Fall back to legacy pipeline
    }
}

function handleRealtimeEvent(evt) {
    switch (evt.type) {

        // Session is ready — update UI
        case 'session.created':
        case 'session.updated':
            updateStatus('🎤 Listening… Speak now!', 'listening');
            updateRecordingUI(true);
            break;

        // User speech detected — interrupt any current playback
        case 'input_audio_buffer.speech_started':
            if (isSpeakingWave) {
                stopAllPlayback();
                // Tell OpenAI to cancel its current response
                if (realtimeWs?.readyState === WebSocket.OPEN) {
                    realtimeWs.send(JSON.stringify({ type: 'response.cancel' }));
                }
            }
            isProcessingWave = false;
            updateStatus('🎤 Listening…', 'listening');
            break;

        case 'input_audio_buffer.speech_stopped':
            isProcessingWave = true;
            updateStatus('Processing…', 'processing');
            break;

        // Transcription of what user said
        case 'conversation.item.input_audio_transcription.completed':
            if (evt.transcript?.trim()) {
                addMessageToConversation('user', evt.transcript.trim());
                pinResponseArea();
            }
            break;

        // Atom is speaking — stream audio chunks
        case 'response.audio.delta':
            if (voiceResponseOn && evt.delta) {
                const float32 = base64Pcm16ToFloat32(evt.delta);
                scheduleAudioChunk(float32);
            }
            break;

        // Accumulate text transcript of Atom's response
        case 'response.audio_transcript.delta':
            responseBuffer += evt.delta || '';
            break;

        // Response complete — persist the full transcript
        case 'response.audio_transcript.done':
        case 'response.done': {
            const transcript = (evt.response?.output?.[0]?.content?.[0]?.transcript)
                ?? responseBuffer;
            if (transcript?.trim()) {
                addMessageToConversation('assistant', transcript.trim());
                pinResponseArea();
                // Save to backend conversation memory via text endpoint (keeps history in sync)
                syncTranscriptToBackend(transcript.trim());
            }
            responseBuffer   = '';
            isProcessingWave = false;
            updateStatus('🎤 Listening… Speak now!', 'listening');
            break;
        }

        // Error from OpenAI
        case 'error':
            console.error('Realtime error:', evt.error);
            updateStatus(`Voice error: ${evt.error?.message ?? 'unknown'}`, 'error');
            // If session expired, reconnect
            if (evt.error?.code === 'session_expired') {
                cleanupRealtime();
                setTimeout(startRealtimeSession, 500);
            }
            break;
    }
}

/** POST the assistant transcript back to backend so conversation history stays in sync */
async function syncTranscriptToBackend(text) {
    try {
        const result = await AtomAPI.post('/ai/text', {
            message: `[Voice transcript — Atom said]: ${text}`,
            conversationId: window.conversationId,
            _syncOnly: true,
        }, { timeoutMs: 10_000 });
        if (result?.conversationId) window.conversationId = result.conversationId;
    } catch (e) {
        // Non-fatal — history sync failure shouldn't affect the user
        console.warn('History sync failed:', e.message);
    }
}

// ── Mic capture (ScriptProcessorNode → PCM16 → WebSocket) ────────────────────

async function startMicCapture() {
    try {
        micStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 24000, channelCount: 1 }
        });

        const ctx = getAudioCtx();
        const source = ctx.createMediaStreamSource(micStream);

        // ScriptProcessorNode gives us raw PCM frames
        micProcessor = ctx.createScriptProcessor(4096, 1, 1);
        micProcessor.onaudioprocess = (e) => {
            if (!isRealtimeActive || realtimeWs?.readyState !== WebSocket.OPEN) return;
            const float32 = e.inputBuffer.getChannelData(0);
            const b64 = float32ToBase64Pcm16(float32);
            realtimeWs.send(JSON.stringify({
                type: 'input_audio_buffer.append',
                audio: b64,
            }));
        };

        source.connect(micProcessor);
        micProcessor.connect(ctx.destination);

        // Also wire into analyser for waveform
        source.connect(analyser);

        isRecording = true;
        updateRecordingUI(true);
    } catch (err) {
        console.error('Mic error:', err);
        updateStatus('Microphone access denied.', 'error');
        cleanupRealtime();
    }
}

function stopMicCapture() {
    if (micProcessor) { try { micProcessor.disconnect(); } catch(e){} micProcessor = null; }
    if (micStream)    { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    isRecording = false;
    updateRecordingUI(false);
}

function cleanupRealtime() {
    stopMicCapture();
    stopAllPlayback();
    if (realtimeWs) {
        try { realtimeWs.close(1000, 'cleanup'); } catch(e){}
        realtimeWs = null;
    }
    isRealtimeActive  = false;
    isProcessingWave  = false;
    isSpeakingWave    = false;
}

// ── Main toggle ───────────────────────────────────────────────────────────────

async function toggleRecording() {
    if (isRealtimeActive) {
        // End the realtime session
        cleanupRealtime();
        updateStatus('Voice session ended.', 'info');
        updateRecordingUI(false);
    } else {
        // Start realtime session (falls back to legacy if WS fails)
        await startRealtimeSession();
    }
}

// ── Error recovery — clear broken conversation session ────────────────────────

async function clearBrokenSession() {
    if (!window.conversationId) return;
    try {
        await AtomAPI.del(`/ai/conversations/${window.conversationId}`, { timeoutMs: 5_000 });
        console.log('🧹 Cleared broken conversation session:', window.conversationId);
    } catch(e) {
        console.warn('Could not clear session:', e.message);
    } finally {
        window.conversationId = null;
    }
}

// ── Legacy REST fallback (used if Realtime WS is unavailable) ─────────────────

function updateRecordingUI(recording) {
    const voiceButton = document.getElementById('voiceButton');
    if (!voiceButton) return;
    voiceButton.classList.toggle('recording', recording);
    voiceButton.title = recording ? 'Click to stop' : 'Click to speak';
}

function emergencyResetRecording() {
    console.log('🚨 Emergency reset');
    cleanupRealtime();
    if (mediaRecorder) {
        try { if (mediaRecorder.state === 'recording') mediaRecorder.stop(); } catch(e){}
        if (mediaRecorder.stream) mediaRecorder.stream.getTracks().forEach(t => t.stop());
    }
    mediaRecorder = null; audioChunks = [];
    updateRecordingUI(false);
    updateStatus('Reset complete — ready.', 'info');
}

function stopRecording() {
    try {
        if (mediaRecorder?.state === 'recording') mediaRecorder.stop();
        if (mediaRecorder?.stream) mediaRecorder.stream.getTracks().forEach(t => t.stop());
        isRecording = false;
        updateRecordingUI(false);
        isProcessingWave = true;
        updateStatus('Processing…', 'processing');
    } catch(e) { emergencyResetRecording(); }
}

async function startRecording() {
    try {
        stopAllPlayback();
        audioChunks = [];
        let mimeType = 'audio/webm';
        if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'audio/mp4';
        if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = '';
        recordedMimeType = mimeType || 'audio/webm';
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
        mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
        mediaRecorder.onstop  = () => processLegacyAudio();
        mediaRecorder.onerror = () => emergencyResetRecording();
        mediaRecorder.start();
        isRecording = true;
        updateRecordingUI(true);
        updateStatus('🎤 Listening… (Click to stop)', 'listening');
    } catch(e) {
        updateStatus('Microphone error: ' + e.message, 'error');
    }
}

async function processLegacyAudio() {
    isProcessingWave = true;
    try {
        if (!audioChunks.length) throw new Error('No audio recorded');
        const blob = new Blob(audioChunks, { type: recordedMimeType });
        if (blob.size < 1000) throw new Error('Audio too short');

        const formData = new FormData();
        const ext = recordedMimeType.includes('mp4') ? '.mp4' : '.webm';
        formData.append('audio', blob, 'audio' + ext);
        if (window.conversationId) formData.append('conversationId', window.conversationId);

        const result = await AtomAPI.postForm('/ai/voice', formData, { timeoutMs: 60_000 });
        if (result.conversationId) window.conversationId = result.conversationId;
        addMessageToConversation('user',      `"${result.transcription}"`);
        addMessageToConversation('assistant', result.message);
        pinResponseArea();
        playResponseAudio(result.message);
        updateStatus('Ready.', 'success');
    } catch(err) {
        isProcessingWave = false;
        console.error('Voice error:', err);

        // Auto-clear broken session on 400
        if (err.status === 400 || (err.message && err.message.includes('tool_use_id'))) {
            console.warn('🧹 Detected broken session — auto-clearing history');
            await clearBrokenSession();
            updateStatus('Session reset — please try again.', 'info');
        } else {
            updateStatus('Voice error: ' + err.message, 'error');
        }
        addMessageToConversation('assistant', `Sorry, I had a voice error: ${err.message}`);
        pinResponseArea();
    } finally {
        isProcessingWave = false;
    }
}

// ── TTS playback (legacy / text responses) ────────────────────────────────────

async function playResponseAudio(text) {
    if (!voiceResponseOn || !text?.trim()) return;
    stopAllPlayback();
    try {
        const resp = await AtomAPI.postRaw('/ai/speak', { text }, { timeoutMs: 30_000 });
        if (!resp.ok) return;
        const blob = await resp.blob();
        const url  = URL.createObjectURL(blob);
        currentAudio = new Audio(url);
        const ctx = getAudioCtx();
        const src = ctx.createMediaElementSource(currentAudio);
        src.connect(analyser);
        isSpeakingWave = true;
        currentAudio.onended = () => { isSpeakingWave = false; URL.revokeObjectURL(url); };
        await currentAudio.play();
    } catch(e) { isSpeakingWave = false; }
}

function stopAudioPlayback() { stopAllPlayback(); }

function toggleVoiceResponse() {
    voiceResponseOn = !voiceResponseOn;
    const btn = document.getElementById('muteBtn');
    if (btn) {
        btn.textContent       = voiceResponseOn ? '🔊' : '🔇';
        btn.title             = voiceResponseOn ? 'Mute Atom voice' : 'Unmute Atom voice';
        btn.style.color       = voiceResponseOn ? '#00d4dc' : '#666';
        btn.style.borderColor = voiceResponseOn ? 'rgba(0,212,220,0.35)' : 'rgba(255,255,255,0.15)';
    }
    if (!voiceResponseOn) stopAllPlayback();
}

// ── Legacy stubs ──────────────────────────────────────────────────────────────
function initializeWaveformLegacy() {}
function createSmoothPath() { return ''; }
function connectAudioAnalyser() {}
function disconnectAudioAnalyser() {}
