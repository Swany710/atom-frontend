/**
 * voice.js — Microphone recording, canvas waveform, TTS playback.
 * Depends on: api.js (AtomAPI), chat.js (conversationId, addMessageToConversation, updateStatus, pinResponseArea)
 */

// ── Recording state ───────────────────────────────────────────────────────
let isRecording  = false;
let mediaRecorder = null;
let audioChunks   = [];

// ── Waveform / audio analysis ─────────────────────────────────────────────
let waveCanvas, waveCtx, waveW, waveH;
let audioCtx, analyser, audioSource, audioDataArray;
let wavePhase = 0;
let waveEnergy = 0;
let waveformAnimationId = null;
let isProcessingWave = false;
let isSpeakingWave   = false;
let currentAudio     = null;
let voiceResponseOn  = true;

const WAVE_COLORS = [
    { pos: 0,    r: 0,   g: 212, b: 220 },
    { pos: 0.25, r: 60,  g: 100, b: 255 },
    { pos: 0.55, r: 130, g: 60,  b: 240 },
    { pos: 0.78, r: 190, g: 50,  b: 210 },
    { pos: 1,    r: 230, g: 50,  b: 130 },
];

function interpolateColor(t) {
    for (let i = 0; i < WAVE_COLORS.length - 1; i++) {
        const c0 = WAVE_COLORS[i], c1 = WAVE_COLORS[i + 1];
        if (t >= c0.pos && t <= c1.pos) {
            const f = (t - c0.pos) / (c1.pos - c0.pos);
            return {
                r: Math.round(c0.r + (c1.r - c0.r) * f),
                g: Math.round(c0.g + (c1.g - c0.g) * f),
                b: Math.round(c0.b + (c1.b - c0.b) * f),
            };
        }
    }
    return WAVE_COLORS[WAVE_COLORS.length - 1];
}

// ── Waveform init ─────────────────────────────────────────────────────────

function initializeWaveform() {
    waveCanvas = document.getElementById('waveCanvas');
    if (!waveCanvas) return;
    waveCtx = waveCanvas.getContext('2d');
    resizeWaveCanvas();
    window.addEventListener('resize', resizeWaveCanvas);
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

function connectAudioAnalyser(stream) {
    try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.8;
        audioDataArray = new Uint8Array(analyser.frequencyBinCount);
        audioSource = audioCtx.createMediaStreamSource(stream);
        audioSource.connect(analyser);
    } catch (e) { console.warn('Audio analyser error:', e); }
}

function disconnectAudioAnalyser() {
    try { if (audioSource) { audioSource.disconnect(); audioSource = null; } } catch (e) {}
}

function getAudioEnergy() {
    if (!analyser || !audioDataArray) return 0;
    analyser.getByteFrequencyData(audioDataArray);
    const sum = audioDataArray.reduce((a, b) => a + b, 0);
    return (sum / audioDataArray.length) / 255;
}

// ── Wave draw loop ────────────────────────────────────────────────────────

function drawWave() {
    if (!waveCtx || !waveW || !waveH) return;
    waveCtx.clearRect(0, 0, waveW, waveH);
    const cy = waveH / 2;

    let targetEnergy;
    if (isRecording) {
        targetEnergy = 0.38 + getAudioEnergy() * 0.62;
    } else if (isSpeakingWave) {
        targetEnergy = 0.45 + getAudioEnergy() * 0.50;
    } else if (isProcessingWave) {
        targetEnergy = 0.54;
    } else {
        targetEnergy = 0.38;
    }
    waveEnergy += (targetEnergy - waveEnergy) * 0.04;
    waveEnergy  = Math.max(0.01, Math.min(1, waveEnergy));
    wavePhase  += isRecording ? 0.052 : isSpeakingWave ? 0.042 : isProcessingWave ? 0.03 : 0.012;

    const N      = 256;
    const maxAmp = cy * 0.90 * waveEnergy;
    const ampArr = new Float32Array(N + 1);
    for (let i = 0; i <= N; i++) {
        const t   = i / N;
        const env = Math.pow(Math.sin(t * Math.PI), 0.55);
        ampArr[i] = (
              Math.sin(t * Math.PI * 2.15 + wavePhase)                  * 0.40
            + Math.sin(t * Math.PI * 3.60 + wavePhase * 1.18 + 0.9)    * 0.26
            + Math.sin(t * Math.PI * 5.40 + wavePhase * 0.73 + 1.8)    * 0.16
            + Math.sin(t * Math.PI * 1.55 + wavePhase * 0.41 + 3.1)    * 0.18
        ) * maxAmp * env;
    }

    const upper = [], lower = [];
    for (let i = 0; i <= N; i++) {
        const x = (i / N) * waveW;
        upper.push({ x, y: cy + ampArr[i] });
        lower.push({ x, y: cy - ampArr[i] });
    }

    const layerDefs = [
        { scale: 1.30, alpha: 0.13 },
        { scale: 1.14, alpha: 0.28 },
        { scale: 1.00, alpha: 0.92 },
    ];

    layerDefs.forEach(({ scale, alpha }) => {
        const u    = upper.map(p => ({ x: p.x, y: cy + (p.y - cy) * scale }));
        const l    = lower.map(p => ({ x: p.x, y: cy + (p.y - cy) * scale }));
        const grad = waveCtx.createLinearGradient(0, 0, waveW, 0);
        grad.addColorStop(0,    `rgba(0,212,220,${alpha})`);
        grad.addColorStop(0.25, `rgba(50,90,245,${alpha})`);
        grad.addColorStop(0.55, `rgba(160,60,235,${alpha})`);
        grad.addColorStop(0.80, `rgba(195,45,205,${alpha})`);
        grad.addColorStop(1,    `rgba(232,48,128,${alpha})`);

        waveCtx.beginPath();
        waveCtx.moveTo(u[0].x, u[0].y);
        for (let i = 1; i < u.length - 1; i++) {
            const mx = (u[i].x + u[i + 1].x) / 2;
            const my = (u[i].y + u[i + 1].y) / 2;
            waveCtx.quadraticCurveTo(u[i].x, u[i].y, mx, my);
        }
        waveCtx.lineTo(u[u.length - 1].x, u[u.length - 1].y);
        for (let i = l.length - 1; i > 0; i--) {
            const mx = (l[i].x + l[i - 1].x) / 2;
            const my = (l[i].y + l[i - 1].y) / 2;
            waveCtx.quadraticCurveTo(l[i].x, l[i].y, mx, my);
        }
        waveCtx.lineTo(l[0].x, l[0].y);
        waveCtx.closePath();
        waveCtx.fillStyle = grad;
        waveCtx.globalAlpha = 1;
        waveCtx.fill();
    });
    waveCtx.globalAlpha = 1;
}

function startWaveformAnimation() {
    function loop() { drawWave(); waveformAnimationId = requestAnimationFrame(loop); }
    loop();
}

// Legacy stubs
function initializeWaveformLegacy() {}
function createSmoothPath() { return ''; }

// ── Recording ─────────────────────────────────────────────────────────────

function updateRecordingUI(recording) {
    const voiceButton = document.getElementById('voiceButton');
    if (!voiceButton) return;
    if (recording) {
        voiceButton.classList.add('recording');
        voiceButton.title = 'Click to stop recording';
    } else {
        voiceButton.classList.remove('recording');
        voiceButton.title = 'Click to start recording';
    }
}

function emergencyResetRecording() {
    console.log('🚨 Emergency recording reset...');
    if (mediaRecorder) {
        try { if (mediaRecorder.state === 'recording') mediaRecorder.stop(); } catch (e) {}
        if (mediaRecorder.stream) mediaRecorder.stream.getTracks().forEach(t => t.stop());
    }
    isRecording   = false;
    mediaRecorder = null;
    audioChunks   = [];
    updateRecordingUI(false);
    updateStatus('Recording reset. Ready for new commands!', 'info');
    const vb = document.getElementById('voiceButton');
    if (vb) vb.classList.remove('recording');
}

async function toggleRecording() {
    if (!isRecording) { await startRecording(); } else { stopRecording(); }
}

function stopRecording() {
    try {
        if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
        if (mediaRecorder?.stream) mediaRecorder.stream.getTracks().forEach(t => t.stop());
        isRecording = false;
        updateRecordingUI(false);
        updateStatus('Processing your voice command...', 'processing');
    } catch (error) {
        console.error('Error stopping recording:', error);
        emergencyResetRecording();
    }
}

async function startRecording() {
    try {
        stopAudioPlayback();
        if (isRecording) { stopRecording(); await new Promise(r => setTimeout(r, 100)); }

        updateStatus('Requesting microphone access...', 'processing');
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 44100, channelCount: 1 }
        });

        audioChunks = [];
        let mimeType = 'audio/mp3';
        if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'audio/webm';
        if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'audio/wav';
        if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = '';

        const options  = mimeType ? { mimeType } : {};
        mediaRecorder  = new MediaRecorder(stream, options);

        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) audioChunks.push(event.data);
        };
        mediaRecorder.onstop  = () => processAudioRecording();
        mediaRecorder.onerror = () => emergencyResetRecording();

        mediaRecorder.start();
        isRecording = true;
        updateRecordingUI(true);
        updateStatus('🎤 Listening… Speak now! (Click to stop)', 'listening');
        connectAudioAnalyser(stream);
    } catch (error) {
        console.error('Error starting recording:', error);
        updateStatus('Microphone access denied or error occurred.', 'error');
        emergencyResetRecording();
    }
}

// ── Audio processing ───────────────────────────────────────────────────────

async function processAudioRecording() {
    try {
        if (audioChunks.length === 0) throw new Error('No audio data recorded');
        const audioBlob = new Blob(audioChunks, { type: 'audio/mp3' });
        if (audioBlob.size < 1000) throw new Error('Speak at least 1 second');

        disconnectAudioAnalyser();
        isProcessingWave = true;
        updateStatus('Transcribing and processing...', 'processing');

        const formData = new FormData();
        formData.append('audio', audioBlob, 'audio.mp3');
        if (window.conversationId) formData.append('conversationId', window.conversationId);

        const result = await AtomAPI.postForm('/ai/voice-command', formData, { timeoutMs: 60_000 });

        if (result.conversationId) window.conversationId = result.conversationId;
        addMessageToConversation('user', `"${result.transcription}"`);
        addMessageToConversation('assistant', result.message);
        isProcessingWave = false;
        updateStatus('Voice command processed successfully!', 'success');
        pinResponseArea();
        playResponseAudio(result.message);
    } catch (error) {
        isProcessingWave = false;
        console.error('Error processing voice:', error);
        updateStatus('Voice processing failed: ' + error.message, 'error');
        addMessageToConversation('assistant', `Sorry, I had trouble with your voice command: ${error.message}`);
        pinResponseArea();
    }
}

// ── TTS playback ───────────────────────────────────────────────────────────

async function playResponseAudio(text) {
    if (!voiceResponseOn || !text?.trim()) return;
    stopAudioPlayback();

    try {
        // Use raw fetch to get audio blob; AtomAPI.postRaw returns the Response
        const resp = await AtomAPI.postRaw('/ai/speak', { text }, { timeoutMs: 30_000 });
        if (!resp.ok) { console.warn('TTS failed:', resp.status); return; }

        const blob = await resp.blob();
        const url  = URL.createObjectURL(blob);
        currentAudio = new Audio(url);

        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (!analyser) {
            analyser = audioCtx.createAnalyser();
            analyser.fftSize = 256;
            analyser.smoothingTimeConstant = 0.8;
            audioDataArray = new Uint8Array(analyser.frequencyBinCount);
        }
        if (audioSource) { try { audioSource.disconnect(); } catch(e){} audioSource = null; }
        audioSource = audioCtx.createMediaElementSource(currentAudio);
        audioSource.connect(analyser);
        analyser.connect(audioCtx.destination);

        isSpeakingWave = true;
        updateStatus('🔊 Speaking...', 'processing');

        currentAudio.onended = () => {
            isSpeakingWave = false;
            stopAudioPlayback(false);
            updateStatus('Ready for voice or text commands...', '');
            URL.revokeObjectURL(url);
        };
        currentAudio.onerror = () => { isSpeakingWave = false; URL.revokeObjectURL(url); };
        await currentAudio.play();
    } catch (err) {
        console.warn('TTS playback error:', err);
        isSpeakingWave = false;
    }
}

function stopAudioPlayback(pause = true) {
    isSpeakingWave = false;
    if (currentAudio) { if (pause) { try { currentAudio.pause(); } catch(e){} } currentAudio = null; }
    if (audioSource)  { try { audioSource.disconnect(); } catch(e){} audioSource = null; }
    if (analyser && audioCtx) { try { analyser.disconnect(audioCtx.destination); } catch(e){} }
}

function toggleVoiceResponse() {
    voiceResponseOn = !voiceResponseOn;
    const btn = document.getElementById('muteBtn');
    if (btn) {
        btn.textContent      = voiceResponseOn ? '🔊' : '🔇';
        btn.title            = voiceResponseOn ? 'Mute Atom voice' : 'Unmute Atom voice';
        btn.style.color      = voiceResponseOn ? '#00d4dc' : '#666';
        btn.style.borderColor = voiceResponseOn ? 'rgba(0,212,220,0.35)' : 'rgba(255,255,255,0.15)';
    }
    if (!voiceResponseOn) stopAudioPlayback();
}
