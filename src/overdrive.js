/**
 * The vocal overdrive meter (KRB-8), with the YARG numbers in yarg-overdrive.js.
 *
 * Fill runs 0..1 of a full bar. A phrase rated Strong or better adds a
 * quarter (capped at a full bar, so a gain while active extends it). It is
 * ready when not active and at least half full; a mic hit deploys it only
 * then. While active it drains 1/8 bar per measure of song time and ends at 0.
 * Time only moves forward: an earlier `t` than one already seen counts as
 * the latest. Pure — no DOM.
 */
import { OVERDRIVE } from './yarg-overdrive.js';
import { earnsOverdrive } from './scoring.js';

const EMPTY_EPS = 1e-9;

export function createVocalOverdrive({ clock }) {
    let fill, active, lastT;

    function reset() {
        fill = 0;
        active = false;
        lastT = null;
    }
    reset();

    function advance(t) {
        if (!Number.isFinite(t) || (lastT !== null && t <= lastT)) return;
        if (active && lastT !== null) {
            fill -= (clock.measureAt(t) - clock.measureAt(lastT)) / OVERDRIVE.barMeasures;
            if (fill <= EMPTY_EPS) { fill = 0; active = false; }
        }
        lastT = t;
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
            if (!ready()) return false;
            active = true;
            return true;
        },
        stateAt(t) {
            advance(t);
            return { fill, active, ready: ready() };
        },
        isActiveAt(t) {
            advance(t);
            return active;
        },
        reset,
    };
}
