/**
 * Mic-hit detector: a clap or shout into the mic, used to deploy overdrive.
 * It only reads frame levels (dBFS numbers); it never touches audio nodes or
 * any output. Pure — no DOM, no Web Audio — so Node tests and the
 * RockHeroSmith sensitivity check share this exact rule.
 *
 * A hit: level ≥ threshold AND level − previous frame's level ≥ the rise
 * (25 dB) AND at least the refractory time since the last hit. The first
 * frame never hits.
 */
import { MIC_HIT_RISE_DB } from './yarg-overdrive.js';

export const DEFAULT_MIC_HIT_DB = -30;
export const MIC_HIT_MIN_DB = -48;
export const MIC_HIT_MAX_DB = -12;
export const MIC_HIT_REFRACTORY_S = 0.3;

const FLOOR_DB = -100;

/** Frame level in dBFS from a mean square; −100 for silence or junk. */
export function levelDb(meanSquare) {
    if (!Number.isFinite(meanSquare) || meanSquare <= 0) return FLOOR_DB;
    return Math.max(FLOOR_DB, 10 * Math.log10(meanSquare));
}

/** A whole-dB threshold inside the allowed range, or null for anything not a finite number. */
export function clampMicHitDb(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    return Math.min(MIC_HIT_MAX_DB, Math.max(MIC_HIT_MIN_DB, Math.round(v)));
}

export function createMicHitDetector({
    thresholdDb = DEFAULT_MIC_HIT_DB,
    riseDb = MIC_HIT_RISE_DB,
    refractoryS = MIC_HIT_REFRACTORY_S,
} = {}) {
    let threshold = clampMicHitDb(thresholdDb) ?? DEFAULT_MIC_HIT_DB;
    let prevDb = null;
    let lastHitT = -Infinity;

    return {
        push(db, t) {
            const level = Number.isFinite(db) ? db : FLOOR_DB;
            const hit = prevDb !== null
                && level >= threshold
                && level - prevDb >= riseDb
                && t - lastHitT >= refractoryS;
            prevDb = level;
            if (hit) lastHitT = t;
            return hit;
        },
        setThreshold(db) {
            const v = clampMicHitDb(db);
            if (v === null) return false;
            threshold = v;
            return true;
        },
        threshold: () => threshold,
        reset() {
            prevDb = null;
            lastHitT = -Infinity;
        },
    };
}
