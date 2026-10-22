/**
 * The public `window.lyricsKaraoke` object, built from closures over main.js's
 * module state. This file holds only the argument rules and event shapes; no
 * DOM, no `window`, no scoring maths (events forward the scorer verbatim).
 */

import { DEFAULT_MIC_HIT_DB, MIC_HIT_MIN_DB, MIC_HIT_MAX_DB, createMicHitDetector } from './mic-hit.js';
import { MIC_HIT_RISE_DB } from './yarg-overdrive.js';

export const API_VERSION = 1;
export const PHRASE_EVENT = 'karaoke:phrase';
export const RESET_EVENT = 'karaoke:reset';
export const OD_EVENTS = Object.freeze({
    gain: 'karaoke:od-gain',
    ready: 'karaoke:od-ready',
    activate: 'karaoke:od-activate',
    end: 'karaoke:od-end',
    micHit: 'karaoke:mic-hit',
});

const NO_OVERDRIVE = Object.freeze({ fill: 0, active: false, ready: false });

// The mic-hit rule, shared so a host's sensitivity check matches what fires in the song.
const MIC_HIT = Object.freeze({
    riseDb: MIC_HIT_RISE_DB,
    defaultDb: DEFAULT_MIC_HIT_DB,
    minDb: MIC_HIT_MIN_DB,
    maxDb: MIC_HIT_MAX_DB,
    createDetector: (opts) => createMicHitDetector(opts),
});

/** Overlay placement: fill a host's slot, or karaoke's own ribbon in #player. */
export function stripHostStyle(hosted) {
    return hosted
        ? { position: 'absolute', left: '0', right: '0', top: '0', bottom: '0', height: 'auto', pointerEvents: 'none', zIndex: '5' }
        : { position: 'absolute', left: '0', right: '0', top: '60px', bottom: '', height: '140px', pointerEvents: 'none', zIndex: '5' };
}

/**
 * A scorer `advanceTo` event merged with the scorer's `snapshot()`. Every
 * event field passes through; the snapshot's running totals win.
 */
export function phraseEventDetail(event, snapshot) {
    return {
        ...event,
        score: snapshot.score,
        multiplier: snapshot.multiplier,
        streak: snapshot.streak,
        stars: snapshot.stars,
        ratedCount: snapshot.ratedCount,
    };
}

/** Emit one PHRASE_EVENT per scorer event, in order; a throwing `emit` is swallowed. */
export function emitScoring(emit, events, snapshot) {
    for (const e of events) {
        try { emit(PHRASE_EVENT, phraseEventDetail(e, snapshot)); } catch { /* a listener's error is not karaoke's */ }
    }
}

const isHost = (el) => el === null
    || (typeof el === 'object' && typeof el.appendChild === 'function');

export function createKaraokeApi(deps) {
    const { overrides } = deps;
    return Object.freeze({
        apiVersion: API_VERSION,
        mountStrip(el) {
            if (!isHost(el)) return false;
            deps.mountStrip(el);
            return true;
        },
        setKaraokeMode: (on) => deps.setKaraokeMode(!!on),
        isKaraokeMode: () => deps.isKaraokeMode(),
        async startMic() {
            await deps.startMic();
            return deps.getMicState();
        },
        stopMic() { deps.stopMic(); },
        getMicState: () => deps.getMicState(),
        setDifficulty(id) {
            const before = overrides.difficulty();
            if (!overrides.setDifficulty(id)) return false;
            if (overrides.difficulty() !== before) deps.onDifficultyChanged();
            // The lock on karaoke's own pickers follows set/clear, not the value.
            deps.onDifficultyOverrideSet();
            return true;
        },
        getDifficulty: () => overrides.difficulty(),
        setHearMyself(on) {
            const before = overrides.hearMyself();
            if (!overrides.setHearMyself(on)) return false;
            if (overrides.hearMyself() !== before) deps.applyHearMyself();
            return true;
        },
        getHearMyself: () => overrides.hearMyself(),
        setScoreHudHidden: (hidden) => overrides.setScoreHudHidden(hidden),
        isScoreHudHidden: () => overrides.scoreHudHidden(),
        getScore: () => deps.getSnapshot(),
        getOverdrive: () => (typeof deps.getOverdrive === 'function' ? deps.getOverdrive() : { ...NO_OVERDRIVE }),
        setMicHitThreshold(db) {
            if (!overrides.setMicHitDb(db)) return false;
            if (typeof deps.applyMicHitThreshold === 'function') deps.applyMicHitThreshold();
            return true;
        },
        getMicHitThreshold: () => overrides.micHitDb() ?? DEFAULT_MIC_HIT_DB,
        micHit: MIC_HIT,
        // Play a library song (unencoded filename) and open it in karaoke mode once loaded.
        playKaraoke: (filename) => (typeof deps.playKaraoke === 'function' ? deps.playKaraoke(filename) : false),
    });
}

/** Same library file, whether either name is URL-encoded or not. */
export function sameFile(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
    const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
    return a === b || dec(a) === dec(b);
}

/**
 * Register the Vocals entry of core's "Play as" menus (libraryCardActions,
 * placement 'play-as') for songs with vocal pitch. `play(filename)` starts it.
 * Returns the unregister function, or null on a core without the registry.
 */
export function registerKaraokePlayAs(fb, play) {
    const reg = fb && fb.libraryCardActions;
    if (!reg || typeof reg.register !== 'function') return null;
    return reg.register({
        id: 'lyrics_karaoke.play-as', pluginId: 'lyrics_karaoke', label: 'Vocals', hint: 'karaoke · mic',
        group: 'Vocals', placement: 'play-as', order: 35,
        applies: (song) => !!(song && song.filename && song.has_vocal_pitch === true),
        run: (song) => play(song.filename),
    });
}
