import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_MIC_HIT_DB, MIC_HIT_MIN_DB, MIC_HIT_MAX_DB, MIC_HIT_REFRACTORY_S,
    levelDb, clampMicHitDb, createMicHitDetector,
} from '../src/mic-hit.js';
import { MIC_HIT_RISE_DB, OVERDRIVE } from '../src/yarg-overdrive.js';

// Silent fakes only: the detector is fed plain dB numbers, nothing touches audio.

test('constants', () => {
    assert.equal(DEFAULT_MIC_HIT_DB, -30);
    assert.equal(MIC_HIT_MIN_DB, -48);
    assert.equal(MIC_HIT_MAX_DB, -12);
    assert.equal(MIC_HIT_REFRACTORY_S, 0.3);
    assert.equal(MIC_HIT_RISE_DB, 25);
    assert.deepEqual({ ...OVERDRIVE }, { phraseGain: 0.25, deployMin: 0.5, barMeasures: 8, multiplier: 2 });
    assert.equal(Object.isFrozen(OVERDRIVE), true);
});

test('a 25 dB jump above the threshold is a hit; the first frame never is', () => {
    const d = createMicHitDetector();
    assert.equal(d.push(-20, 0), false);
    const e = createMicHitDetector();
    assert.equal(e.push(-60, 0.05), false);
    assert.equal(e.push(-28, 0.1), true);
});

test('under the rise or the threshold is no hit', () => {
    const d = createMicHitDetector();
    d.push(-60, 0);
    assert.equal(d.push(-36, 0.05), false);   // 24 dB rise
    const e = createMicHitDetector({ thresholdDb: -30 });
    e.push(-70, 0);
    assert.equal(e.push(-40, 0.05), false);   // 30 dB rise, below the threshold
});

test('refractory 0.3 s', () => {
    const d = createMicHitDetector();
    d.push(-60, 0);
    assert.equal(d.push(-28, 0.1), true);
    d.push(-60, 0.2);
    assert.equal(d.push(-28, 0.1 + 0.2), false);
    d.push(-60, 0.35);
    assert.equal(d.push(-28, 0.1 + 0.31), true);
});

test('levelDb and clamping', () => {
    assert.equal(levelDb(0), -100);
    assert.equal(levelDb(0.01), -20);
    assert.equal(levelDb(NaN), -100);
    assert.equal(levelDb(1e-20), -100);
    assert.equal(clampMicHitDb(-60), -48);
    assert.equal(clampMicHitDb(-5), -12);
    assert.equal(clampMicHitDb(-24.4), -24);
    assert.equal(clampMicHitDb('x'), null);
    assert.equal(clampMicHitDb(NaN), null);
    assert.equal(clampMicHitDb(null), null);
    const d = createMicHitDetector();
    assert.equal(d.setThreshold('x'), false);
    assert.equal(d.threshold(), -30);
    assert.equal(d.setThreshold(-60), true);
    assert.equal(d.threshold(), -48);
});

test('reset forgets the previous frame and the last hit', () => {
    const d = createMicHitDetector();
    d.push(-60, 0);
    assert.equal(d.push(-28, 0.1), true);
    d.reset();
    assert.equal(d.push(-28, 0.15), false);   // first frame again
    d.reset();
    d.push(-60, 0.16);
    assert.equal(d.push(-28, 0.2), true);     // no refractory carried over
});
