import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScorer, rateAccuracy, starsFor, RATINGS } from '../src/scoring.js';
import { buildPhrases } from '../src/phrases.js';

// One phrase per entry of `phraseNotes`; each note is 1 s long, phrases are
// separated by 2 s of silence so each phrase ends on a `+` syllable.
function song(phraseNotes) {
    const tokens = [];
    let t = 0;
    for (const notes of phraseNotes) {
        notes.forEach((midi, i) => {
            const w = i === notes.length - 1 ? 'la+' : 'la';
            tokens.push(midi === null ? { t, d: 1, w } : { t, d: 1, w, midi });
            t += 1;
        });
        t += 2;
    }
    return { tokens, phrases: buildPhrases(tokens) };
}

// Sing every pitched note of phrase `pi` at target + offsetSemis, sampling every 50 ms.
function sing(scorer, s, pi, offsetSemis) {
    for (const idx of s.phrases[pi].tokenIdxs) {
        const tok = s.tokens[idx];
        for (let t = tok.t; t < tok.t + tok.d - 1e-9; t += 0.05) {
            scorer.addSample({ t, midi: (tok.midi ?? 60) + offsetSemis });
        }
    }
}

const endOf = (s, pi) => s.phrases[pi].end + 0.3;

test('octave-down singing is Awesome', () => {
    const s = song([[64, 67]]);
    const sc = createScorer({ ...s, difficulty: 'expert' });
    sing(sc, s, 0, -12);
    const ev = sc.advanceTo(endOf(s, 0));
    assert.equal(ev.length, 1);
    assert.equal(ev[0].rating, 'Awesome');
    assert.equal(ev[0].points, 1000);
    assert.equal(ev[0].multiplierBefore, 1);
});

test('silence is Awful and resets streak', () => {
    const s = song([[60], [62], [64]]);
    const sc = createScorer({ ...s, difficulty: 'medium' });
    sing(sc, s, 0, 0);
    sing(sc, s, 1, 0);
    const ev = sc.advanceTo(endOf(s, 2));
    assert.deepEqual(ev.map((e) => e.points), [1000, 2000, 0]);
    assert.equal(ev[2].rating, 'Awful');
    assert.equal(sc.snapshot().streak, 0);
    assert.equal(sc.snapshot().multiplier, 1);
    assert.equal(sc.snapshot().score, 3000);
});

test('multiplier caps at 4', () => {
    const s = song([[60], [60], [60], [60], [60], [60]]);
    const sc = createScorer({ ...s, difficulty: 'hard' });
    for (let i = 0; i < 6; i++) sing(sc, s, i, 0);
    const ev = sc.advanceTo(endOf(s, 5));
    assert.deepEqual(ev.map((e) => e.multiplierBefore), [1, 2, 3, 4, 4, 4]);
});

test('difficulty changes outcome', () => {
    const s = song([[60]]);
    const med = createScorer({ ...s, difficulty: 'medium' });
    const exp = createScorer({ ...s, difficulty: 'expert' });
    sing(med, s, 0, 1.5);
    sing(exp, s, 0, 1.5);
    assert.equal(med.advanceTo(endOf(s, 0))[0].accuracy, 1);
    assert.equal(exp.advanceTo(endOf(s, 0))[0].accuracy, 0);
});

test('paused samples add nothing', () => {
    const s = song([[60, 62]]);
    const sc = createScorer({ ...s, difficulty: 'medium' });
    sc.addSample({ t: 0.2, midi: 60 });
    sc.addSample({ t: 0.25, midi: 60 });
    const before = sc.tokenAccuracy(0);
    for (let i = 0; i < 50; i++) sc.addSample({ t: 0.25, midi: 60 });
    assert.equal(sc.tokenAccuracy(0), before);
    assert.equal(sc.tokenAccuracy(1), null);
});

test('reset on backward time', () => {
    const s = song([[60], [62]]);
    const sc = createScorer({ ...s, difficulty: 'medium' });
    sing(sc, s, 0, 0);
    assert.equal(sc.advanceTo(endOf(s, 0)).length, 1);
    assert.equal(sc.snapshot().ratedCount, 1);
    sc.addSample({ t: 0.1, midi: 60 });
    assert.equal(sc.snapshot().score, 0);
    assert.equal(sc.snapshot().ratedCount, 0);
    // The rewound phrase can be scored again.
    assert.equal(sc.advanceTo(endOf(s, 0)).length, 1);
});

test('unpitched phrase skipped', () => {
    const s = song([[60], [null, null], [62]]);
    const sc = createScorer({ ...s, difficulty: 'medium' });
    sing(sc, s, 0, 0);
    sing(sc, s, 2, 0);
    const ev = sc.advanceTo(endOf(s, 2));
    assert.deepEqual(ev.map((e) => e.phraseIndex), [0, 2]);
    assert.equal(ev[1].multiplierBefore, 2);
    assert.equal(sc.snapshot().streak, 2);
});

test('ratings and stars thresholds', () => {
    assert.deepEqual(RATINGS, ['Awesome', 'Strong', 'Good', 'OK', 'Messy', 'Awful']);
    assert.equal(rateAccuracy(0.9), 'Awesome');
    assert.equal(rateAccuracy(0.55), 'Good');
    assert.equal(rateAccuracy(0.149), 'Awful');
    assert.equal(starsFor(null), 0);
    assert.equal(starsFor(0.1), 0);
    assert.equal(starsFor(0.76), 4);
    assert.equal(starsFor(0.95), 5);
});

test('stars follow mean accuracy of rated phrases', () => {
    const s = song([[60], [60]]);
    const sc = createScorer({ ...s, difficulty: 'medium' });
    assert.equal(sc.snapshot().stars, 0);
    sing(sc, s, 0, 0);
    sc.advanceTo(endOf(s, 1));
    // mean accuracy 0.5 → 2 stars
    assert.equal(sc.snapshot().stars, 2);
});

test('starting mid-song does not rate phrases already passed', () => {
    const s = song([[60], [62], [64]]);
    const sc = createScorer({ ...s, difficulty: 'medium' });
    assert.deepEqual(sc.advanceTo(s.phrases[2].start), []);
    sing(sc, s, 2, 0);
    const ev = sc.advanceTo(endOf(s, 2));
    assert.deepEqual(ev.map((e) => e.phraseIndex), [2]);
    assert.equal(sc.snapshot().score, 1000);
});

test('seeking back silently then singing does not cascade Awful ratings', () => {
    const s = song([[60], [62], [64], [65]]);
    const sc = createScorer({ ...s, difficulty: 'medium' });
    for (let i = 0; i < 4; i++) sing(sc, s, i, 0);
    sc.advanceTo(endOf(s, 3));
    // Seek back to phrase 2 without singing: frames keep advancing.
    sc.advanceTo(s.phrases[2].start);
    assert.equal(sc.snapshot().score, 0);
    sing(sc, s, 2, 0);
    const ev = sc.advanceTo(endOf(s, 2));
    assert.deepEqual(ev.map((e) => e.phraseIndex), [2]);
});

test('a phrase joined partway through is left unrated', () => {
    const s = song([[60, 62, 64], [65]]);
    const sc = createScorer({ ...s, difficulty: 'medium' });
    // Join 1.5 s into phrase 0 (mic started late or seek landed mid-phrase).
    for (let t = 1.5; t < 3; t += 0.05) sc.addSample({ t, midi: t < 2 ? 62 : 64 });
    sing(sc, s, 1, 0);
    const ev = sc.advanceTo(endOf(s, 1));
    assert.deepEqual(ev.map((e) => e.phraseIndex), [1]);
    assert.equal(sc.snapshot().streak, 1);
});
