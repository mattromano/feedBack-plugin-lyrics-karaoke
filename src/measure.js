/**
 * Song time ↔ measures, for draining the overdrive bar.
 *
 * Measure lines come from `highway.getBeats()` (`[{time, measure}]`, where
 * `measure >= 0` marks a downbeat). With fewer than two downbeats, every 4th
 * beat starts a measure; with fewer than two of those, a measure is 2 s from
 * time 0 (120 BPM in 4/4, the drums engine's fallback). Between lines the
 * measure is linear; before the first and after the last it is extrapolated
 * from the nearest measure's length. Pure — no DOM.
 */

const FALLBACK_MEASURE_S = 2;
const BEATS_PER_MEASURE = 4;

function lineTimes(beats) {
    const list = (Array.isArray(beats) ? beats : [])
        .filter((b) => b && Number.isFinite(b.time))
        .sort((a, b) => a.time - b.time);
    const dedupe = (times) => times.filter((t, i) => i === 0 || t > times[i - 1]);
    const downbeats = dedupe(list.filter((b) => typeof b.measure === 'number' && b.measure >= 0).map((b) => b.time));
    if (downbeats.length >= 2) return downbeats;
    const everyFourth = dedupe(list.map((b) => b.time)).filter((_, i) => i % BEATS_PER_MEASURE === 0);
    if (everyFourth.length >= 2) return everyFourth;
    return null;
}

export function createMeasureClock(beats) {
    const lines = lineTimes(beats);
    if (!lines) {
        return {
            measureAt: (t) => t / FALLBACK_MEASURE_S,
            timeAtMeasure: (m) => m * FALLBACK_MEASURE_S,
        };
    }
    const last = lines.length - 1;

    // Index of the segment [lines[i], lines[i+1]] used for t (clamped to the ends).
    function segmentAt(t) {
        let lo = 0, hi = last - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (lines[mid] <= t) lo = mid; else hi = mid - 1;
        }
        return lo;
    }

    return {
        measureAt(t) {
            const i = segmentAt(t);
            return i + (t - lines[i]) / (lines[i + 1] - lines[i]);
        },
        timeAtMeasure(m) {
            const i = Math.min(last - 1, Math.max(0, Math.floor(m)));
            return lines[i] + (m - i) * (lines[i + 1] - lines[i]);
        },
    };
}
