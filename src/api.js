/**
 * The public `window.lyricsKaraoke` object, built from closures over main.js's
 * module state. This file holds only the argument rules and event shapes; no
 * DOM, no `window`, no scoring maths (events forward the scorer verbatim).
 */

export const API_VERSION = 1;
export const PHRASE_EVENT = 'karaoke:phrase';
export const RESET_EVENT = 'karaoke:reset';

/** Overlay placement: fill a host's slot, or karaoke's own ribbon in #player. */
export function stripHostStyle(hosted) {
    return hosted
        ? { position: 'absolute', left: '0', right: '0', top: '0', bottom: '0', height: 'auto', pointerEvents: 'none', zIndex: '5' }
        : { position: 'absolute', left: '0', right: '0', top: '60px', bottom: '', height: '140px', pointerEvents: 'none', zIndex: '5' };
}

/** A scorer `advanceTo` event merged with the scorer's `snapshot()`. */
export function phraseEventDetail(event, snapshot) {
    return {
        phraseIndex: event.phraseIndex,
        rating: event.rating,
        accuracy: event.accuracy,
        points: event.points,
        multiplierBefore: event.multiplierBefore,
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
    });
}
