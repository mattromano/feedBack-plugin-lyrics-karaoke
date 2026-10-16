import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPhrases, PHRASE_GAP_S, PHRASE_MAX_S } from '../src/phrases.js';

const tok = (t, d, w, midi) => (midi === undefined ? { t, d, w } : { t, d, w, midi });

test('splits after a + line-end suffix', () => {
    const p = buildPhrases([tok(0, 0.4, 'Hel-', 60), tok(0.5, 0.4, 'lo+', 62), tok(1.0, 0.4, 'world+', 64)]);
    assert.deepEqual(p.map((x) => x.tokenIdxs), [[0, 1], [2]]);
    assert.equal(p[0].start, 0);
    assert.ok(Math.abs(p[0].end - 0.9) < 1e-9);
});

test('splits on a gap longer than 4 s with no markers', () => {
    const p = buildPhrases([tok(0, 0.5, 'a', 60), tok(1, 0.5, 'b', 60), tok(6, 0.5, 'c', 60)]);
    assert.deepEqual(p.map((x) => x.tokenIdxs), [[0, 1], [2]]);
    assert.equal(PHRASE_GAP_S, 4.0);
});

test('caps long phrases at 10s', () => {
    const tokens = Array.from({ length: 30 }, (_, i) => tok(i * 0.5, 0.4, 'la', 60));
    const p = buildPhrases(tokens);
    assert.equal(PHRASE_MAX_S, 10.0);
    for (const ph of p) assert.ok(ph.end - ph.start <= 10.0 + 1e-9, `${ph.start}-${ph.end}`);
    const all = p.flatMap((x) => x.tokenIdxs);
    assert.deepEqual(all, Array.from({ length: 30 }, (_, i) => i));
});

test('pitchedIdxs leaves out tokens without midi', () => {
    const p = buildPhrases([tok(0, 0.4, 'oh', 60), tok(0.5, 0.4, 'hey'), tok(1, 0.4, 'yeah+', 64)]);
    assert.deepEqual(p[0].tokenIdxs, [0, 1, 2]);
    assert.deepEqual(p[0].pitchedIdxs, [0, 2]);
});

test('skips null or timeless tokens and handles empty input', () => {
    assert.deepEqual(buildPhrases([]), []);
    const p = buildPhrases([null, { w: 'x' }, tok(1, 0.5, 'ok+', 60)]);
    assert.deepEqual(p.map((x) => x.tokenIdxs), [[2]]);
});
