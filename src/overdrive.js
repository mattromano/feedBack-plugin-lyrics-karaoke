/**
 * The vocal overdrive meter (KRB-8), with the YARG numbers in yarg-overdrive.js.
 *
 * Fill runs 0..1 of a full bar. A phrase rated Strong or better adds a
 * quarter (capped at a full bar, so a gain while active extends it). It is
 * ready when not active and at least half full; a mic hit deploys it only
 * then, and only in a gap between sung phrases (Rock Band's rule for vocals):
 * after the previous phrase's end and at least MIC_HIT_PHRASE_GUARD_S before
 * the next one's start, so a sung onset can't deploy it. While active it
 * drains 1/8 bar per measure of song time and ends at 0.
 * Time only moves forward: an earlier `t` than one already seen counts as
 * the latest, except that isActiveAt answers an earlier `t` from the
 * activation history, so a phrase is doubled by the state at its own end
 * even when it is rated after a later deploy or drain. Pure — no DOM.
 */
import { OVERDRIVE } from './yarg-overdrive.js';
import { earnsOverdrive } from './scoring.js';

const EMPTY_EPS = 1e-9;

// A mic hit this close before a phrase starts is the singer's first syllable, not a deploy.
export const MIC_HIT_PHRASE_GUARD_S = 0.25;

// Whether `t` falls inside a sung phrase (start − guard < t ≤ end).
function inPhrase(phrases, t) {
    for (const p of phrases) {
        if (p && t > p.start - MIC_HIT_PHRASE_GUARD_S && t <= p.end) return true;
    }
    return false;
}

// Empty a meter that is being reset or replaced. Returns whether that ends
// an overdrive (the meter was active, or the caller last saw it active), so
// the caller emits karaoke:od-end exactly once.
export function retireOverdrive(od, wasActive) {
    const ended = od ? od.reset() : false;
    return ended || !!wasActive;
}

export function createVocalOverdrive({ clock, phrases } = {}) {
    const phr = Array.isArray(phrases) ? phrases : [];
    let fill, active, lastT;
    // Activations as [{ from, to }]; `to` is null while the last one is open.
    let history;

    // Returns whether it ended an active overdrive.
    function reset() {
        const wasActive = !!active;
        fill = 0;
        active = false;
        lastT = null;
        history = [];
        return wasActive;
    }
    reset();

    function advance(t) {
        if (!Number.isFinite(t) || (lastT !== null && t <= lastT)) return;
        if (active && lastT !== null) {
            const fromM = clock.measureAt(lastT);
            const before = fill;
            fill -= (clock.measureAt(t) - fromM) / OVERDRIVE.barMeasures;
            if (fill <= EMPTY_EPS) {
                fill = 0;
                active = false;
                closeActivation(fromM + before * OVERDRIVE.barMeasures, t);
            }
        }
        lastT = t;
    }

    // The drain ran out at measure `m`, somewhere before `t`.
    function closeActivation(m, t) {
        const open = history[history.length - 1];
        if (!open || open.to !== null) return;
        const at = typeof clock.timeAtMeasure === 'function' ? clock.timeAtMeasure(m) : t;
        open.to = Number.isFinite(at) ? Math.max(open.from, Math.min(at, t)) : t;
    }

    function wasActiveAt(t) {
        return history.some((h) => t >= h.from && (h.to === null || t < h.to));
    }

    const ready = () => !active && fill >= OVERDRIVE.deployMin;

    return {
        phrase(rating, t) {
            advance(t);
            if (!earnsOverdrive(rating)) return false;
            fill = Math.min(1, fill + OVERDRIVE.phraseGain);
            return true;
        },
        micHit(t) {
            advance(t);
            if (!ready() || inPhrase(phr, t)) return false;
            active = true;
            history.push({ from: lastT ?? t, to: null });
            return true;
        },
        stateAt(t) {
            advance(t);
            return { fill, active, ready: ready() };
        },
        isActiveAt(t) {
            if (Number.isFinite(t) && lastT !== null && t < lastT) return wasActiveAt(t);
            advance(t);
            return active;
        },
        reset,
    };
}
