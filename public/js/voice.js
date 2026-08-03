/**
 * voice.js — voice interface for Atom.
 *
 * Architecture (hands-free live voice):
 *   1. Mic opens once per session; a silent analyser tap watches the level.
 *   2. Energy-based VAD decides when you started and stopped talking.
 *   3. The recorded turn is POSTed to /ai/voice, which runs
 *        ElevenLabs Scribe (speech → text)
 *        → Claude with the full tool set (email, calendar, CRM, KB, notes…)
 *        → { transcription, message }
 *   4. The reply is spoken via /ai/speak (ElevenLabs TTS), then the mic reopens.
 *   5. Talking over Atom cuts him off (barge-in) and starts your next turn.
 *
 * Provider split — do not cross these lines:
 *   speech in/out   → ElevenLabs
 *   reasoning+tools → Anthropic (Claude)
 *   embeddings      → OpenAI
 *
 * Tap-to-talk (startRecording/stopRecording) remains as a manual fallback when
 * the hands-free session can't start.
 */

// ── State ─────────────────────────────────────────────────────────────────────
let micStream         = null;   // MediaStream from getUserMedia
let audioCtx          = null;   // Single shared AudioContext
let isRecording       = false;  // true while mic is live
let isSpeakingWave    = false;  // true while Atom is speaking
let isProcessingWave  = false;  // true while waiting for response
let voiceResponseOn   = true;   // master mute — false silences ALL audio output
let currentAudio      = null;   // Audio element used for spoken replies

// ── Read-back policy ──────────────────────────────────────────────────────────
//
// Atom does NOT speak typed responses by default. Audio only happens when:
//   1. the user is in LIVE voice mode (a spoken conversation — Atom answers aloud)
//   2. the user taps the 🔊 button on a specific message (readMessageAloud)
//   3. "Always read" is switched on (alwaysReadOn) — then every response is spoken
// The master mute (voiceResponseOn) still overrides all three.
let alwaysReadOn = false;
try {
    alwaysReadOn = localStorage.getItem('atom.alwaysRead') === '1';
} catch (e) { /* storage blocked — default off */ }

// ── Tap-to-talk recording state (manual fallback) ────────────────────────────
let mediaRecorder    = null;
let audioChunks      = [];
let recordedMimeType = 'audio/webm';

// ── Voice-to-Text state ───────────────────────────────────────────────────────
let vttRecognition = null;
let isVttActive    = false;
let vttFinalBuffer = '';   // accumulated finalized dictation text

// ── Waveform ──────────────────────────────────────────────────────────────────
let waveCanvas, waveCtx, waveW, waveH;
let analyser, audioDataArray;        // playback tap  → speakers
let micAnalyser, micDataArray;       // mic tap       → silent (VAD + waveform)
let wavePhase  = 0;
let waveEnergy = 0;
let waveformAnimationId = null;

// ── Fixed silhouette ──────────────────────────────────────────────────────────
// Lobe positions traced off the reference art, left → right. These NEVER move:
//   c     centre, 0..1 across the canvas
//   w     half-width (fatness)
//   h     resting height, 0..1
//   rate  how fast this lobe bounces (rad/sec)
//   phase offset so they don't all pump in unison
const WAVE_LOBES = [
    { c: 0.170, w: 0.060, h: 0.38, rate: 2.7, phase: 0.0 },
    { c: 0.325, w: 0.058, h: 0.68, rate: 3.4, phase: 1.7 },
    { c: 0.500, w: 0.075, h: 1.00, rate: 2.2, phase: 3.1 },
    { c: 0.685, w: 0.058, h: 0.60, rate: 3.9, phase: 0.8 },
    { c: 0.820, w: 0.048, h: 0.28, rate: 3.1, phase: 4.4 },
    // broad low body that ties the lobes together instead of leaving gaps
    { c: 0.500, w: 0.320, h: 0.12, rate: 1.4, phase: 2.3 },
];

/** How far the lobes bounce (fraction of resting height) at full energy. */
const WAVE_BOUNCE = 0.30;

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

/** Normalised 0..1 level from the MIC tap. Drives turn detection and barge-in. */
function getMicEnergy() {
    if (!micAnalyser || !micDataArray) return 0;
    micAnalyser.getByteFrequencyData(micDataArray);
    let sum = 0;
    for (let i = 0; i < micDataArray.length; i++) sum += micDataArray[i];
    return (sum / micDataArray.length) / 255;
}

/** Normalised 0..1 level from the PLAYBACK tap. */
function getPlaybackEnergy() {
    if (!analyser || !audioDataArray) return 0;
    analyser.getByteFrequencyData(audioDataArray);
    let sum = 0;
    for (let i = 0; i < audioDataArray.length; i++) sum += audioDataArray[i];
    return (sum / audioDataArray.length) / 255;
}

/**
 * Level for the waveform. Reads whichever tap is meaningful right now, so the
 * animation reacts to Atom's voice while speaking and to yours while listening.
 */
function getAudioEnergy() {
    if (isSpeakingWave) return getPlaybackEnergy();
    if (isRecording || isLiveVoiceActive) return getMicEnergy();
    return getPlaybackEnergy();
}

function drawWave() {
    if (!waveCtx || !waveW || !waveH) return;
    waveCtx.clearRect(0, 0, waveW, waveH);
    const cy = waveH / 2;

    // ── Motion states ────────────────────────────────────────────────────
    // speaking  — big, fast, driven by the actual audio
    // listening — alive but calm: a slow gentle roll, never frozen
    // thinking  — mid energy, steady pulse
    // idle      — barely breathing
    let targetEnergy, phaseStep, breathe = 0;
    if (isSpeakingWave) {
        targetEnergy = 0.55 + getAudioEnergy() * 0.45;
        phaseStep    = 0.020;   // lobes bounce briskly
    } else if (isRecording) {
        // Listening: a soft floor plus a slow breath so it never sits still,
        // nudged by mic level so the user sees it hearing them.
        breathe      = Math.sin(Date.now() / 900) * 0.04;
        targetEnergy = 0.30 + breathe + getAudioEnergy() * 0.26;
        phaseStep    = 0.006;   // slow, gentle
    } else if (isProcessingWave) {
        targetEnergy = 0.42 + Math.sin(Date.now() / 380) * 0.06;
        phaseStep    = 0.012;
    } else {
        breathe      = Math.sin(Date.now() / 1500) * 0.03;
        targetEnergy = 0.24 + breathe;
        phaseStep    = 0.003;   // barely moving
    }

    // Rise fast when Atom starts talking, settle slowly when it stops.
    const attack = targetEnergy > waveEnergy ? 0.16 : 0.05;
    waveEnergy += (targetEnergy - waveEnergy) * attack;
    waveEnergy  = Math.max(0.01, Math.min(1, waveEnergy));
    wavePhase  += phaseStep;

    // ── Shape ────────────────────────────────────────────────────────────
    // The silhouette is FIXED — lobes sit at set positions and only pulse in
    // place. (Putting the phase inside the spatial term is what made the old
    // wave crawl sideways; here time only scales each lobe's height.)
    // wavePhase is a clock that ticks FASTER when speaking and slower when
    // listening — so the same silhouette bounces hard or barely stirs.
    const clock = wavePhase;
    const bump  = WAVE_BOUNCE * waveEnergy;   // how hard the lobes bounce

    const N = 256, maxAmp = cy * 0.96 * waveEnergy;
    const ampArr = new Float32Array(N + 1);

    // Sides bounce outward/inward a little without the body sliding.
    const stretch = 1 + 0.045 * Math.sin(clock * 1.6) * waveEnergy;

    for (let i = 0; i <= N; i++) {
        const t = i / N;
        // map through the stretch around the centre so the TIPS move, not the body
        const ts = 0.5 + (t - 0.5) / stretch;
        let v = 0;
        for (let k = 0; k < WAVE_LOBES.length; k++) {
            const L = WAVE_LOBES[k];
            const d = (ts - L.c) / L.w;
            // each lobe bounces on its own clock → the group ripples without travelling
            const pulse = 1 + bump * Math.sin(clock * L.rate + L.phase);
            v += L.h * pulse * Math.exp(-d * d);
        }
        // needle tips: a sliver of amplitude that survives out to both edges
        const taper = Math.pow(Math.sin(Math.max(0, Math.min(1, ts)) * Math.PI), 0.85);
        ampArr[i] = (v * 0.92 + 0.05 * taper) * taper * maxAmp;
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
        // teal → indigo → violet → crimson, left to right
        const grad = waveCtx.createLinearGradient(0, 0, waveW, 0);
        grad.addColorStop(0,    `rgba(34,214,199,${alpha})`);
        grad.addColorStop(0.22, `rgba(38,190,205,${alpha})`);
        grad.addColorStop(0.45, `rgba(72,96,190,${alpha})`);
        grad.addColorStop(0.62, `rgba(112,66,168,${alpha})`);
        grad.addColorStop(0.82, `rgba(176,42,120,${alpha})`);
        grad.addColorStop(1,    `rgba(196,32,92,${alpha})`);
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
        // No sampleRate override — let the browser pick the device's native rate.
        //
        // This used to force 24 000 Hz, which the OpenAI Realtime mode needed
        // because it streamed raw PCM at that rate. That mode is gone (see the
        // LIVE VOICE header below); audio now leaves as an encoded blob and
        // comes back as MP3, so nothing downstream cares about the rate.
        //
        // Forcing it was actively harmful: mic hardware runs at 48 kHz, and
        // createMediaStreamSource() across a rate mismatch resamples on Chrome,
        // throws NotSupportedError on Firefox, and has shipped as silence on
        // some Safari builds — a dead VAD with a mic light that stays on.
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();

        // Playback analyser — drives the waveform while Atom speaks, and is the
        // node everything audible routes through on its way to the speakers.
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.8;
        audioDataArray = new Uint8Array(analyser.frequencyBinCount);
        analyser.connect(audioCtx.destination);

        // Mic analyser — deliberately NOT connected to destination.
        //
        // The mic used to be wired into the playback analyser, which routes to
        // the speakers: every word you said was played back at you through your
        // own output. Echo cancellation masked it, but it was live feedback and
        // it polluted turn detection. This is a separate, silent tap.
        micAnalyser = audioCtx.createAnalyser();
        micAnalyser.fftSize = 512;
        micAnalyser.smoothingTimeConstant = 0.6;
        micDataArray = new Uint8Array(micAnalyser.frequencyBinCount);
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
}

// ── Playback control ──────────────────────────────────────────────────────────

/** Restore the mic→waveform gain. Safe to call any time. */
function restoreMicGain() {
    if (window._micGain) window._micGain.gain.value = 1;
}

/**
 * Stop whatever Atom is saying, immediately.
 *
 * Drives barge-in (talking over Atom) and the mute button. Pausing the element
 * fires its `pause` handler, which is what releases the live-voice loop's wait
 * on playback — see playResponseAudio().
 */
function stopAllPlayback() {
    isSpeakingWave = false;
    if (currentAudio) { try { currentAudio.pause(); } catch(e){} currentAudio = null; }
    // Never leave the mic tap ducked, or the listening waveform goes flat for
    // the rest of the session.
    restoreMicGain();
}

// ═════════════════════════════════════════════════════════════════════════════
//  LIVE VOICE  —  ElevenLabs STT  →  Claude (tools)  →  ElevenLabs TTS
// ═════════════════════════════════════════════════════════════════════════════
//
// Replaces the old OpenAI Realtime WebSocket mode (kept but unreferenced at the
// bottom of this file). That mode answered with OpenAI directly, which meant it
// had NO access to Gmail, Calendar, AccuLynx, the knowledge base, notes, or
// scheduled tasks, bypassed the pending-action confirmation system, and carried
// none of the UPPA guardrail.
//
// Every spoken turn now goes through the same brain as typed chat:
//
//     mic ──► MediaRecorder ──► POST /ai/voice
//                                 │
//                                 ├─ ElevenLabs Scribe   (speech → text)
//                                 ├─ Claude + full tools (reason + act)
//                                 └─ returns { transcription, message }
//                                 │
//              POST /ai/speak ────┘  ElevenLabs TTS (text → speech) ──► speaker
//
// Turn-taking is handled locally with energy-based voice activity detection, so
// it stays hands-free: talk, pause, Atom answers, it listens again. Speaking
// over Atom cuts him off (barge-in).
//
// OpenAI is not in this path at all — it is used only for knowledge-base
// embeddings.

// -- Tuning ------------------------------------------------------------------
/** Mic level above which we consider you to be talking. */
const VAD_SPEECH_LEVEL   = 0.045;
/** Higher bar to interrupt Atom, so his own voice bleeding into the mic doesn't. */
const VAD_BARGE_LEVEL    = 0.11;
/** Silence after speech that ends your turn. */
const VAD_SILENCE_MS     = 1100;
/** Hard cap on a single turn, so a stuck mic can't record forever. */
const VAD_MAX_TURN_MS    = 30_000;
/** Give up waiting for speech after this long and idle the session. */
const VAD_NO_SPEECH_MS   = 45_000;
/** Ignore the first moments after Atom stops talking (room echo tail). */
const VAD_REARM_MS       = 250;
/** How often the VAD samples the mic. 50ms ≈ 20Hz — well under VAD_SILENCE_MS. */
const VAD_TICK_MS        = 50;

// -- State -------------------------------------------------------------------
let isLiveVoiceActive = false;  // a hands-free session is running
let liveRecorder      = null;   // MediaRecorder for the current turn
let liveChunks        = [];
let liveRecMime       = 'audio/webm';
let liveVadTimer      = null;   // setInterval handle for the VAD loop
let liveHeardSpeech   = false;
let liveSilenceSince  = 0;
let liveTurnStarted   = 0;
let liveListenSince   = 0;
let liveRearmAt       = 0;
let liveTurnBusy      = false;  // true while a turn is being sent/answered
let liveBargedIn      = false;  // you cut Atom off mid-reply

/** Pick a container MediaRecorder can actually produce on this browser. */
function pickRecorderMime() {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    for (const m of candidates) {
        if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
    }
    return '';
}

/** Open the mic once for the whole session and tap it into the silent analyser. */
async function openLiveMic() {
    micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl:  true,
            channelCount:     1,
        },
    });
    const ctx = getAudioCtx();
    const source = ctx.createMediaStreamSource(micStream);
    // Gain node kept so existing mute/duck helpers (restoreMicGain) still work.
    window._micGain = ctx.createGain();
    window._micGain.gain.value = 1;
    source.connect(window._micGain);
    // Silent tap — never reaches the speakers. runVadLoop() reads micAnalyser
    // for BOTH turn detection and barge-in, so this gain must stay at 1 for the
    // whole session. Muting it mutes the VAD, not the room.
    window._micGain.connect(micAnalyser);
}

async function startLiveVoice() {
    if (isLiveVoiceActive) return;
    try {
        updateStatus('Starting voice…', 'processing');
        await openLiveMic();
        liveRecMime = pickRecorderMime();

        isLiveVoiceActive = true;
        updateRecordingUI(true);

        beginListeningTurn();
        runVadLoop();
    } catch (err) {
        const detail = err && err.message ? err.message : String(err);
        console.error('[Atom] Could not start live voice:', err);
        isLiveVoiceActive = false;
        updateRecordingUI(false);
        // Hands-free couldn't start. Fall back to manual turn control rather
        // than leaving the user with a mic button that does nothing.
        await fallbackToTapToTalk(`Live voice unavailable (${detail})`);
    }
}

/** Start recording a fresh turn. Safe to call repeatedly. */
function beginListeningTurn() {
    if (!isLiveVoiceActive || liveTurnBusy) return;
    if (liveRecorder && liveRecorder.state === 'recording') return;
    if (!micStream) return;

    liveChunks       = [];
    liveHeardSpeech  = false;
    liveSilenceSince = 0;
    liveTurnStarted  = Date.now();
    liveListenSince  = Date.now();

    try {
        liveRecorder = new MediaRecorder(micStream, liveRecMime ? { mimeType: liveRecMime } : {});
    } catch (e) {
        console.error('[Atom] MediaRecorder failed:', e);
        stopLiveVoice();
        fallbackToTapToTalk('Hands-free recording unavailable in this browser');
        return;
    }

    liveRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) liveChunks.push(e.data); };
    liveRecorder.onstop  = () => sendLiveTurn();
    liveRecorder.onerror = () => { console.error('[Atom] recorder error'); stopLiveVoice(); };
    liveRecorder.start();

    isRecording = true;
    updateStatus('🎤 Listening… just start talking', 'listening');
}

/** Close the current turn and hand off to sendLiveTurn() via onstop. */
function endListeningTurn() {
    isRecording = false;
    if (liveRecorder && liveRecorder.state === 'recording') {
        liveTurnBusy = true;
        try { liveRecorder.stop(); } catch (e) { liveTurnBusy = false; }
    }
}

/**
 * The single VAD loop. State-aware so one timer drives listening, barge-in
 * detection, and re-arming after Atom finishes speaking.
 *
 * Driven by setInterval, NOT requestAnimationFrame. rAF is throttled to zero in
 * a hidden or backgrounded tab, and this loop is the only thing that ends a
 * turn — including VAD_MAX_TURN_MS, the safety valve meant to catch a stuck
 * mic. On rAF, switching tabs mid-sentence froze turn detection AND its own
 * backstop: the recorder kept running with nothing left to stop it. Timers keep
 * firing when hidden (clamped to ~1s, which is still well inside
 * VAD_SILENCE_MS), so a turn started in the foreground always closes.
 */
function runVadLoop() {
    stopVadLoop();

    function tick() {
        if (!isLiveVoiceActive) { stopVadLoop(); return; }
        const level = getMicEnergy();
        const now   = Date.now();

        if (isSpeakingWave) {
            // Atom is talking — listen only for an interruption.
            if (level > VAD_BARGE_LEVEL) {
                console.log('[Atom] barge-in detected');
                liveBargedIn = true;
                // Killing the audio element leaves no echo tail, so we can
                // reopen the mic immediately and catch the whole interruption.
                stopAllPlayback();
            }
            return;
        }

        if (liveTurnBusy || (liveRearmAt && now < liveRearmAt)) return;

        // Not recording but idle and free → open a new turn.
        if (!liveRecorder || liveRecorder.state !== 'recording') {
            beginListeningTurn();
            return;
        }

        if (level > VAD_SPEECH_LEVEL) {
            liveHeardSpeech  = true;
            liveSilenceSince = 0;
        } else if (liveHeardSpeech) {
            if (!liveSilenceSince) {
                liveSilenceSince = now;
            } else if (now - liveSilenceSince > VAD_SILENCE_MS) {
                endListeningTurn();               // you stopped talking → send
                return;
            }
        }

        if (liveHeardSpeech && now - liveTurnStarted > VAD_MAX_TURN_MS) {
            endListeningTurn();                   // safety valve
        } else if (!liveHeardSpeech && now - liveListenSince > VAD_NO_SPEECH_MS) {
            updateStatus('Still here — tap the mic when you want to talk.', 'info');
            stopLiveVoice();
        }
    }

    liveVadTimer = setInterval(tick, VAD_TICK_MS);
    tick();   // don't wait a full tick for the first sample
}

/** Tear down the VAD timer. Safe to call when it isn't running. */
function stopVadLoop() {
    if (liveVadTimer) clearInterval(liveVadTimer);
    liveVadTimer = null;
}

/** Ship the recorded turn through STT → Claude → TTS, then listen again. */
async function sendLiveTurn() {
    const chunks = liveChunks;
    liveChunks = [];

    const blob = new Blob(chunks, { type: liveRecMime || 'audio/webm' });

    // Too small to contain speech — don't spend an API call on it.
    if (!liveHeardSpeech || blob.size < 1000) {
        liveTurnBusy = false;
        if (isLiveVoiceActive) beginListeningTurn();
        return;
    }

    isProcessingWave = true;
    updateStatus('Thinking…', 'processing');

    try {
        const form = new FormData();
        const ext = (liveRecMime.includes('mp4') ? '.mp4'
                   : liveRecMime.includes('ogg') ? '.ogg'
                   : '.webm');
        form.append('audio', blob, 'turn' + ext);
        if (window.conversationId) form.append('conversationId', window.conversationId);

        // 60s: a turn that triggers a tool chain (email + calendar + CRM) is slow.
        const result = await AtomAPI.postForm('/ai/voice', form, { timeoutMs: 60_000 });

        if (result.conversationId) window.conversationId = result.conversationId;
        if (result.transcription) addMessageToConversation('user', result.transcription);
        addMessageToConversation('assistant', result.message);
        pinResponseArea();

        isProcessingWave = false;

        // Spoken reply via ElevenLabs. Awaited so the next turn doesn't open
        // while Atom is still mid-sentence.
        await playResponseAudio(result.message);

    } catch (err) {
        isProcessingWave = false;
        console.error('[Atom] live turn failed:', err);

        if (err.status === 400 || (err.message && err.message.includes('tool_use_id'))) {
            await clearBrokenSession();
            updateStatus('Session reset — try that again.', 'info');
        } else {
            updateStatus('Voice error: ' + (err.message || err), 'error');
            addMessageToConversation('assistant', `Sorry, I hit a voice error: ${err.message || err}`);
            pinResponseArea();
        }
    } finally {
        isProcessingWave = false;
        liveTurnBusy     = false;
        // Skip the room-echo tail after Atom speaks — but not after a barge-in,
        // where playback was cut dead and you are already mid-sentence.
        liveRearmAt      = liveBargedIn ? 0 : Date.now() + VAD_REARM_MS;
        liveBargedIn     = false;
        // Deliberately NOT calling beginListeningTurn() here — the VAD loop
        // opens the next turn once the re-arm window closes, so we never start
        // recording into the tail of Atom's own voice.
        if (isLiveVoiceActive) updateStatus('🎤 Listening…', 'listening');
        // Session was stopped mid-turn and we flushed the last thing said.
        // Don't leave the user parked on "finishing that up…" forever.
        else updateStatus('Voice session ended.', 'info');
    }
}

/**
 * End the hands-free session and release the mic.
 *
 * @param   {object}  [options]
 * @param   {boolean} [options.flush]  Send the turn that is mid-recording
 *                                     instead of discarding it.
 * @returns {boolean} true if a final turn was handed off for processing.
 *
 * Two different intents share this function, and they want opposite things from
 * the audio currently in the buffer:
 *
 *   flush: true  — the USER pressed stop. They have just finished saying
 *                  something and are waiting on an answer. Stopping means "close
 *                  the mic", not "throw away what I said" — discarding it here
 *                  silently ate the whole turn.
 *   flush: false — a teardown nobody asked for: recorder error, MediaRecorder
 *                  that would not construct, idle timeout, mode switch to
 *                  text/dictation, emergency reset. Half a turn from one of
 *                  those is noise; keep dropping it. This stays the default so
 *                  the nine other callers are unaffected.
 *
 * A request already in flight (POST /ai/voice -> Claude -> TTS) is never
 * cancelled in either mode. It is already sent and already being paid for, and
 * the user still wants the reply. sendLiveTurn's finally sees
 * isLiveVoiceActive === false and simply does not reopen the mic.
 */
function stopLiveVoice(options) {
    const flush = !!(options && options.flush);

    isLiveVoiceActive = false;
    stopVadLoop();

    // Only meaningful if we are actually mid-recording AND heard speech —
    // flushing silence would just burn an STT call on room tone.
    const flushing = flush && !!liveRecorder
        && liveRecorder.state === 'recording' && liveHeardSpeech;

    if (liveRecorder) {
        try {
            // Leaving onstop attached is what lets sendLiveTurn() run.
            if (!flushing) liveRecorder.onstop = null;
            if (liveRecorder.state === 'recording') liveRecorder.stop();
        } catch (e) { /* already inactive */ }
        liveRecorder = null;
    }

    if (flushing) {
        // Hand off to sendLiveTurn via onstop. Deliberately do NOT clear
        // liveChunks or liveHeardSpeech — sendLiveTurn reads both, and its
        // own guard drops the turn if the blob is too small to hold speech.
        liveTurnBusy     = true;
        isProcessingWave = true;
    } else {
        liveTurnBusy     = false;
        liveHeardSpeech  = false;
        liveChunks       = [];
        isProcessingWave = false;
        stopAllPlayback();
    }

    if (micStream) {
        micStream.getTracks().forEach(t => t.stop());
        micStream = null;
    }

    isRecording = false;
    updateRecordingUI(false);
    return flushing;
}

// -- Tap-to-talk fallback ------------------------------------------------------

/**
 * Manual record -> send, used when the hands-free session can't start.
 * Same pipeline as live voice (ElevenLabs -> Claude -> ElevenLabs); you just
 * control the turn boundaries with the mic button instead of by pausing.
 */
async function fallbackToTapToTalk(reason) {
    updateStatus(`${reason} - tap the mic to record, tap again to send`, 'info');
    try {
        await startRecording();
    } catch (e) {
        updateStatus('Microphone unavailable: ' + (e && e.message ? e.message : e), 'error');
    }
}


// ── Main toggle ───────────────────────────────────────────────────────────────

async function toggleRecording() {
    if (isLiveVoiceActive) {
        // End the hands-free session. flush: the user pressed stop right after
        // saying something and is waiting on the answer — close the mic, but
        // still send what they said.
        const flushed = stopLiveVoice({ flush: true });
        if (flushed) updateStatus('Got it — finishing that up…', 'processing');
        else         updateStatus('Voice session ended.', 'info');
    } else if (isRecording) {
        // A one-shot tap-to-record is in progress — stop it and transcribe
        stopRecording();
    } else {
        // Start hands-free live voice (ElevenLabs → Claude → ElevenLabs)
        await startLiveVoice();
    }
}

// ── Voice-to-Text mode ────────────────────────────────────────────────────────
//
// Uses the browser's built-in SpeechRecognition API to transcribe speech
// into the text input box. The user can then review / edit the text
// before clicking Send — giving them full control.

function toggleVoiceToText() {
    if (isVttActive) stopVoiceToText();
    else             startVoiceToText();
}

function startVoiceToText() {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) {
        updateStatus('Voice-to-Text requires Chrome or Edge.', 'error');
        return;
    }

    // Stop live voice if it's running
    if (isLiveVoiceActive) stopLiveVoice();

    const input = document.getElementById('mainTextInput');

    vttRecognition = new SpeechRec();
    vttRecognition.continuous     = true;
    vttRecognition.interimResults = true;
    vttRecognition.lang           = 'en-US';

    // Seed the buffer with whatever is already in the input
    vttFinalBuffer = input?.value?.trim() ?? '';

    vttRecognition.onresult = (event) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
            if (event.results[i].isFinal) {
                const word = event.results[i][0].transcript.trim();
                if (word) vttFinalBuffer += (vttFinalBuffer ? ' ' : '') + word;
            } else {
                interim += event.results[i][0].transcript;
            }
        }
        // Put finalized text in the input so user can see/edit it
        if (input) {
            input.value = vttFinalBuffer + (interim ? ' ' + interim : '');
            input.dispatchEvent(new Event('input')); // resize + enable Send button
        }
        updateStatus(interim ? `🎙️ "${interim}"` : '🎙️ Listening…', 'listening');
    };

    vttRecognition.onerror = (event) => {
        if (event.error === 'no-speech') return; // just silence — keep going
        updateStatus(`Dictation error: ${event.error}`, 'error');
        stopVoiceToText();
    };

    vttRecognition.onend = () => {
        // Chrome auto-stops on silence — restart so it's continuous until user stops
        if (isVttActive) {
            try { vttRecognition.start(); } catch(e) {}
        }
    };

    vttRecognition.start();
    isVttActive = true;

    updateStatus('🎙️ Listening… Speak your message, then click Send', 'listening');
    updateVttUI(true);
}

function stopVoiceToText() {
    if (vttRecognition) {
        try { vttRecognition.stop(); } catch(e) {}
        vttRecognition = null;
    }
    isVttActive    = false;
    vttFinalBuffer = '';
    updateStatus('Dictation stopped. Edit your message and click Send.', 'info');
    updateVttUI(false);
}

/** Expose so chat.js can reset the buffer after the user sends a message */
window.resetVttBuffer = () => { vttFinalBuffer = ''; };

function updateVttUI(active) {
    const btn = document.getElementById('vttButton');
    if (btn) {
        btn.classList.toggle('recording', active);
        btn.textContent = active ? '⏹ Stop Dictation' : '🎙️ Dictate';
        btn.dataset.tip = active ? 'Click to stop dictating' : 'Dictate — your speech becomes text you can review';
    }
    // Keep the always-visible "talking face" button in the chat bar in sync
    const face = document.getElementById('faceDictateBtn');
    if (face) {
        face.classList.toggle('talking', active);
        face.dataset.tip = active
            ? 'Listening… tap to stop'
            : 'Tap to dictate — speak and your words become text';
        face.setAttribute('aria-pressed', active ? 'true' : 'false');
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
    voiceButton.dataset.tip = recording ? 'Click to stop recording' : 'Start or stop live voice recording';
}

function emergencyResetRecording() {
    console.log('🚨 Emergency reset');
    stopLiveVoice();
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
        // Re-throw. This used to swallow the error into updateStatus, which made
        // the catch in fallbackToTapToTalk — the only caller — unreachable: a
        // mic that never opened told the user "tap the mic to record" and then
        // did nothing at all when they did. Reset local state, let the caller
        // report it.
        isRecording = false;
        updateRecordingUI(false);
        throw e;
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
        // The user spoke into the mic (legacy fallback for live mode), so answer aloud.
        maybeSpeakResponse(result.message, 'live');
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

/**
 * Speak `text` through the backend TTS endpoint (ElevenLabs).
 * Always plays when called directly — callers decide whether speaking is
 * allowed (see maybeSpeakResponse / readMessageAloud). The master mute still
 * wins so the user always has one switch that silences everything.
 *
 * Resolves when playback FINISHES (or fails), so the live-voice loop can wait
 * for Atom to stop talking before it reopens the mic. Callers that don't care
 * can still ignore the promise.
 */
function playResponseAudio(text) {
    if (!voiceResponseOn || !text?.trim()) return Promise.resolve();
    stopAllPlayback();

    return (async () => {
        let url = null;
        try {
            const resp = await AtomAPI.postRaw('/ai/speak', { text }, { timeoutMs: 30_000 });
            if (!resp.ok) return;
            const blob = await resp.blob();
            url = URL.createObjectURL(blob);
            currentAudio = new Audio(url);

            const ctx = getAudioCtx();
            // Route through the playback analyser so the waveform reacts to Atom.
            const src = ctx.createMediaElementSource(currentAudio);
            src.connect(analyser);

            isSpeakingWave = true;

            // Resolve on end, error, OR barge-in (stopAllPlayback pauses the
            // element, which fires neither 'ended' nor 'error' — without the
            // pause handler an interrupted reply would hang the live loop).
            await new Promise((resolve) => {
                let settled  = false;
                let watchdog = null;
                const done = () => {
                    if (settled) return;
                    settled = true;
                    if (watchdog) clearTimeout(watchdog);
                    isSpeakingWave = false;
                    restoreMicGain();
                    // Drop the graph edge for this reply. A MediaElementSource
                    // node cannot be reused or re-created for the same element,
                    // and it keeps that element alive as long as it stays
                    // connected — so without this every spoken reply left a
                    // permanent node hanging off `analyser` (and an <audio>
                    // element that could never be collected) for the whole
                    // session. currentAudio is nulled elsewhere, which hid the
                    // leak rather than fixing it.
                    try { src.disconnect(); } catch (e) { /* already torn down */ }
                    if (url) URL.revokeObjectURL(url);
                    resolve();
                };
                currentAudio.onended = done;
                currentAudio.onerror = done;
                currentAudio.onpause = done;

                // Backstop. If the element never reports 'ended' — a truncated or
                // corrupt blob, a codec the browser accepts then stalls on, a
                // background tab suspending playback — this promise would never
                // settle, and the live-voice loop would sit forever with the mic
                // closed and no way back. Always give it a way out.
                const arm = (ms) => {
                    if (watchdog) clearTimeout(watchdog);
                    watchdog = setTimeout(done, ms);
                };
                arm(60_000);
                currentAudio.onloadedmetadata = () => {
                    // Once we know the real length, tighten the backstop to it.
                    const d = currentAudio.duration;
                    arm(Number.isFinite(d) && d > 0 ? d * 1000 + 3_000 : 60_000);
                };

                // DO NOT duck the mic here.
                //
                // This used to set _micGain.gain.value = 0 for the duration of
                // playback to stop Atom hearing himself. It could not have done
                // that — the mic tap is deliberately NOT connected to
                // audioCtx.destination (see getAudioCtx), so there is no path
                // from mic to speaker to suppress. What it DID do was silence
                // micAnalyser, which sits downstream of _micGain and is the only
                // thing runVadLoop() reads. getMicEnergy() returned ~0 for the
                // whole reply, so `level > VAD_BARGE_LEVEL` never became true
                // and barge-in was unreachable code.
                //
                // If real ducking is ever needed, add a separate gain node on a
                // path that actually reaches the speakers — never on the VAD tap.
                currentAudio.play().catch(done);
            });
        } catch (e) {
            // play() rejects under autoplay policy — without this the mic tap
            // would stay ducked forever and the waveform would sit flat.
            isSpeakingWave = false;
            restoreMicGain();
            if (url) URL.revokeObjectURL(url);
        }
    })();
}

function stopAudioPlayback() { stopAllPlayback(); }

/**
 * Called for every Atom response. Speaks it ONLY when the user is in a live
 * voice conversation or has switched "Always read" on. Typed chat stays silent.
 *
 * @param {string} text    the response text
 * @param {string} source  'text' (typed / dictated) | 'live' (spoken turn)
 */
function maybeSpeakResponse(text, source = 'text') {
    if (!text?.trim()) return;
    const inLiveVoice = source === 'live' || isLiveVoiceActive;
    if (!inLiveVoice && !alwaysReadOn) return;   // silent by default
    playResponseAudio(text);
}

/** 🔊 button on a single message — explicit request, ignores the Always-read setting. */
function readMessageAloud(msgIndex) {
    const message = (window.conversationMessages || [])[msgIndex];
    if (!message?.content) return;
    if (!voiceResponseOn) {
        updateStatus('Audio is muted — unmute to hear responses.', 'info');
        return;
    }
    playResponseAudio(message.content);
}

/** Toggle "read every response aloud". Persisted so it survives a reload. */
function toggleAlwaysRead() {
    alwaysReadOn = !alwaysReadOn;
    try { localStorage.setItem('atom.alwaysRead', alwaysReadOn ? '1' : '0'); } catch (e) {}
    updateAlwaysReadUI();
    if (!alwaysReadOn) stopAllPlayback();
}

function updateAlwaysReadUI() {
    const btn = document.getElementById('alwaysReadBtn');
    if (!btn) return;
    btn.innerHTML         = alwaysReadOn ? '&#x1F501; Always read' : '&#x1F446; Read on tap';
    btn.dataset.tip       = alwaysReadOn
        ? 'Every response is read aloud — click for tap-to-read only'
        : 'Responses stay silent — tap 🔊 on a message to hear it, or click to always read';
    btn.style.color       = alwaysReadOn ? '#00d4dc' : '#64748b';
    btn.style.borderColor = alwaysReadOn ? 'rgba(0,212,220,0.35)' : 'rgba(255,255,255,0.15)';
    btn.setAttribute('aria-pressed', alwaysReadOn ? 'true' : 'false');
}

function toggleVoiceResponse() {
    voiceResponseOn = !voiceResponseOn;
    const btn = document.getElementById('muteBtn');
    if (btn) {
        btn.innerHTML         = voiceResponseOn ? '&#x1F50A; Audio' : '&#x1F507; Muted';
        btn.dataset.tip       = voiceResponseOn ? 'Audio response ON \u2014 click to mute' : 'Audio response OFF \u2014 click to unmute';
        btn.style.color       = voiceResponseOn ? '#00d4dc' : '#64748b';
        btn.style.borderColor = voiceResponseOn ? 'rgba(0,212,220,0.35)' : 'rgba(255,255,255,0.15)';
    }
    if (!voiceResponseOn) stopAllPlayback();
}

// ── Legacy stubs ──────────────────────────────────────────────────────────────
function initializeWaveformLegacy() {}
function createSmoothPath() { return ''; }
function connectAudioAnalyser() {}
function disconnectAudioAnalyser() {}


