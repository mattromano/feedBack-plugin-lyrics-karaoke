// Runs src/main.js under fake DOM, storage, media and WebAudio objects to
// check window.lyricsKaraoke's wiring. Node has no WebAudio and every audio
// node here is a plain object, so nothing can make a sound.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const byId = new Map();

function makeEl(tag) {
    const el = {
        tagName: String(tag).toUpperCase(), id: '', children: [], style: {}, dataset: {},
        parentNode: null, disabled: false, title: '', value: '', textContent: '', className: '',
        isConnected: true,
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
        insertBefore(c) { c.parentNode = el; el.children.push(c); return c; },
        removeChild(c) { el.children = el.children.filter((x) => x !== c); c.parentNode = null; return c; },
        addEventListener() {}, removeEventListener() {},
        setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
        focus() {}, blur() {},
        querySelector: () => null, querySelectorAll: () => [],
        getBoundingClientRect: () => ({ width: 100, height: 100 }),
        getContext: () => null,
    };
    return el;
}

const toolbar = makeEl('div');
const lyricsBtn = makeEl('button');
toolbar.appendChild(lyricsBtn);
byId.set('btn-lyrics', lyricsBtn);
const settingsDiff = makeEl('select');
byId.set('lk-set-difficulty', settingsDiff);
const player = makeEl('div');
byId.set('player', player);
byId.set('highway', makeEl('canvas'));

const store = new Map();
const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
};

function audioNode() {
    return { connect() {}, disconnect() {}, gain: { value: 1, setTargetAtTime() {} } };
}
function param() { return { value: 0 }; }
class FakeAudioContext {
    constructor() { this.state = 'running'; this.sampleRate = 48000; this.destination = {}; this.currentTime = 0; }
    resume() { return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    createMediaStreamSource() { return audioNode(); }
    createScriptProcessor() { return { ...audioNode(), onaudioprocess: null }; }
    createGain() { return audioNode(); }
    createDynamicsCompressor() {
        return { ...audioNode(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() };
    }
}

const media = { fail: false };
const fakeStream = () => {
    const track = { label: 'Test mic', enabled: true, muted: false, readyState: 'live', stop() {} };
    return { getTracks: () => [track], getAudioTracks: () => [track] };
};

// Karaoke's server: every song has synced lyrics, vocals and pitch.
const fetched = [];
const PITCH = { tokens: [{ t: 0, d: 0.5, w: 'la', midi: 60 }, { t: 1, d: 0.5, w: 'la', midi: 62 }] };
async function fakeFetch(url) {
    fetched.push(url);
    const body = url.includes('/status?') ? { has_lyrics: true, has_vocals: true, has_pitch: true } : PITCH;
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

// Core's bus: emit returns the handler's result so a test can await the load.
const handlers = new Map();
const slopsmith = {
    on(name, fn) { handlers.set(name, fn); },
    emit() {},
};
const loadSong = (song) => handlers.get('song:loaded')({ detail: song });
// A fresh playSong: core emits song:loading first (an arrangement switch doesn't).
const playSong = (song) => {
    const onLoading = handlers.get('song:loading');
    if (onLoading) onLoading({ detail: { filename: song.filename, arrangement: null } });
    return loadSong(song);
};

Object.assign(globalThis, {
    window: globalThis,
    slopsmith,
    fetch: fakeFetch,
    // The strip's draw loop never runs: nothing is drawn under node.
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    document: {
        readyState: 'complete',
        getElementById: (id) => byId.get(id) || null,
        createElement: makeEl,
        addEventListener() {},
        body: makeEl('body'),
    },
    localStorage,
    location: { protocol: 'http:', hostname: 'localhost' },
    AudioContext: FakeAudioContext,
});
Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
        mediaDevices: {
            getUserMedia: async () => {
                if (media.fail) { const e = new Error('Permission denied'); e.name = 'NotAllowedError'; throw e; }
                return fakeStream();
            },
            enumerateDevices: async () => [],
        },
    },
});

const origWarn = console.warn;
console.warn = () => {};   // the failed-start test logs karaoke's own warning
await import('../src/main.js');
const api = globalThis.lyricsKaraoke;
const playerDiff = lyricsBtn.parentNode.children.find((c) => c.id === 'btn-karaoke-difficulty');
const FLAG = 'lyrics_karaoke.micFeedback';

// A failed assertion must not leave the mic's polling interval keeping node alive.
after(() => { media.fail = false; api.stopMic(); console.warn = origWarn; });

test('the harness built the player picker and the API', () => {
    assert.equal(api.apiVersion, 1);
    assert.ok(playerDiff, 'player difficulty select exists');
});

test('an override equal to the saved difficulty still locks both pickers; null unlocks', () => {
    localStorage.setItem('lyrics_karaoke.difficulty', 'medium');
    assert.equal(api.getDifficulty(), 'medium');
    assert.equal(playerDiff.disabled, false);

    assert.equal(api.setDifficulty('medium'), true);
    for (const sel of [playerDiff, settingsDiff]) {
        assert.equal(sel.disabled, true);
        assert.equal(sel.title, 'Set on the band screen');
        assert.equal(sel.value, 'medium');
    }

    assert.equal(api.setDifficulty('hard'), true);
    assert.equal(playerDiff.value, 'hard');
    assert.equal(settingsDiff.value, 'hard');

    assert.equal(api.setDifficulty(null), true);
    assert.equal(playerDiff.disabled, false);
    assert.equal(playerDiff.title, 'Vocal difficulty');
    assert.equal(settingsDiff.disabled, false);
    assert.equal(settingsDiff.title, '');
    assert.equal(playerDiff.value, 'medium');
    assert.equal(settingsDiff.value, 'medium');
    assert.equal(localStorage.getItem('lyrics_karaoke.difficulty'), 'medium');
});

test('an API mic start, stop and failed start leave the saved micFeedback flag alone', async () => {
    localStorage.setItem('lyrics_karaoke.deviceId', 'mic-1');
    localStorage.setItem(FLAG, 'untouched');

    assert.equal(await api.startMic(), 'listening');
    assert.equal(localStorage.getItem(FLAG), 'untouched');
    api.stopMic();
    assert.equal(api.getMicState(), 'off');
    assert.equal(localStorage.getItem(FLAG), 'untouched');

    media.fail = true;
    assert.equal(await api.startMic(), 'error');
    assert.equal(localStorage.getItem(FLAG), 'untouched');
    media.fail = false;
    api.stopMic();
});

const SONG = { filename: 'Sing.sloppak', format: 'sloppak' };
const OTHER = { filename: 'Other.sloppak', format: 'sloppak' };
const tick = () => new Promise((r) => setTimeout(r, 0));
const playerChild = (id) => lyricsBtn.parentNode.children.find((c) => c.id === id);
const overlayIn = (host) => host.children.find((c) => c.id === 'lyrics-karaoke-overlay');

test('an API mic stop clears the mic intent: the next karaoke toggle on the same song opens no mic', async () => {
    localStorage.setItem('lyrics_karaoke.deviceId', 'mic-1');
    await loadSong(SONG);
    try {
        // Stopped while listening.
        assert.equal(await api.setKaraokeMode(true), true);
        assert.equal(await api.startMic(), 'listening');
        api.stopMic();
        assert.equal(await api.setKaraokeMode(false), false);
        assert.equal(await api.setKaraokeMode(true), true);
        await tick();
        assert.equal(api.getMicState(), 'off');

        // Stopped after karaoke-off already closed the mic (state 'off').
        assert.equal(await api.startMic(), 'listening');
        assert.equal(await api.setKaraokeMode(false), false);
        assert.equal(api.getMicState(), 'off');
        assert.equal(lyricsKaraokeDiag().micWantOnForSong, true, 'karaoke-off keeps the intent');
        api.stopMic();
        assert.equal(await api.setKaraokeMode(true), true);
        await tick();
        assert.equal(api.getMicState(), 'off');
        assert.equal(lyricsKaraokeDiag().micWantOnForSong, false);
    } finally {
        api.stopMic();
        await api.setKaraokeMode(false);
    }
});

test('a same-file song:loaded (arrangement switch) keeps karaoke, the strip, the mic and the scorer', async () => {
    localStorage.setItem('lyrics_karaoke.deviceId', 'mic-1');
    await loadSong(SONG);
    try {
        assert.equal(await api.setKaraokeMode(true), true);
        assert.equal(await api.startMic(), 'listening');
        const overlay = overlayIn(player);
        assert.ok(overlay, 'strip shown in #player');
        const n = fetched.length;

        await loadSong({ ...SONG, arrangement: 'Bass' });
        assert.equal(api.isKaraokeMode(), true);
        assert.equal(api.getMicState(), 'listening');
        assert.equal(overlayIn(player), overlay, 'same strip, still mounted');
        assert.equal(fetched.length, n, 'no re-fetch, so no new scorer');

        await loadSong(OTHER);
        assert.equal(api.isKaraokeMode(), false);
        assert.equal(api.getMicState(), 'off');
        assert.equal(overlayIn(player), undefined);
    } finally {
        api.stopMic();
        await api.setKaraokeMode(false);
    }
});

test('an API start with no mic chosen returns error without prompting the picker', async () => {
    await loadSong(SONG);
    assert.equal(await api.setKaraokeMode(true), true);
    const micSelect = playerChild('btn-karaoke-mic-device');
    assert.equal(micSelect.style.display, '', 'picker visible, so a prompt would focus it');
    const prompted = [];
    micSelect.focus = () => prompted.push('focus');
    micSelect.classList = { ...micSelect.classList, add: (...c) => prompted.push(c.join(' ')) };
    localStorage.removeItem('lyrics_karaoke.deviceId');
    try {
        assert.equal(await api.startMic(), 'error');
        assert.deepEqual(prompted, []);
    } finally {
        api.stopMic();
        await api.setKaraokeMode(false);
    }
});

test('the voice-volume slider is disabled while hear-myself is overridden off', () => {
    const slider = playerChild('btn-karaoke-monitor-volume');
    assert.equal(slider.disabled, false);
    assert.equal(api.setHearMyself(false), true);
    assert.equal(slider.disabled, true);
    assert.equal(api.setHearMyself(true), true);
    assert.equal(slider.disabled, false);
    api.setHearMyself(false);
    assert.equal(api.setHearMyself(null), true);
    assert.equal(slider.disabled, false);
});

test('a replay of the same file (song:loading first) resets the mic intent, karaoke mode and the song data', async () => {
    localStorage.setItem('lyrics_karaoke.deviceId', 'mic-1');
    await playSong(SONG);
    try {
        assert.equal(await api.setKaraokeMode(true), true);
        assert.equal(await api.startMic(), 'listening');
        assert.equal(lyricsKaraokeDiag().micWantOnForSong, true);
        const n = fetched.length;

        await playSong(SONG);
        assert.equal(api.isKaraokeMode(), false);
        assert.equal(api.getMicState(), 'off');
        assert.equal(lyricsKaraokeDiag().micWantOnForSong, false);
        assert.equal(overlayIn(player), undefined);
        assert.equal(fetched.length, n + 2, 'status and pitch re-fetched: a new scorer');

        // Karaoke back on for the replay opens no mic from the previous play.
        assert.equal(await api.setKaraokeMode(true), true);
        await tick();
        assert.equal(api.getMicState(), 'off');

        // An arrangement switch after the replay still keeps everything.
        assert.equal(await api.startMic(), 'listening');
        const m = fetched.length;
        await loadSong({ ...SONG, arrangement: 'Bass' });
        assert.equal(api.isKaraokeMode(), true);
        assert.equal(api.getMicState(), 'listening');
        assert.equal(fetched.length, m);
    } finally {
        api.stopMic();
        await api.setKaraokeMode(false);
    }
});
