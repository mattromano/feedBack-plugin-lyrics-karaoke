import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionOverrides } from '../src/overrides.js';

function make() {
    const saved = { d: 'easy' };
    const o = createSessionOverrides({ getSavedDifficulty: () => saved.d });
    return { saved, o };
}

test('difficulty falls back to the saved one', () => {
    const { saved, o } = make();
    assert.equal(o.difficulty(), 'easy');
    assert.equal(o.hasDifficulty(), false);
    saved.d = 'hard';
    assert.equal(o.difficulty(), 'hard');
});

test('an override wins and null clears it', () => {
    const { o } = make();
    assert.equal(o.setDifficulty('expert'), true);
    assert.equal(o.difficulty(), 'expert');
    assert.equal(o.hasDifficulty(), true);
    assert.equal(o.setDifficulty(null), true);
    assert.equal(o.difficulty(), 'easy');
    assert.equal(o.hasDifficulty(), false);
});

test('unknown difficulty ids are refused', () => {
    const { o } = make();
    o.setDifficulty('hard');
    assert.equal(o.setDifficulty('beginner'), false);
    assert.equal(o.setDifficulty(''), false);
    assert.equal(o.setDifficulty(3), false);
    assert.equal(o.setDifficulty('toString'), false);
    assert.equal(o.difficulty(), 'hard');
    assert.equal(o.hasDifficulty(), true);
});

test('hear-myself defaults on, takes booleans or null', () => {
    const { o } = make();
    assert.equal(o.hearMyself(), true);
    assert.equal(o.setHearMyself(false), true);
    assert.equal(o.hearMyself(), false);
    assert.equal(o.setHearMyself('off'), false);
    assert.equal(o.hearMyself(), false);
    assert.equal(o.setHearMyself(null), true);
    assert.equal(o.hearMyself(), true);
});

test('score HUD hidden toggles and clear resets everything', () => {
    const { o } = make();
    assert.equal(o.scoreHudHidden(), false);
    assert.equal(o.setScoreHudHidden(true), true);
    assert.equal(o.scoreHudHidden(), true);
    assert.equal(o.setScoreHudHidden('yes'), false);
    assert.equal(o.scoreHudHidden(), true);
    o.setDifficulty('hard');
    o.setHearMyself(false);
    o.clear();
    assert.equal(o.scoreHudHidden(), false);
    assert.equal(o.hasDifficulty(), false);
    assert.equal(o.hearMyself(), true);
});

test('mic-hit threshold override clamps, clears and refuses junk', () => {
    const { o } = make();
    assert.equal(o.micHitDb(), null);
    assert.equal(o.setMicHitDb(-60), true);
    assert.equal(o.micHitDb(), -48);
    assert.equal(o.setMicHitDb(-24.4), true);
    assert.equal(o.micHitDb(), -24);
    assert.equal(o.setMicHitDb(null), true);
    assert.equal(o.micHitDb(), null);
    assert.equal(o.setMicHitDb('x'), false);
    assert.equal(o.setMicHitDb(undefined), false);
    assert.equal(o.micHitDb(), null);
    o.setMicHitDb(-20);
    o.clear();
    assert.equal(o.micHitDb(), null);
});
