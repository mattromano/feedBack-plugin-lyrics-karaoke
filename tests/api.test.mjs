import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionOverrides } from '../src/overrides.js';
import {
    API_VERSION, PHRASE_EVENT, RESET_EVENT,
    stripHostStyle, phraseEventDetail, emitScoring, createKaraokeApi, OD_EVENTS,
} from '../src/api.js';

const SNAP = { score: 10, multiplier: 2, streak: 1, stars: 1, ratedCount: 1 };

function setup({ saved = 'medium' } = {}) {
    const log = [];
    const state = { mode: false, mic: 'off' };
    const overrides = createSessionOverrides({ getSavedDifficulty: () => saved });
    const deps = {
        overrides,
        mountStrip: (el) => { log.push(['mountStrip', el]); },
        setKaraokeMode: async (on) => { log.push(['setKaraokeMode', on]); state.mode = on; return on; },
        isKaraokeMode: () => state.mode,
        startMic: async () => { log.push(['startMic']); state.mic = 'listening'; },
        stopMic: () => { log.push(['stopMic']); state.mic = 'off'; },
        getMicState: () => state.mic,
        onDifficultyChanged: () => { log.push(['onDifficultyChanged']); },
        onDifficultyOverrideSet: () => { log.push(['onDifficultyOverrideSet']); },
        applyHearMyself: () => { log.push(['applyHearMyself']); },
        getSnapshot: () => ({ ...SNAP }),
        applyMicHitThreshold: () => { log.push(['applyMicHitThreshold']); },
    };
    return { api: createKaraokeApi(deps), log, state };
}

const count = (log, name) => log.filter((e) => e[0] === name).length;

test('constants', () => {
    assert.equal(API_VERSION, 1);
    assert.equal(PHRASE_EVENT, 'karaoke:phrase');
    assert.equal(RESET_EVENT, 'karaoke:reset');
});

test('stripHostStyle hosted fills its host; unhosted is karaoke\'s own placement', () => {
    assert.deepEqual(stripHostStyle(true), {
        position: 'absolute', left: '0', right: '0', top: '0', bottom: '0',
        height: 'auto', pointerEvents: 'none', zIndex: '5',
    });
    assert.deepEqual(stripHostStyle(false), {
        position: 'absolute', left: '0', right: '0', top: '60px', bottom: '',
        height: '140px', pointerEvents: 'none', zIndex: '5',
    });
});

test('phraseEventDetail merges the scorer event and snapshot verbatim', () => {
    const e = { phraseIndex: 3, rating: 'Strong', accuracy: 0.8, points: 1600, multiplierBefore: 2 };
    assert.deepEqual(phraseEventDetail(e, SNAP), {
        phraseIndex: 3, rating: 'Strong', accuracy: 0.8, points: 1600, multiplierBefore: 2,
        score: 10, multiplier: 2, streak: 1, stars: 1, ratedCount: 1,
    });
});

test('phraseEventDetail passes every scorer event field through; the snapshot wins the totals', () => {
    const e = { phraseIndex: 0, rating: 'Good', accuracy: 0.6, points: 600, multiplierBefore: 1, overdrive: 0.25, score: -1 };
    const d = phraseEventDetail(e, SNAP);
    assert.equal(d.overdrive, 0.25);
    assert.equal(d.score, 10);
});

test('emitScoring emits one karaoke:phrase per event, in order, and survives a throwing emit', () => {
    const events = [
        { phraseIndex: 0, rating: 'Good', accuracy: 0.6, points: 600, multiplierBefore: 1 },
        { phraseIndex: 1, rating: 'Strong', accuracy: 0.8, points: 1600, multiplierBefore: 2 },
    ];
    const seen = [];
    emitScoring((name, detail) => seen.push([name, detail.phraseIndex]), events, SNAP);
    assert.deepEqual(seen, [['karaoke:phrase', 0], ['karaoke:phrase', 1]]);

    let calls = 0;
    assert.doesNotThrow(() => emitScoring(() => { calls += 1; throw new Error('boom'); }, events, SNAP));
    assert.equal(calls, 2);
});

test('apiVersion is 1 and the object is frozen', () => {
    const { api } = setup();
    assert.equal(api.apiVersion, 1);
    assert.equal(Object.isFrozen(api), true);
});

test('mountStrip refuses a non-element', () => {
    const { api, log } = setup();
    assert.equal(api.mountStrip({}), false);
    assert.equal(api.mountStrip('x'), false);
    assert.equal(api.mountStrip(undefined), false);
    assert.deepEqual(log, []);
    assert.equal(api.mountStrip(null), true);
    assert.deepEqual(log, [['mountStrip', null]]);
    const el = { appendChild() {} };
    assert.equal(api.mountStrip(el), true);
    assert.equal(log[1][1], el);
});

test('setDifficulty re-scores only when the effective difficulty changes', () => {
    const { api, log } = setup({ saved: 'medium' });
    assert.equal(api.getDifficulty(), 'medium');
    assert.equal(api.setDifficulty('medium'), true);
    assert.equal(count(log, 'onDifficultyChanged'), 0);
    assert.equal(api.getDifficulty(), 'medium');
    assert.equal(api.setDifficulty('hard'), true);
    assert.equal(count(log, 'onDifficultyChanged'), 1);
    assert.equal(api.getDifficulty(), 'hard');
    assert.equal(api.setDifficulty('nope'), false);
    assert.equal(count(log, 'onDifficultyChanged'), 1);
    assert.equal(api.getDifficulty(), 'hard');
    assert.equal(api.setDifficulty(null), true);
    assert.equal(count(log, 'onDifficultyChanged'), 2);
    assert.equal(api.getDifficulty(), 'medium');
});

test('setDifficulty refreshes the override lock on every accepted call', () => {
    const { api, log } = setup({ saved: 'medium' });
    assert.equal(api.setDifficulty('medium'), true);
    assert.equal(count(log, 'onDifficultyOverrideSet'), 1);
    assert.equal(count(log, 'onDifficultyChanged'), 0);
    assert.equal(api.setDifficulty('nope'), false);
    assert.equal(count(log, 'onDifficultyOverrideSet'), 1);
    assert.equal(api.setDifficulty(null), true);
    assert.equal(count(log, 'onDifficultyOverrideSet'), 2);
    assert.equal(count(log, 'onDifficultyChanged'), 0);
});

test('setHearMyself applies only on a change', () => {
    const { api, log } = setup();
    assert.equal(api.getHearMyself(), true);
    assert.equal(api.setHearMyself(true), true);
    assert.equal(count(log, 'applyHearMyself'), 0);
    assert.equal(api.setHearMyself(false), true);
    assert.equal(count(log, 'applyHearMyself'), 1);
    assert.equal(api.getHearMyself(), false);
    assert.equal(api.setHearMyself('no'), false);
    assert.equal(count(log, 'applyHearMyself'), 1);
    assert.equal(api.setHearMyself(null), true);
    assert.equal(count(log, 'applyHearMyself'), 2);
    assert.equal(api.getHearMyself(), true);
});

test('score HUD hidden passes through', () => {
    const { api } = setup();
    assert.equal(api.isScoreHudHidden(), false);
    assert.equal(api.setScoreHudHidden(true), true);
    assert.equal(api.isScoreHudHidden(), true);
    assert.equal(api.setScoreHudHidden(1), false);
    assert.equal(api.isScoreHudHidden(), true);
});

test('startMic resolves the mic state after starting', async () => {
    const { api, log } = setup();
    assert.equal(api.getMicState(), 'off');
    assert.equal(await api.startMic(), 'listening');
    assert.equal(count(log, 'startMic'), 1);
    api.stopMic();
    assert.equal(count(log, 'stopMic'), 1);
    assert.equal(api.getMicState(), 'off');
});

test('setKaraokeMode coerces to a boolean', async () => {
    const { api, log } = setup();
    assert.equal(await api.setKaraokeMode(1), true);
    assert.deepEqual(log, [['setKaraokeMode', true]]);
    assert.equal(api.isKaraokeMode(), true);
    assert.equal(await api.setKaraokeMode(0), false);
    assert.deepEqual(log[1], ['setKaraokeMode', false]);
});

test('getScore returns the snapshot', () => {
    const { api } = setup();
    assert.deepEqual(api.getScore(), SNAP);
});

test('overdrive event names', () => {
    assert.deepEqual({ ...OD_EVENTS }, {
        gain: 'karaoke:od-gain', ready: 'karaoke:od-ready', activate: 'karaoke:od-activate',
        end: 'karaoke:od-end', micHit: 'karaoke:mic-hit',
    });
    assert.equal(Object.isFrozen(OD_EVENTS), true);
});

test('overdrive API: getOverdrive default, threshold override, shared detector', () => {
    const { api, log } = setup();
    assert.deepEqual(api.getOverdrive(), { fill: 0, active: false, ready: false });
    assert.equal(api.getMicHitThreshold(), -30);
    assert.equal(api.setMicHitThreshold(-24), true);
    assert.equal(api.getMicHitThreshold(), -24);
    assert.equal(count(log, 'applyMicHitThreshold'), 1);
    assert.equal(api.setMicHitThreshold('x'), false);
    assert.equal(count(log, 'applyMicHitThreshold'), 1);
    assert.equal(api.getMicHitThreshold(), -24);
    assert.equal(api.setMicHitThreshold(null), true);
    assert.equal(api.getMicHitThreshold(), -30);
    const d = api.micHit.createDetector({ thresholdDb: -30 });
    assert.equal(d.push(-60, 0), false);
    assert.equal(d.push(-28, 0.05), true);
    assert.equal(api.micHit.riseDb, 25);
    assert.equal(api.micHit.defaultDb, -30);
    assert.equal(api.micHit.minDb, -48);
    assert.equal(api.micHit.maxDb, -12);
    assert.equal(Object.isFrozen(api.micHit), true);
});

test('getOverdrive forwards the live meter', () => {
    const { api } = setup();
    const deps = { overrides: createSessionOverrides({ getSavedDifficulty: () => 'easy' }),
        getOverdrive: () => ({ fill: 0.5, active: false, ready: true }) };
    assert.deepEqual(createKaraokeApi(deps).getOverdrive(), { fill: 0.5, active: false, ready: true });
    assert.equal(typeof api.getOverdrive, 'function');
});

test('sameFile matches a name with its URL-encoded form', async () => {
    const { sameFile } = await import('../src/api.js');
    assert.equal(sameFile('A B.sloppak', 'A%20B.sloppak'), true);
    assert.equal(sameFile('A B.sloppak', 'A B.sloppak'), true);
    assert.equal(sameFile('A.sloppak', 'B.sloppak'), false);
    assert.equal(sameFile('', ''), false);
    assert.equal(sameFile('%E0%A4%A', '%E0%A4%A'), true);   // malformed escapes compare raw
});

test('registerKaraokePlayAs adds a Vocals entry for songs with vocal pitch', async () => {
    const { registerKaraokePlayAs } = await import('../src/api.js');
    const specs = [];
    const played = [];
    const off = registerKaraokePlayAs({ libraryCardActions: { register: (s) => { specs.push(s); return () => 'off'; } } },
        (fn) => { played.push(fn); return true; });
    assert.equal(off(), 'off');
    const s = specs[0];
    assert.equal(s.id, 'lyrics_karaoke.play-as');
    assert.equal(s.placement, 'play-as');
    assert.equal(s.applies({ filename: 'a', has_vocal_pitch: true }), true);
    assert.equal(s.applies({ filename: 'a', has_vocal_pitch: false }), false);
    s.run({ filename: 'a b' });
    assert.deepEqual(played, ['a b']);
    assert.equal(registerKaraokePlayAs({}, () => {}), null);
});
