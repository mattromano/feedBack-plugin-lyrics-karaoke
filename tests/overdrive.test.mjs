import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVocalOverdrive, MIC_HIT_PHRASE_GUARD_S } from '../src/overdrive.js';
import { createMeasureClock } from '../src/measure.js';

// Beats every 0.5 s with `measure` set on every 4th: 2 s measures.
function beats(n = 200) {
    const out = [];
    for (let i = 0; i < n; i++) out.push({ time: i * 0.5, measure: i % 4 === 0 ? i / 4 : -1 });
    return out;
}
const make = () => createVocalOverdrive({ clock: createMeasureClock(beats()) });

test('Strong or better earns a quarter; ready at half', () => {
    const od = make();
    assert.equal(od.phrase('Awesome', 1), true);
    assert.equal(od.phrase('Strong', 2), true);
    assert.deepEqual(od.stateAt(2), { fill: 0.5, active: false, ready: true });
    assert.equal(od.phrase('Good', 3), false);
    assert.equal(od.stateAt(3).fill, 0.5);
});

test('a mic hit deploys only when ready', () => {
    const od = make();
    assert.equal(od.micHit(0.5), false);
    od.phrase('Awesome', 1);
    assert.equal(od.micHit(1.5), false);   // a quarter is not enough
    od.phrase('Awesome', 2);
    assert.equal(od.micHit(2.5), true);
    assert.equal(od.stateAt(2.5).active, true);
    assert.equal(od.stateAt(2.5).ready, false);
    assert.equal(od.micHit(2.6), false);   // already active
});

test('drain: a full bar lasts 8 measures', () => {
    const od = make();
    for (const t of [1, 2, 3, 4]) od.phrase('Awesome', t);
    assert.equal(od.stateAt(5).fill, 1);
    assert.equal(od.micHit(10), true);
    assert.equal(od.stateAt(18).fill, 0.5);
    assert.equal(od.isActiveAt(25.9), true);
    assert.equal(od.isActiveAt(26.1), false);
    assert.deepEqual(od.stateAt(27), { fill: 0, active: false, ready: false });
});

test('a gain while active extends it', () => {
    const od = make();
    for (const t of [1, 2, 3, 4]) od.phrase('Awesome', t);
    od.micHit(10);
    assert.equal(od.phrase('Strong', 18), true);
    assert.equal(od.stateAt(18).fill, 0.75);
    assert.equal(od.isActiveAt(26.1), true);   // would have ended without the gain
    assert.equal(od.isActiveAt(29.9), true);
    assert.equal(od.isActiveAt(30.1), false);
});

test('gains cap at a full bar', () => {
    const od = make();
    for (const t of [1, 2, 3, 4, 5, 6]) od.phrase('Awesome', t);
    assert.equal(od.stateAt(6).fill, 1);
});

test('times never run backwards: an earlier t is treated as the latest', () => {
    const od = make();
    for (const t of [1, 2, 3, 4]) od.phrase('Awesome', t);
    od.micHit(10);
    assert.equal(od.stateAt(18).fill, 0.5);
    assert.equal(od.stateAt(12).fill, 0.5);
    // isActiveAt answers an earlier t from history instead: not active before the deploy.
    assert.equal(od.isActiveAt(1), false);
    assert.equal(od.isActiveAt(12), true);
    assert.equal(od.stateAt(18).fill, 0.5);
});

test('no beats: 2 s per measure', () => {
    assert.equal(createMeasureClock([]).measureAt(6), 3);
    assert.equal(createMeasureClock(undefined).measureAt(6), 3);
    assert.equal(createMeasureClock([]).timeAtMeasure(3), 6);
});

test('measure clock: downbeats, every 4th beat, extrapolation', () => {
    const c = createMeasureClock(beats(9));   // downbeats at 0, 2, 4
    assert.equal(c.measureAt(1), 0.5);
    assert.equal(c.measureAt(3), 1.5);
    assert.equal(c.measureAt(-2), -1);        // before the first: extrapolated
    assert.equal(c.measureAt(8), 4);          // after the last: extrapolated
    assert.equal(c.timeAtMeasure(1.5), 3);
    assert.equal(c.timeAtMeasure(4), 8);
    // No downbeats marked: every 4th beat is a measure (beats every 0.25 s → 1 s measures).
    const plain = Array.from({ length: 13 }, (_, i) => ({ time: i * 0.25, measure: -1 }));
    const p = createMeasureClock(plain);
    assert.equal(p.measureAt(2.5), 2.5);
    assert.equal(p.timeAtMeasure(2), 2);
    // A single beat: the 2 s fallback.
    assert.equal(createMeasureClock([{ time: 5, measure: 0 }]).measureAt(4), 2);
});

test('reset empties the bar', () => {
    const od = make();
    for (const t of [1, 2, 3, 4]) od.phrase('Awesome', t);
    od.micHit(10);
    od.reset();
    assert.deepEqual(od.stateAt(0), { fill: 0, active: false, ready: false });
    assert.equal(od.phrase('Awesome', 1), true);
    assert.equal(od.stateAt(1).fill, 0.25);
});

// Sung phrases 0–2 s and 4–8 s: a mic hit deploys only in the gap between them.
const PHRASES = [{ start: 0, end: 2 }, { start: 4, end: 8 }];
function readyWithPhrases() {
    const od = createVocalOverdrive({ clock: createMeasureClock(beats()), phrases: PHRASES });
    od.phrase('Awesome', 0.5);
    od.phrase('Awesome', 0.6);
    return od;
}

test('the phrase guard is 0.25 s', () => {
    assert.equal(MIC_HIT_PHRASE_GUARD_S, 0.25);
});

test('a mic hit mid-phrase does not deploy', () => {
    const od = readyWithPhrases();
    assert.equal(od.micHit(1), false);
    assert.equal(od.micHit(2), false);         // at the phrase end it is still sung
    assert.deepEqual(od.stateAt(2), { fill: 0.5, active: false, ready: true });
});

test('a mic hit in the gap deploys', () => {
    const od = readyWithPhrases();
    assert.equal(od.micHit(3), true);
    assert.equal(od.isActiveAt(3), true);
});

test('a mic hit 0.1 s before the next phrase does not deploy; 0.25 s before does', () => {
    const od = readyWithPhrases();
    assert.equal(od.micHit(3.9), false);
    const od2 = readyWithPhrases();
    assert.equal(od2.micHit(4 - MIC_HIT_PHRASE_GUARD_S), true);
});

test('after the last phrase and with no phrases, a hit deploys', () => {
    const od = readyWithPhrases();
    assert.equal(od.micHit(9), true);
    const free = make();                       // no phrases given: no gate
    free.phrase('Awesome', 1);
    free.phrase('Awesome', 1.5);
    assert.equal(free.micHit(1.6), true);
});

test('reset reports whether it ended an active overdrive', () => {
    const od = make();
    assert.equal(od.reset(), false);
    for (const t of [1, 2, 3, 4]) od.phrase('Awesome', t);
    assert.equal(od.reset(), false);           // full but not active
    for (const t of [1, 2]) od.phrase('Awesome', t);
    od.micHit(3);
    assert.equal(od.reset(), true);
    assert.equal(od.reset(), false);
});

test('isActiveAt answers an earlier time from the activation history', () => {
    const od = make();
    for (const t of [1, 2]) od.phrase('Awesome', t);
    assert.equal(od.micHit(10), true);           // half a bar: 4 measures = 8 s
    assert.equal(od.stateAt(20).active, false);  // ran out at 18
    assert.equal(od.isActiveAt(9.9), false);     // before the deploy
    assert.equal(od.isActiveAt(10), true);
    assert.equal(od.isActiveAt(17.9), true);
    assert.equal(od.isActiveAt(18.1), false);    // after the drain ended it
    assert.equal(od.stateAt(19).fill, 0);        // stateAt still treats it as the latest
    od.reset();
    assert.equal(od.isActiveAt(12), false);      // reset clears the history
});
