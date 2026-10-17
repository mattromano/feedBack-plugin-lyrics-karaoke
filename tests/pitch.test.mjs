import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DIFFICULTIES, DEFAULT_DIFFICULTY, pitchClassCents, sampleCredit,
    freqToMidi, midiToName, yinDetect, foldToTarget, monitorGainFor, isHowling,
    VOCAL_MIN_HZ, foldSticky,
} from '../src/pitch.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !≈ ${b}`);

test('an octave below matches exactly', () => close(pitchClassCents(48, 60), 0));
test('an octave above plus a quarter tone is +50 cents', () => close(pitchClassCents(72.5, 60), 50));
test('a semitone flat is -100 cents', () => close(pitchClassCents(59, 60), -100));
test('the tritone wraps to -600', () => close(pitchClassCents(66, 60), -600));

test('full credit inside the tolerance', () => {
    assert.equal(sampleCredit(0, 175), 1);
    assert.equal(sampleCredit(175, 175), 1);
});
test('credit falls linearly to zero at 1.5x tolerance', () => {
    close(sampleCredit(-218.75, 175), 0.5);
    assert.equal(sampleCredit(262.5, 175), 0);
    assert.equal(sampleCredit(600, 175), 0);
});

test('difficulty table values', () => {
    assert.equal(DIFFICULTIES.expert.toleranceCents, 75);
    assert.equal(DIFFICULTIES.easy.fill, 0.5);
    assert.equal(DIFFICULTIES.medium.toleranceCents, 175);
    assert.equal(DIFFICULTIES.hard.fill, 0.7);
    assert.equal(DEFAULT_DIFFICULTY, 'medium');
});

test('yinDetect finds a 220 Hz sine', () => {
    const sr = 48000, buf = new Float32Array(2048);
    for (let i = 0; i < buf.length; i++) buf[i] = Math.sin(2 * Math.PI * 220 * i / sr);
    const r = yinDetect(buf, sr, 50);
    assert.ok(Math.abs(r.freq - 220) < 1, `freq ${r.freq}`);
    assert.ok(r.confidence > 0.9, `confidence ${r.confidence}`);
});

test('note names and frequency conversion', () => {
    assert.equal(midiToName(69), 'A4');
    close(freqToMidi(440), 69);
});

test('foldToTarget draws your pitch in the octave nearest the target note', () => {
    close(foldToTarget(48, 60), 60);        // an octave low lines up with the bar
    close(foldToTarget(73, 60), 61);        // an octave + semitone high → a semitone sharp
    close(foldToTarget(65.4, 60), 65.4);    // within ±6 semitones: unchanged
    close(foldToTarget(53.5, 60), 65.5);    // −6.5 st folds up to +5.5 (nearest octave)
    assert.equal(foldToTarget(55, null), 55); // no target: raw pitch
});

// A real Holiday run read ~62 Hz (song bass through the speakers, YIN dip 0.01) about 10% of
// the time; with YIN's 50 Hz floor that yanked the arrow 13+ semitones down mid-phrase.
test('the vocal floor ignores periodic sound below the singing range', () => {
    const sr = 48000, buf = new Float32Array(4096);
    for (let i = 0; i < buf.length; i++) {
        const t = i / sr;
        buf[i] = Math.sin(2 * Math.PI * 62 * t) + 0.5 * Math.sin(2 * Math.PI * 124 * t)
            + 0.15 * Math.sin(2 * Math.PI * 147 * t);
    }
    assert.ok(yinDetect(buf, sr, 50).freq < 70, 'a 50 Hz floor locks on to the bass');
    const r = yinDetect(buf, sr, VOCAL_MIN_HZ);
    assert.ok(r.freq < 0 || r.freq >= VOCAL_MIN_HZ, `got ${r.freq} Hz`);
});

test('the vocal floor still hears a low male voice', () => {
    const sr = 48000, buf = new Float32Array(4096);
    for (let i = 0; i < buf.length; i++) buf[i] = Math.sin(2 * Math.PI * 82.41 * i / sr);   // E2
    assert.ok(Math.abs(freqToMidi(yinDetect(buf, sr, VOCAL_MIN_HZ).freq) - 40) < 0.1);
});

// The same Holiday run: 20 of 27 big arrow jumps came while the voice held steady, because the
// arrow was refolded into the octave nearest each new target note.
test('foldSticky keeps a steady voice in one octave while the target moves', () => {
    let shift = null;
    const shown = [];
    for (const target of [60, 63, 66, 55, 58]) {
        const r = foldSticky(50, target, shift);
        shift = r.shift;
        shown.push(r.shown);
    }
    assert.deepEqual(shown, [62, 62, 62, 62, 62]);
    // plain nearest-octave folding drops a whole octave to 50 for target 55
    close(foldToTarget(50, 55), 50);
});

test('foldSticky does not flap at the half-octave boundary', () => {
    let shift = null;
    const shown = [];
    for (const midi of [53.9, 54.1, 53.95, 54.2]) {
        const r = foldSticky(midi, 60, shift);
        shift = r.shift;
        shown.push(Math.round(r.shown));
    }
    assert.deepEqual(shown, [66, 66, 66, 66]);   // foldToTarget alternates 66 / 54
});

test('foldSticky refolds once the voice is far from the target, and without a target', () => {
    const a = foldSticky(50, 60, null);              // 62
    const b = foldSticky(50, 74, a.shift);           // 62 is 12 below: refold
    close(b.shown, 74);
    assert.deepEqual(foldSticky(55, null, 12), { shown: 67, shift: 12 });   // no target: keep the octave
    assert.deepEqual(foldSticky(55, null, null), { shown: 55, shift: 0 });
});

test('monitorGainFor boosts a headset mic but caps at +18 dB: 0 = off, 50% = +12 dB, 100% = +18 dB', () => {
    // +30 dB at 100% produced a measured feedback howl through laptop speakers.
    assert.equal(monitorGainFor(0), 0);
    close(20 * Math.log10(monitorGainFor(0.5)), 12, 1e-9);
    close(20 * Math.log10(monitorGainFor(1)), 18, 1e-9);
    close(20 * Math.log10(monitorGainFor(0.25)), 9, 1e-9);
});

test('isHowling spots a feedback tone: one pitch held within a few cents for ~1 s', () => {
    // Measured howl: midi 80.4 for 10+ s. Samples every ~46 ms.
    const howl = Array.from({ length: 24 }, (_, i) => ({ t: i * 0.046, midi: 80.4 + (i % 2) * 0.03 }));
    assert.equal(isHowling(howl, 1.1), true);
});

test('isHowling ignores singing: held notes drift and phrases move', () => {
    // A held sung note wobbles (vibrato ~±30 cents) — not a howl.
    const held = Array.from({ length: 24 }, (_, i) => ({ t: i * 0.046, midi: 64 + 0.3 * Math.sin(i / 2) }));
    assert.equal(isHowling(held, 1.1), false);
    // A melody changes pitch.
    const melody = Array.from({ length: 24 }, (_, i) => ({ t: i * 0.046, midi: 60 + Math.floor(i / 6) * 2 }));
    assert.equal(isHowling(melody, 1.1), false);
    // Too short a window of data is never a howl.
    assert.equal(isHowling(Array.from({ length: 5 }, (_, i) => ({ t: i * 0.046, midi: 70 })), 1.1), false);
    // A gap breaks the run.
    const gappy = [...Array.from({ length: 12 }, (_, i) => ({ t: i * 0.046, midi: 70 })),
                   ...Array.from({ length: 12 }, (_, i) => ({ t: 2 + i * 0.046, midi: 70 }))];
    assert.equal(isHowling(gappy, 2.6), false);
});
