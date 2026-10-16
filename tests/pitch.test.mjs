import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DIFFICULTIES, DEFAULT_DIFFICULTY, pitchClassCents, sampleCredit,
    freqToMidi, midiToName, yinDetect,
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
