/**
 * Split a song's syllable tokens into scoring phrases.
 *
 * A phrase closes after a syllable whose text ends in `+` (the feedpak
 * line-end marker), before a gap longer than PHRASE_GAP_S, or before the
 * token that would stretch it past PHRASE_MAX_S — transcribed lyrics often
 * carry no `+` markers at all.
 */

export const PHRASE_GAP_S = 4.0;
export const PHRASE_MAX_S = 10.0;

export function buildPhrases(tokens) {
    const phrases = [];
    let cur = null;
    let prevEnd = -Infinity;
    let closeAfterPrev = false;

    const flush = () => { if (cur) phrases.push(cur); cur = null; };

    (tokens || []).forEach((tok, i) => {
        if (!tok || typeof tok.t !== 'number') return;
        const end = tok.t + (tok.d || 0);
        if (cur && (closeAfterPrev || tok.t - prevEnd > PHRASE_GAP_S || end - cur.start > PHRASE_MAX_S)) {
            flush();
        }
        if (!cur) cur = { start: tok.t, end, tokenIdxs: [], pitchedIdxs: [] };
        cur.tokenIdxs.push(i);
        if (typeof tok.midi === 'number') cur.pitchedIdxs.push(i);
        cur.end = Math.max(cur.end, end);
        prevEnd = end;
        closeAfterPrev = typeof tok.w === 'string' && tok.w.endsWith('+');
    });
    flush();
    return phrases;
}
