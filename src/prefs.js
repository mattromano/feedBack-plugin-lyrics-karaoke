/**
 * User settings for vocal scoring (difficulty, mic device, latency) and
 * the mic-constraint helpers that depend on them. localStorage access is
 * always guarded: private windows and blocked storage throw.
 */

import { DIFFICULTIES, DEFAULT_DIFFICULTY } from './pitch.js';

const PREFIX = 'lyrics_karaoke.';
export const LATENCY_MIN_MS = -100;
export const LATENCY_MAX_MS = 400;
export const LATENCY_STEP_MS = 10;

function read(key) {
    try { return globalThis.localStorage.getItem(PREFIX + key); } catch (_) { return null; }
}
function write(key, value) {
    try { globalThis.localStorage.setItem(PREFIX + key, String(value)); } catch (_) { /* noop */ }
}

export function getDifficulty() {
    const v = read('difficulty');
    return Object.prototype.hasOwnProperty.call(DIFFICULTIES, v) ? v : DEFAULT_DIFFICULTY;
}
export function setDifficulty(id) {
    write('difficulty', Object.prototype.hasOwnProperty.call(DIFFICULTIES, id) ? id : DEFAULT_DIFFICULTY);
}

export function getDeviceId() {
    return read('deviceId') || '';
}
export function setDeviceId(id) {
    write('deviceId', id || '');
}

function clampLatency(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n)) return 0;
    const stepped = Math.round(n / LATENCY_STEP_MS) * LATENCY_STEP_MS;
    return Math.max(LATENCY_MIN_MS, Math.min(LATENCY_MAX_MS, stepped)) || 0;
}
export function getLatencyMs() {
    const raw = read('latencyMs');
    return raw === null ? 0 : clampLatency(raw);
}
export function setLatencyMs(ms) {
    write('latencyMs', clampLatency(ms));
}

export function micConstraints(deviceId) {
    return {
        audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: 1,
            ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        },
    };
}

/** True when getUserMedia failed because the requested device is gone. */
export function isDeviceMissingError(e) {
    if (!e) return false;
    if (e.name === 'NotFoundError') return true;
    return e.name === 'OverconstrainedError' && e.constraint === 'deviceId';
}

export async function listInputDevices() {
    const md = globalThis.navigator && globalThis.navigator.mediaDevices;
    if (!md || typeof md.enumerateDevices !== 'function') return [];
    const all = await md.enumerateDevices();
    return all
        .filter((d) => d.kind === 'audioinput')
        .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
}

/**
 * Song time a mic buffer represents: the playhead now, minus the buffer's
 * midpoint age and the user's latency correction (both wall-clock), scaled
 * to song-seconds by the playback rate.
 */
export function micSongTime(nowSongSec, midpointWallSec, latencyMs, playbackRate) {
    return nowSongSec - (midpointWallSec + latencyMs / 1000) * playbackRate;
}

/**
 * Label for an extra "saved device" option when the saved mic isn't in the
 * list, or null when no extra option is needed. Before mic permission the
 * browser hides device ids, so absence then doesn't mean it's unplugged.
 */
export function savedDeviceLabel(devices, savedId) {
    if (!savedId || devices.some((d) => d.deviceId === savedId)) return null;
    const idsVisible = devices.some((d) => d.deviceId);
    return idsVisible ? 'Saved microphone (not connected)' : 'Saved microphone';
}

const BUILT_IN_MIC = /built-?in|macbook|internal/i;

/**
 * Plain-language problems with the current mic setup, given the active mic's
 * label and enumerateDevices() output. A built-in laptop mic, or song audio
 * on speakers, means the mic hears the backing track and scoring is garbage.
 */
export function micWarnings(micLabel, devices) {
    const out = [];
    if (micLabel && BUILT_IN_MIC.test(micLabel)) {
        out.push('Using the built-in mic — pick your headset in Settings → Lyrics Karaoke.');
    }
    const outputs = (devices || []).filter((d) => d.kind === 'audiooutput');
    const def = outputs.find((d) => d.deviceId === 'default') || outputs[0];
    const outName = def && def.label ? def.label.replace(/^Default - /, '') : '';
    if (/speaker/i.test(outName)) {
        out.push(`The song is playing through ${outName} — the mic will hear it. Use headphones.`);
    }
    return out;
}
