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

Object.assign(globalThis, {
    window: globalThis,
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
