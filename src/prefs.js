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
            // No echo cancellation: with the voice monitored through speakers it
            // treats the singer's own voice as echo and scrubs it, killing pitch
            // detection. Feedback is handled by the monitor cap + howl guard.
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
    // Speakers only spoil scoring with a far-field (built-in) mic; a close-talk
    // headset mic over speakers is the intended setup.
    if (micLabel && BUILT_IN_MIC.test(micLabel) && /speaker/i.test(outName)) {
        out.push(`The song is playing through ${outName} — the mic will hear it. Use headphones.`);
    }
    return out;
}

export const SHOW_MIC_NAMES = '__show-mic-names__';

/**
 * <option> data for a mic picker. The first entry is a "Choose a
 * microphone…" prompt, never a system default: karaoke only ever opens the
 * mic the user picked. Chrome's "default" alias and id-less entries (before
 * mic permission) are skipped; a saved-but-unlisted mic stays selectable.
 */
export function buildMicOptions(devices, savedId) {
    const list = devices || [];
    const opts = [{ value: '', label: 'Choose a microphone…' }];
    for (const d of list) {
        if (!d.deviceId || d.deviceId === 'default') continue;
        opts.push({ value: d.deviceId, label: d.label });
    }
    const extra = savedDeviceLabel(list, savedId);
    if (extra) opts.push({ value: savedId, label: extra });
    // Before mic permission the browser hides every name and id; offer an
    // explicit way to unlock them instead of silently opening a default mic.
    if (!list.some((d) => d.deviceId && d.deviceId !== 'default')) {
        opts.push({ value: SHOW_MIC_NAMES, label: 'Show microphone names…' });
    }
    const pick = opts.some((o) => o.value === savedId) ? savedId : '';
    return opts.map((o) => ({ ...o, selected: o.value === pick }));
}

/**
 * Why the mic must not start, or null when it may. No choice yet, or the
 * chosen mic visibly unplugged, both stop here — there is no fallback to
 * another device.
 */
export function micStartError(deviceId, devices) {
    if (!deviceId) return 'Pick a microphone first.';
    const list = devices || [];
    const idsVisible = list.some((d) => d.deviceId);
    if (idsVisible && !list.some((d) => d.deviceId === deviceId)) {
        return "Your chosen microphone isn't connected — plug it in or pick another.";
    }
    return null;
}

/** Volume (0–1) of your voice played back through the game's output. */
export function getMonitorVolume() {
    const raw = read('monitorVolume');
    if (raw === null) return 0.5;
    const n = Number(raw);
    return Number.isFinite(n) ? clampVolume(n) : 0.5;
}
export function setMonitorVolume(v) {
    write('monitorVolume', clampVolume(Number(v)));
}
function clampVolume(n) {
    if (!Number.isFinite(n)) return 0.5;
    return Math.round(Math.max(0, Math.min(1, n)) * 20) / 20;
}

/**
 * Output device for the voice monitor: the same device playing the game's
 * audio. Browser playback uses the OS default (''); when the native engine
 * plays the song, match its output device by name.
 */
export function monitorSinkId(devices, { juceMode, engineOutput }) {
    if (!juceMode || !engineOutput) return '';
    // Chromium appends " (vendor:product)" or " (Built-in)" to labels; the
    // native engine reports the bare device name.
    const bare = (label) => String(label || '').replace(/\s+\([^()]*\)$/, '');
    const match = (devices || []).find((d) => d.kind === 'audiooutput'
        && d.deviceId !== 'default' && (d.label === engineOutput || bare(d.label) === engineOutput));
    return match ? match.deviceId : '';
}
