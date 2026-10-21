import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DIFFICULTIES, DEFAULT_DIFFICULTY, pitchClassCents, sampleCredit,
    freqToMidi, midiToName, yinDetect, foldToTarget, monitorGainFor, isHowling,
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
