/**
 * Headless harness for the live-voice loop in public/js/voice.js.
 *
 * Loads the REAL voice.js into a `vm` sandbox with stubbed browser APIs, then
 * drives it with scripted microphone-energy sequences and a virtual clock.
 *
 * Why not Playwright: the interesting failures here are timing and state-machine
 * bugs — a turn that never closes, a mic that never reopens, a promise that
 * never settles. Reproducing those in a real browser needs real seconds of real
 * audio and is flaky. A virtual clock makes them deterministic and instant. The
 * Playwright smoke spec still covers the page actually loading and wiring up.
 *
 * It exercises the REAL voice.js — not a copy — so it fails when the source
 * drifts. Coverage: turn boundaries, VAD thresholds, barge-in, mic release,
 * error recovery, the playback watchdog, and the provider policy (no OpenAI in
 * the speech path).
 *
 *   npm run test:voice
 *   node tests/live-voice.harness.js [path/to/voice.js]
 */

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const VOICE_JS = process.argv[2] ||
    path.join(__dirname, '..', 'public', 'js', 'voice.js');

// ── Virtual clock ───────────────────────────────────────────────────────────
let NOW = 1_000_000;
const advance = (ms) => { NOW += ms; };

// ── Scripted mic level ──────────────────────────────────────────────────────
let micLevel = 0;
const setMic = (v) => { micLevel = v; };

function buildSandbox(opts = {}) {
    const log = { statuses: [], posted: [], messages: [], spoke: [] };

    // --- rAF: collected, stepped manually -----------------------------------
    let rafQueue = [];
    let rafId = 0;
    const requestAnimationFrame = (fn) => { rafQueue.push({ id: ++rafId, fn }); return rafId; };
    const cancelAnimationFrame = (id) => { rafQueue = rafQueue.filter(r => r.id !== id); };

    // --- microtask draining --------------------------------------------------
    const drain = () => new Promise(res => setImmediate(res));

    // --- virtual timers ------------------------------------------------------
    let timers = [];
    let timerId = 0;
    const fireDueTimers = () => {
        const due = timers.filter(t => t.at <= NOW);
        timers = timers.filter(t => t.at > NOW);
        due.sort((a, b) => a.at - b.at).forEach(t => t.fn());
    };

    // --- Fake MediaRecorder --------------------------------------------------
    const recorders = [];
    class FakeMediaRecorder {
        constructor(stream, options) {
            this.stream = stream;
            this.mimeType = (options && options.mimeType) || 'audio/webm';
            this.state = 'inactive';
            this.ondataavailable = null;
            this.onstop = null;
            this.onerror = null;
            recorders.push(this);
        }
        start() { this.state = 'recording'; }
        stop() {
            if (this.state !== 'recording') return;
            this.state = 'inactive';
            // Emit a blob sized by how much "speech" the test says happened.
            if (this.ondataavailable) {
                this.ondataavailable({ data: { size: opts.blobSize == null ? 8000 : opts.blobSize } });
            }
            if (this.onstop) this.onstop();
        }
        static isTypeSupported() { return true; }
    }

    // --- Fake Web Audio ------------------------------------------------------
    const node = () => ({ connect() {}, disconnect() {}, gain: { value: 1 } });
    class FakeAnalyser {
        constructor() { this.fftSize = 256; this.smoothingTimeConstant = 0; this.frequencyBinCount = 128; }
        connect() {} disconnect() {}
        getByteFrequencyData(arr) { arr.fill(Math.round(micLevel * 255)); }
    }
    class FakeAudioContext {
        constructor() { this.state = 'running'; this.currentTime = 0; this.destination = node(); }
        createAnalyser() { return new FakeAnalyser(); }
        createGain() { return node(); }
        createMediaStreamSource() { return node(); }
        createMediaElementSource() { return node(); }
        createBuffer() { return { duration: 0.1, copyToChannel() {} }; }
        createBufferSource() { return { buffer: null, connect() {}, start() {}, stop() {}, onended: null }; }
        resume() {}
    }

    // --- Fake mic stream -----------------------------------------------------
    let tracksStopped = 0;
    const fakeStream = { getTracks: () => [{ stop: () => { tracksStopped++; } }] };

    // --- Fake <audio> --------------------------------------------------------
    const audios = [];
    const setTimeoutRef = (fn, ms) => { const id = ++timerId; timers.push({ id, at: NOW + (ms || 0), fn }); return id; };
    class FakeAudio {
        constructor(src) {
            this.src = src; this.onended = null; this.onerror = null; this.onpause = null;
            audios.push(this);
        }
        play() {
            if (opts.playbackNeverEnds) return Promise.resolve();   // stalled-element case
            this.duration = (opts.speakMs || 800) / 1000;
            if (this.onloadedmetadata) this.onloadedmetadata();
            // 'ended' arrives after the clip's length of virtual time.
            setTimeoutRef(() => { if (this.onended) this.onended(); }, opts.speakMs || 800);
            return Promise.resolve();
        }
        pause() { if (this.onpause) this.onpause(); }
    }

    const sandbox = {
        // Silent by default. Two tests deliberately inject failures, and their
        // stack traces printed to a clean run look exactly like something broke.
        // Set VOICE_HARNESS_DEBUG=1 to see them.
        console: process.env.VOICE_HARNESS_DEBUG
            ? console
            : { log: () => {}, warn: () => {}, error: () => {} },
        Date: { now: () => NOW },
        setTimeout: (fn, ms) => { const id = ++timerId; timers.push({ id, at: NOW + (ms || 0), fn }); return id; },
        clearTimeout: (id) => { timers = timers.filter(t => t.id !== id); },
        requestAnimationFrame, cancelAnimationFrame,
        MediaRecorder: FakeMediaRecorder,
        AudioContext: FakeAudioContext,
        Blob: class { constructor(parts, o) { this.type = o && o.type; this.size = opts.blobSize == null ? 8000 : opts.blobSize; } },
        FormData: class { append() {} },
        Audio: FakeAudio,
        URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
        btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
        atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
        navigator: { mediaDevices: { getUserMedia: async () => fakeStream } },
        document: {
            getElementById: () => null,
            querySelector: () => null,
            addEventListener: () => {},
        },
        Math, JSON, Promise, Error, Object, Array, Number, String, Boolean,
        Float32Array, Int16Array, Uint8Array,

        // App globals normally provided by chat.js / api.js
        AtomAPI: {
            postForm: async () => {
                log.posted.push('/ai/voice');
                if (opts.voiceFails) { const e = new Error('boom'); e.status = 500; throw e; }
                return { conversationId: 'c1', transcription: 'hello atom', message: 'Hi there.' };
            },
            postRaw: async () => { log.spoke.push('/ai/speak'); return { ok: true, blob: async () => ({}) }; },
            post: async () => ({}),
            del: async () => ({}),
        },
        addMessageToConversation: (role, c) => log.messages.push([role, c]),
        updateStatus: (m, t) => log.statuses.push([t, m]),
        pinResponseArea: () => {},
        updateConversationDisplay: () => {},
        esc: (s) => s,
        log,
        _state: { get tracksStopped() { return tracksStopped; }, recorders, audios },
        drain,
        stepFrames: async (n = 1) => {
            for (let i = 0; i < n; i++) {
                fireDueTimers();
                const q = rafQueue; rafQueue = [];
                for (const r of q) r.fn();
                await drain();
            }
        },
        fireDueTimers,
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;

    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(VOICE_JS, 'utf8'), sandbox, { filename: 'voice.js' });

    // voice.js declares its state with `let`, which lives in the script's
    // lexical scope and never lands on globalThis. Read/write it by evaluating
    // in the same context instead of poking sandbox properties.
    sandbox.get = (expr) => vm.runInContext(expr, sandbox);
    sandbox.set = (name, value) =>
        vm.runInContext(`${name} = ${JSON.stringify(value)}`, sandbox);

    return sandbox;
}

// ── Test runner ─────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
async function check(name, fn) {
    NOW = 1_000_000; micLevel = 0;
    try { await fn(); console.log(`  PASS  ${name}`); pass++; }
    catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m); }

// Simulate a stretch of wall-clock time with rAF firing through it.
async function elapse(s, ms, step = 100) {
    for (let t = 0; t < ms; t += step) { advance(step); await s.stepFrames(1); }
}


(async () => {
console.log('\nlive voice loop (ElevenLabs -> Claude -> ElevenLabs)\n');

await check('loads and exposes the live-voice entry points', async () => {
    const s = buildSandbox();
    for (const fn of ['startLiveVoice', 'stopLiveVoice', 'beginListeningTurn',
                      'endListeningTurn', 'sendLiveTurn', 'toggleRecording',
                      'fallbackToTapToTalk', 'startRecording', 'stopRecording']) {
        assert(typeof s[fn] === 'function', `${fn} is not defined`);
    }
});

await check('opens the mic and starts a recording turn', async () => {
    const s = buildSandbox();
    await s.get('startLiveVoice()');
    await s.drain();
    assert(s.get('isLiveVoiceActive') === true, 'session did not activate');
    assert(s.get("typeof isRealtimeActive") === 'undefined', 'isRealtimeActive alias should be gone');
    assert(s._state.recorders.length === 1, 'no recorder created');
    assert(s._state.recorders[0].state === 'recording', 'recorder not recording');
});

await check('speech then silence ends the turn and posts to /ai/voice', async () => {
    const s = buildSandbox();
    await s.get('startLiveVoice()');
    await s.drain();

    setMic(0.2);                       // talking
    await elapse(s, 400);

    setMic(0.0);                       // stopped talking
    await elapse(s, 1400);             // past VAD_SILENCE_MS
    for (let i = 0; i < 6; i++) await s.drain();

    assert(s.log.posted.includes('/ai/voice'), 'never posted the turn');
    assert(s.log.spoke.includes('/ai/speak'), 'never requested the spoken reply');
    const roles = s.log.messages.map(m => m[0]);
    assert(roles.includes('user') && roles.includes('assistant'), 'transcript not added to the thread');
});

await check('does NOT post when no speech was detected (no wasted API call)', async () => {
    const s = buildSandbox();
    await s.get('startLiveVoice()');
    await s.drain();

    setMic(0.005);                     // room noise only
    await elapse(s, 2000);
    await s.drain();

    assert(!s.log.posted.includes('/ai/voice'), 'posted silence to the API');
});

await check('drops a turn whose audio is too small to contain speech', async () => {
    const s = buildSandbox({ blobSize: 200 });
    await s.get('startLiveVoice()');
    await s.drain();
    setMic(0.2); await elapse(s, 400);
    setMic(0); await elapse(s, 1400);
    for (let i = 0; i < 4; i++) await s.drain();
    assert(!s.log.posted.includes('/ai/voice'), 'sent a sub-1KB blob');
});

await check('reopens the mic after a completed turn (loop keeps going)', async () => {
    const s = buildSandbox();
    await s.get('startLiveVoice()');
    await s.drain();

    setMic(0.2); await elapse(s, 400);
    setMic(0); await elapse(s, 1400);
    for (let i = 0; i < 6; i++) { await s.drain(); }

    await elapse(s, 2500);             // through playback + the re-arm window

    const recording = s._state.recorders.filter(r => r.state === 'recording');
    assert(s._state.recorders.length >= 2, 'no second turn was opened');
    assert(recording.length === 1, `expected exactly 1 live recorder, got ${recording.length}`);
});

await check('watchdog reopens the mic if playback never reports "ended"', async () => {
    // A truncated/corrupt MP3 can leave the <audio> element silent forever.
    // Without a backstop the loop waits on it and the mic never comes back.
    const s = buildSandbox({ playbackNeverEnds: true });
    await s.get('startLiveVoice()');
    await s.drain();

    setMic(0.2); await elapse(s, 400);
    setMic(0); await elapse(s, 1400);
    for (let i = 0; i < 6; i++) await s.drain();

    assert(s.get('liveTurnBusy') === true, 'precondition: should be waiting on playback');

    await elapse(s, 65_000, 1000);     // past the 60s backstop
    for (let i = 0; i < 6; i++) await s.drain();

    assert(s.get('liveTurnBusy') === false, 'DEADLOCK: stuck waiting on stalled playback');
    await elapse(s, 600);
    const recording = s._state.recorders.filter(r => r.state === 'recording');
    assert(recording.length === 1, 'mic never reopened after stalled playback');
});

await check('recovers and keeps listening after a failed request', async () => {
    const s = buildSandbox({ voiceFails: true });
    await s.get('startLiveVoice()');
    await s.drain();

    setMic(0.2); await elapse(s, 400);
    setMic(0); await elapse(s, 1400);
    for (let i = 0; i < 6; i++) await s.drain();

    assert(s.get('isLiveVoiceActive') === true, 'session died on a request error');
    assert(s.get('liveTurnBusy') === false, 'DEADLOCK: liveTurnBusy stuck true after an error');

    await elapse(s, 600);
    const recording = s._state.recorders.filter(r => r.state === 'recording');
    assert(recording.length === 1, 'mic never reopened after the error');
});

await check('barge-in stops playback and clears the re-arm delay', async () => {
    const s = buildSandbox();
    await s.get('startLiveVoice()');
    await s.drain();

    s.set('isSpeakingWave', true);           // pretend Atom is mid-reply
    setMic(0.3);                       // you talk over him
    await s.stepFrames(2);

    assert(s.get('liveBargedIn') === true, 'barge-in not registered');
    assert(s.get('isSpeakingWave') === false, 'playback was not stopped');
});

await check('stopLiveVoice releases the mic and cannot leave a turn in flight', async () => {
    const s = buildSandbox();
    await s.get('startLiveVoice()');
    await s.drain();
    setMic(0.2); await elapse(s, 300);

    s.get('stopLiveVoice()');
    await s.drain();

    assert(s.get('isLiveVoiceActive') === false, 'session still active');
    assert(s._state.tracksStopped > 0, 'microphone track was not released');
    assert(!s.log.posted.includes('/ai/voice'), 'teardown sent a half-recorded turn');
});

await check('toggleRecording starts then stops a live session', async () => {
    const s = buildSandbox();
    await s.get('toggleRecording()');
    await s.drain();
    assert(s.get('isLiveVoiceActive') === true, 'first toggle did not start');
    await s.get('toggleRecording()');
    await s.drain();
    assert(s.get('isLiveVoiceActive') === false, 'second toggle did not stop');
});

await check('stopLiveVoice (called by chat.js on mode switch) tears the loop down', async () => {
    const s = buildSandbox();
    await s.get('startLiveVoice()');
    await s.drain();
    s.get('stopLiveVoice()');
    await s.drain();
    assert(s.get('isLiveVoiceActive') === false, 'live loop survived the mode switch');
    assert(s._state.tracksStopped > 0, 'mic not released on mode switch');
});

await check('mic tap is never routed to the speakers (no feedback loop)', async () => {
    const src = fs.readFileSync(VOICE_JS, 'utf8');
    assert(/micAnalyser\s*=\s*audioCtx\.createAnalyser\(\)/.test(src), 'micAnalyser not created');
    assert(!/micAnalyser\.connect\(\s*(audioCtx\.)?destination/.test(src),
        'micAnalyser is connected to destination — that is a live feedback loop');
    assert(/_micGain\.connect\(micAnalyser\)/.test(src), 'mic is not tapped into the silent analyser');
});

await check('no OpenAI endpoint is reachable from the live path', async () => {
    const src = fs.readFileSync(VOICE_JS, 'utf8');
    const liveSection = src.slice(src.indexOf('LIVE VOICE'));
    const code = liveSection
        .split('\n')
        .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))   // strip comments
        .join('\n');
    assert(!/openai/i.test(code),
        'executable code in the live-voice section references OpenAI');
    assert(!/realtime-token|api\.openai\.com/.test(code),
        'live path still calls an OpenAI endpoint');
    assert(/\/ai\/voice/.test(liveSection) && /playResponseAudio/.test(liveSection),
        'live path does not go through /ai/voice + ElevenLabs TTS');
});

await check('long silence idles the session instead of recording forever', async () => {
    const s = buildSandbox();
    await s.get('startLiveVoice()');
    await s.drain();
    setMic(0.001);
    await elapse(s, 50_000, 1000);     // past VAD_NO_SPEECH_MS
    assert(s.get('isLiveVoiceActive') === false, 'session never idled out');
    assert(s._state.tracksStopped > 0, 'mic left open after idling out');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
})();
