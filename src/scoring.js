/**
 * Rock Band–style vocal scoring.
 *
 * Mic samples credit the pitched syllable under the (latency-corrected)
 * playhead in song-seconds, so slow-speed practice scores the same as
 * full speed and silence earns nothing. When the playhead passes a phrase
 * (plus a short grace), the phrase is rated, points are awarded at the
 * current multiplier, and the streak/multiplier update.
 */

import { DIFFICULTIES, DEFAULT_DIFFICULTY, pitchClassCents, sampleCredit } from './pitch.js';

export const RATINGS = ['Awesome', 'Strong', 'Good', 'OK', 'Messy', 'Awful'];
const RATING_FLOORS = [0.90, 0.75, 0.55, 0.35, 0.15, -Infinity];
const STREAK_RATINGS = new Set(['Awesome', 'Strong', 'Good']);
const STAR_FLOORS = [0.20, 0.40, 0.60, 0.75, 0.90];

const PHRASE_GRACE_S = 0.25;
const MAX_SAMPLE_DT_S = 0.1;    // caps credit across dropouts
const FIRST_SAMPLE_DT_S = 0.05; // nominal detector cadence
const PAUSE_EPSILON_S = 1e-3;
const MAX_MULTIPLIER = 4;
const POINTS_PER_PHRASE = 1000;

export function rateAccuracy(acc) {
    for (let i = 0; i < RATINGS.length; i++) {
        if (acc >= RATING_FLOORS[i]) return RATINGS[i];
    }
    return 'Awful';
}

export function starsFor(meanAcc) {
    if (meanAcc == null) return 0;
    let stars = 0;
    for (const floor of STAR_FLOORS) if (meanAcc >= floor) stars++;
    return stars;
}

export function createScorer({ tokens, phrases, difficulty }) {
    const diff = DIFFICULTIES[difficulty] || DIFFICULTIES[DEFAULT_DIFFICULTY];
    const toks = Array.isArray(tokens) ? tokens : [];
    const phr = Array.isArray(phrases) ? phrases : [];

    let credited;       // Map tokenIdx → credited song-seconds
    let prevT;
    let lastAdvanceT;   // latest time passed to advanceTo, for seek detection
    let startedAt;      // when this pass began; phrases already under way by then aren't rated
    let nextPhrase;     // phrases are time-ordered; everything before this is finalized
    let score, streak, multiplier, accSum, ratedCount;

    function reset() {
        credited = new Map();
        prevT = null;
        lastAdvanceT = null;
        startedAt = null;
        nextPhrase = 0;
        score = 0;
        streak = 0;
        multiplier = 1;
        accSum = 0;
        ratedCount = 0;
    }
    reset();

    function activeToken(t) {
        let best = -1;
        let bestStart = -Infinity;
        for (let i = 0; i < toks.length; i++) {
            const tok = toks[i];
            if (!tok || typeof tok.t !== 'number' || typeof tok.midi !== 'number') continue;
            if (t < tok.t || t >= tok.t + (tok.d || 0)) continue;
            if (tok.t > bestStart) { bestStart = tok.t; best = i; }
        }
        return best;
    }

    function addSample({ t, midi }) {
        if (prevT !== null && t < prevT - PAUSE_EPSILON_S) reset();
        if (startedAt === null) startedAt = t;
        const dt = prevT === null ? FIRST_SAMPLE_DT_S : t - prevT;
        prevT = prevT === null ? t : Math.max(prevT, t);
        if (dt <= PAUSE_EPSILON_S) return;
        const idx = activeToken(t);
        if (idx < 0) return;
        const credit = sampleCredit(pitchClassCents(midi, toks[idx].midi), diff.toleranceCents);
        credited.set(idx, (credited.get(idx) || 0) + credit * Math.min(dt, MAX_SAMPLE_DT_S));
    }

    function accuracyOf(idx) {
        const d = toks[idx].d || 0;
        if (d <= 0) return 0;
        return Math.min(1, (credited.get(idx) || 0) / (d * diff.fill));
    }

    function tokenAccuracy(idx) {
        if (!credited.has(idx)) return null;
        return accuracyOf(idx);
    }

    function advanceTo(t) {
        // A backward jump (seek, replay, practice loop) starts a new pass.
        if (lastAdvanceT !== null && t < lastAdvanceT - PAUSE_EPSILON_S) reset();
        lastAdvanceT = lastAdvanceT === null ? t : Math.max(lastAdvanceT, t);
        if (startedAt === null) startedAt = t;
        const events = [];
        while (nextPhrase < phr.length && phr[nextPhrase].end + PHRASE_GRACE_S <= t) {
            const phraseIndex = nextPhrase++;
            // Joined after this phrase had started (mic turned on mid-song,
            // or a seek landed mid-phrase): leave it unrated rather than
            // calling the half you heard Awful and breaking the streak.
            if (phr[phraseIndex].start + PHRASE_GRACE_S < startedAt) continue;
            const pitched = phr[phraseIndex].pitchedIdxs || [];
            let wSum = 0, aSum = 0;
            for (const idx of pitched) {
                const d = toks[idx].d || 0;
                wSum += d;
                aSum += d * accuracyOf(idx);
            }
            if (wSum <= 0) continue;  // nothing to sing: no rating, streak untouched
            const accuracy = aSum / wSum;
            const rating = rateAccuracy(accuracy);
            const multiplierBefore = multiplier;
            const points = Math.round(POINTS_PER_PHRASE * accuracy) * multiplierBefore;
            score += points;
            accSum += accuracy;
            ratedCount += 1;
            streak = STREAK_RATINGS.has(rating) ? streak + 1 : 0;
            multiplier = 1 + Math.min(streak, MAX_MULTIPLIER - 1);
            events.push({ phraseIndex, rating, accuracy, points, multiplierBefore });
        }
        return events;
    }

    function snapshot() {
        return {
            score,
            multiplier,
            streak,
            stars: starsFor(ratedCount ? accSum / ratedCount : null),
            ratedCount,
        };
    }

    return { addSample, advanceTo, reset, tokenAccuracy, snapshot };
}
