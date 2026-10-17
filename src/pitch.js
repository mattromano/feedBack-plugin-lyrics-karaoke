/**
 * Pitch maths for vocal scoring: YIN detection, MIDI conversion and the
 * octave-agnostic credit curve. Pure — no DOM — so Node tests can load it.
 */

// toleranceCents: full credit inside ±tol, falling linearly to 0 at 1.5×tol.
// fill: share of a note's duration that must be covered for full accuracy.
export const DIFFICULTIES = Object.freeze({
    easy:   Object.freeze({ id: 'easy',   label: 'Easy',   toleranceCents: 250, fill: 0.5 }),
    medium: Object.freeze({ id: 'medium', label: 'Medium', toleranceCents: 175, fill: 0.6 }),
    hard:   Object.freeze({ id: 'hard',   label: 'Hard',   toleranceCents: 125, fill: 0.7 }),
    expert: Object.freeze({ id: 'expert', label: 'Expert', toleranceCents: 75,  fill: 0.8 }),
});
export const DEFAULT_DIFFICULTY = 'medium';

const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Error of `sungMidi` against `targetMidi` ignoring octave, in [-600, 600). */
export function pitchClassCents(sungMidi, targetMidi) {
    const cents = (sungMidi - targetMidi) * 100;
    return ((((cents + 600) % 1200) + 1200) % 1200) - 600;
}

/** Credit in [0, 1] for one sample `cents` away from the target. */
export function sampleCredit(cents, toleranceCents) {
    const err = Math.abs(cents);
    if (err <= toleranceCents) return 1;
    const zeroAt = toleranceCents * 1.5;
    if (err >= zeroAt) return 0;
    return (zeroAt - err) / (zeroAt - toleranceCents);
}

export function midiToName(midi) {
    const r = Math.round(midi);
    const pc = ((r % 12) + 12) % 12;
    const oct = Math.floor(r / 12) - 1;
    return PITCH_NAMES[pc] + oct;
}

export function freqToMidi(freq) {
    return 12 * Math.log2(freq / 440) + 69;
}

// Preallocated YIN working buffer reused across every 50ms detection
// frame to avoid per-frame Float32Array allocation / GC churn.
// Sized to cover tauMax at 96 kHz / 50 Hz (⌈96000/50⌉ + 1 = 1921 samples); grows
// lazily if an even higher sample rate is ever encountered.
let _yinWorkBuffer = new Float32Array(2048);

export function yinDetect(buffer, sampleRate, minFreqHz) {
    const threshold = 0.15;
    // tauMax is the lag that corresponds to the lowest pitch we search
    // for (minFreqHz). Capping halfLen here keeps the outer tau loop and
    // the inner difference-function loop both bounded by tauMax+1 instead
    // of buffer.length/2, reducing total work from O(N²) with N=2048 to
    // O(tauMax²) ≈ 882² at 44100 Hz / 50 Hz min — a ~5.4× speedup.
    const tauMax = Math.ceil(sampleRate / minFreqHz);
    const halfLen = Math.min(Math.floor(buffer.length / 2), tauMax + 1);
    if (halfLen < tauMax) return { freq: -1, confidence: 0 };
    // Reuse preallocated working buffer; grow only when a higher sample
    // rate demands more capacity (extremely rare in practice).
    if (_yinWorkBuffer.length < halfLen) _yinWorkBuffer = new Float32Array(halfLen);
    const yinBuffer = _yinWorkBuffer;
    let runningSum = 0;
    yinBuffer[0] = 1;
    for (let tau = 1; tau < halfLen; tau++) {
        let sum = 0;
        for (let i = 0; i < halfLen; i++) {
            const delta = buffer[i] - buffer[i + tau];
            sum += delta * delta;
        }
        yinBuffer[tau] = sum;
        runningSum += sum;
        yinBuffer[tau] = runningSum === 0 ? 1 : yinBuffer[tau] * (tau / runningSum);
    }
    let tau = 2;
    while (tau < halfLen) {
        if (yinBuffer[tau] < threshold) {
            while (tau + 1 < halfLen && yinBuffer[tau + 1] < yinBuffer[tau]) tau++;
            break;
        }
        tau++;
    }
    if (tau === halfLen) return { freq: -1, confidence: 0 };
    const s0 = tau > 0 ? yinBuffer[tau - 1] : yinBuffer[tau];
    const s1 = yinBuffer[tau];
    const s2 = tau + 1 < halfLen ? yinBuffer[tau + 1] : yinBuffer[tau];
    const parabDenom = 2 * (s0 - 2 * s1 + s2);
    const betterTau = parabDenom !== 0 ? tau + (s0 - s2) / parabDenom : tau;
    return {
        freq: sampleRate / betterTau,
        confidence: Math.max(0, 1 - yinBuffer[tau]),
    };
}

/** Your pitch moved into the octave nearest `targetMidi`, for drawing it
 *  against the chart's bars (scoring already ignores octave). */
export function foldToTarget(midi, targetMidi) {
    if (typeof targetMidi !== 'number') return midi;
    return targetMidi + pitchClassCents(midi, targetMidi) / 100;
}

/**
 * Linear gain for the vocal monitor from the 0–1 slider. A headset mic with
 * auto-gain off sits ~20 dB under a mastered song, so the range is boost:
 * 0 = off, then +6 dB … +18 dB (50% = +12 dB). +30 dB fed back through laptop
 * speakers in testing. A limiter follows it.
 */
export function monitorGainFor(volume) {
    if (!(volume > 0)) return 0;
    return Math.pow(10, (12 * Math.min(1, volume) + 6) / 20);
}

/**
 * True when the detected pitch has sat on one note, within 10 cents, for the
 * ~1 s before `now` without a gap — the signature of speaker→mic feedback.
 * Sung notes drift (vibrato, scoops) far more than that. `samples` are
 * time-ordered {t, midi}.
 */
export function isHowling(samples, now) {
    const WINDOW_S = 1.0, MIN_SPAN_S = 0.9, MAX_GAP_S = 0.15, MAX_SPREAD = 0.1;
    let lo = Infinity, hi = -Infinity, first = null, prev = null, count = 0;
    for (const s of samples || []) {
        if (s.t < now - WINDOW_S || s.t > now) continue;
        if (prev !== null && s.t - prev > MAX_GAP_S) return false;
        if (first === null) first = s.t;
        prev = s.t;
        count += 1;
        if (s.midi < lo) lo = s.midi;
        if (s.midi > hi) hi = s.midi;
    }
    if (count < 15 || first === null || prev - first < MIN_SPAN_S) return false;
    return hi - lo <= MAX_SPREAD;
}
