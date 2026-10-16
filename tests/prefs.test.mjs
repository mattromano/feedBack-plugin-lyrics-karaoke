import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    getDifficulty, setDifficulty, getDeviceId, setDeviceId, getLatencyMs, setLatencyMs,
    micConstraints, isDeviceMissingError, listInputDevices, micSongTime,
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
