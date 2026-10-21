/**
 * Session overrides another plugin (Build-a-Band) can set on karaoke: vocal
 * difficulty, hear-myself (the voice monitor), hiding the score pill and the
 * mic-hit threshold that deploys overdrive. They
 * are never persisted; `null` clears an override back to karaoke's own value.
 * Pure — no DOM — so Node tests can load it.
 */
import { DIFFICULTIES } from './pitch.js';
import { clampMicHitDb } from './mic-hit.js';

export function createSessionOverrides({ getSavedDifficulty }) {
    let difficultyId = null;
    let hear = null;
    let hudHidden = false;
    let micHit = null;

    return {
        difficulty: () => (difficultyId !== null ? difficultyId : getSavedDifficulty()),
        hasDifficulty: () => difficultyId !== null,
        setDifficulty(id) {
            if (id === null) { difficultyId = null; return true; }
            if (typeof id !== 'string' || !Object.prototype.hasOwnProperty.call(DIFFICULTIES, id)) return false;
            difficultyId = id;
            return true;
        },
        hearMyself: () => (hear !== null ? hear : true),
        setHearMyself(on) {
            if (on !== null && typeof on !== 'boolean') return false;
            hear = on;
            return true;
        },
        scoreHudHidden: () => hudHidden,
        setScoreHudHidden(hidden) {
            if (typeof hidden !== 'boolean') return false;
            hudHidden = hidden;
            return true;
        },
        micHitDb: () => micHit,
        setMicHitDb(db) {
            if (db === null) { micHit = null; return true; }
            const v = clampMicHitDb(db);
            if (v === null) return false;
            micHit = v;
            return true;
        },
        clear() {
            difficultyId = null;
            hear = null;
            hudHidden = false;
            micHit = null;
        },
    };
}
