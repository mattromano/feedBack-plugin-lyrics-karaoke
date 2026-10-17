import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    getDifficulty, setDifficulty, getDeviceId, setDeviceId, getLatencyMs, setLatencyMs,
    micConstraints, isDeviceMissingError, listInputDevices, micSongTime, savedDeviceLabel, micWarnings, buildMicOptions, micStartError, SHOW_MIC_NAMES,
} from '../src/prefs.js';

function mapStorage() {
    const m = new Map();
    return {
        map: m,
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => { m.set(k, String(v)); },
        removeItem: (k) => { m.delete(k); },
    };
}
const throwingStorage = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
    removeItem() { throw new Error('denied'); },
};

beforeEach(() => { globalThis.localStorage = mapStorage(); });

// Node ships a read-only global navigator; replace it per test.
const setNavigator = (value) => Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });

test('settings round-trip under the lyrics_karaoke. prefix', () => {
    setDifficulty('expert');
    setDeviceId('jabra-123');
    setLatencyMs(40);
    assert.equal(getDifficulty(), 'expert');
    assert.equal(getDeviceId(), 'jabra-123');
    assert.equal(getLatencyMs(), 40);
    assert.equal(globalThis.localStorage.map.get('lyrics_karaoke.difficulty'), 'expert');
    assert.equal(globalThis.localStorage.map.get('lyrics_karaoke.deviceId'), 'jabra-123');
    assert.equal(globalThis.localStorage.map.get('lyrics_karaoke.latencyMs'), '40');
});

test('defaults when nothing is saved', () => {
    assert.equal(getDifficulty(), 'medium');
    assert.equal(getDeviceId(), '');
    assert.equal(getLatencyMs(), 0);
});

test('unknown or corrupt values fall back to defaults', () => {
    globalThis.localStorage.setItem('lyrics_karaoke.difficulty', 'nightmare');
    globalThis.localStorage.setItem('lyrics_karaoke.latencyMs', 'abc');
    assert.equal(getDifficulty(), 'medium');
    assert.equal(getLatencyMs(), 0);
});

test('latency is clamped and rounded to 10 ms steps', () => {
    setLatencyMs(999);
    assert.equal(getLatencyMs(), 400);
    setLatencyMs(-133);
    assert.equal(getLatencyMs(), -100);
    setLatencyMs(37);
    assert.equal(getLatencyMs(), 40);
    setLatencyMs(-73);
    assert.equal(getLatencyMs(), -70);
});

test('a throwing localStorage returns defaults without throwing', () => {
    globalThis.localStorage = throwingStorage;
    assert.doesNotThrow(() => { setDifficulty('hard'); setDeviceId('x'); setLatencyMs(20); });
    assert.equal(getDifficulty(), 'medium');
    assert.equal(getDeviceId(), '');
    assert.equal(getLatencyMs(), 0);
});

test('micConstraints only pins a device when one is chosen', () => {
    const def = micConstraints('');
    assert.equal('deviceId' in def.audio, false);
    assert.equal(def.audio.echoCancellation, false);
    assert.equal(def.audio.noiseSuppression, false);
    assert.equal(def.audio.autoGainControl, false);
    assert.equal(def.audio.channelCount, 1);
    assert.equal(micConstraints('abc').audio.deviceId.exact, 'abc');
});

test('isDeviceMissingError', () => {
    assert.equal(isDeviceMissingError({ name: 'OverconstrainedError', constraint: 'deviceId' }), true);
    assert.equal(isDeviceMissingError({ name: 'NotFoundError' }), true);
    assert.equal(isDeviceMissingError({ name: 'OverconstrainedError', constraint: 'sampleRate' }), false);
    assert.equal(isDeviceMissingError({ name: 'NotAllowedError' }), false);
    assert.equal(isDeviceMissingError(null), false);
});

test('listInputDevices keeps audio inputs and names unlabeled ones', async () => {
    setNavigator({ mediaDevices: { enumerateDevices: async () => ([
        { kind: 'audioinput', deviceId: 'default', label: 'Default - Jabra EVOLVE 20' },
        { kind: 'audiooutput', deviceId: 'spk', label: 'Speakers' },
        { kind: 'audioinput', deviceId: 'b', label: '' },
    ]) } });
    assert.deepEqual(await listInputDevices(), [
        { deviceId: 'default', label: 'Default - Jabra EVOLVE 20' },
        { deviceId: 'b', label: 'Microphone 2' },
    ]);
});

test('listInputDevices returns [] without mediaDevices', async () => {
    setNavigator({});
    assert.deepEqual(await listInputDevices(), []);
});

test('micSongTime subtracts buffer midpoint and latency, scaled by playback rate', () => {
    const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} !≈ ${b}`);
    close(micSongTime(10, 0.05, 0, 1), 9.95);
    close(micSongTime(10, 0.05, 100, 1), 9.85);
    close(micSongTime(10, 0.05, 100, 0.5), 9.925);
    close(micSongTime(10, 0.05, -50, 1), 10.0);
});

test('savedDeviceLabel only calls a saved mic "not connected" when ids are visible', () => {
    const named = [{ deviceId: 'jabra', label: 'Jabra EVOLVE 20' }];
    assert.equal(savedDeviceLabel(named, 'jabra'), null);            // listed: no extra entry
    assert.equal(savedDeviceLabel(named, 'gone'), 'Saved microphone (not connected)');
    // Before mic permission Chromium returns empty ids — can't tell, don't claim it's unplugged.
    assert.equal(savedDeviceLabel([{ deviceId: '', label: 'Microphone 1' }], 'jabra'), 'Saved microphone');
    assert.equal(savedDeviceLabel(named, ''), null);
});

test('micWarnings flags the built-in mic and speaker output', () => {
    const speakers = [{ kind: 'audiooutput', deviceId: 'default', label: 'Default - MacBook Pro Speakers' }];
    const headset = [{ kind: 'audiooutput', deviceId: 'default', label: 'Default - Jabra EVOLVE 20' }];
    assert.deepEqual(micWarnings('MacBook Pro Microphone', speakers), [
        'Using the built-in mic — pick your headset in Settings → Lyrics Karaoke.',
        'The song is playing through MacBook Pro Speakers — the mic will hear it. Use headphones.',
    ]);
    assert.deepEqual(micWarnings('Jabra EVOLVE 20', headset), []);
    assert.deepEqual(micWarnings('Default - MacBook Pro Microphone (Built-in)', headset),
        ['Using the built-in mic — pick your headset in Settings → Lyrics Karaoke.']);
    // Unknown output (no labels before permission) → no speaker warning.
    assert.deepEqual(micWarnings('Jabra EVOLVE 20', [{ kind: 'audiooutput', deviceId: 'default', label: '' }]), []);
    assert.deepEqual(micWarnings('', []), []);
});

test('buildMicOptions starts with a choose prompt (never a system default) and selects the saved mic', () => {
    const devices = [
        { deviceId: 'default', label: 'Default - MacBook Pro Microphone' },
        { deviceId: 'mbp', label: 'MacBook Pro Microphone' },
        { deviceId: 'jabra', label: 'Jabra EVOLVE 20' },
    ];
    assert.deepEqual(buildMicOptions(devices, 'jabra'), [
        { value: '', label: 'Choose a microphone…', selected: false },
        { value: 'mbp', label: 'MacBook Pro Microphone', selected: false },
        { value: 'jabra', label: 'Jabra EVOLVE 20', selected: true },
    ]);
    // Nothing saved → system default selected; unnamed devices (no permission yet) keep a plain label.
    assert.deepEqual(buildMicOptions([{ deviceId: '', label: 'Microphone 1' }], ''), [
        { value: '', label: 'Choose a microphone…', selected: true },
        { value: SHOW_MIC_NAMES, label: 'Show microphone names…', selected: false },
    ]);
    // Saved but unplugged device stays selectable.
    assert.deepEqual(buildMicOptions(devices.slice(0, 2), 'jabra').at(-1),
        { value: 'jabra', label: 'Saved microphone (not connected)', selected: true });
});

test('micStartError refuses to open any mic until one is chosen, and never substitutes another', () => {
    const named = [{ deviceId: 'mbp', label: 'MacBook Pro Microphone' }, { deviceId: 'jabra', label: 'Jabra EVOLVE 20' }];
    assert.equal(micStartError('', named), 'Pick a microphone first.');
    assert.equal(micStartError('jabra', named), null);
    assert.equal(micStartError('gone', named), "Your chosen microphone isn't connected — plug it in or pick another.");
    // Before mic permission ids are hidden: can't tell, so let getUserMedia decide.
    assert.equal(micStartError('jabra', [{ deviceId: '', label: 'Microphone 1' }]), null);
});
