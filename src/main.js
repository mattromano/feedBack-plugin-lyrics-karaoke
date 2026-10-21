/**
 * Lyrics Karaoke plugin — front-end (module entry body; screen.js imports this).
 *
 * Two responsibilities, one IIFE:
 *
 *  1. **Setup screen** ("Lyrics Karaoke" in the nav). A wizard that
 *     picks a song, shows what's missing (vocals stem / synced lyrics /
 *     pitch contour), and runs whatever stages are needed to make the
 *     song karaoke-ready. The setup-screen entry points are exposed on
 *     `window.lk*` because screen.html uses inline `onclick=` handlers.
 *
 *  2. **In-player overlay**. When the user opens a sloppak song with
 *     pitch data and toggles "Karaoke" in the player controls, we draw
 *     a horizontal pitch ribbon (one bar per syllable, vertically
 *     positioned by MIDI pitch, with syllable text below and a sweeping
 *     playhead) on a fixed-position canvas above the highway.
 *
 * The merge consumes the previous standalone "Lyrics Sync" plugin —
 * its alignment + save endpoints now live on this plugin. The old
 * lyrics_sync directory remains as a redirect stub for users with
 * bookmarks pointing at it.
 */
import { DIFFICULTIES, freqToMidi, midiToName, yinDetect, pitchClassCents, foldSticky, VOCAL_MIN_HZ, VOCAL_MAX_HZ, VOCAL_CONFIDENCE, monitorGainFor, isHowling } from './pitch.js';
import {
    getDifficulty, setDifficulty, getDeviceId, setDeviceId, getLatencyMs, setLatencyMs,
    listInputDevices, micConstraints, isDeviceMissingError, micSongTime, savedDeviceLabel, micWarnings,
    buildMicOptions, micStartError, SHOW_MIC_NAMES, getMonitorVolume, setMonitorVolume, monitorSinkId,
} from './prefs.js';
import { buildPhrases } from './phrases.js';
import { createScorer } from './scoring.js';
import { createSessionOverrides } from './overrides.js';
import { createKaraokeApi, stripHostStyle, emitScoring, RESET_EVENT } from './api.js';

(function () {
    'use strict';

    if (typeof window === 'undefined') return;

    // ── Per-song state ─────────────────────────────────────────────────
    let currentSong = null;          // {filename, format, ...} from window.slopsmith
    let status = null;               // last /status payload
    let pitchData = null;            // {tokens: [{t, d, w, midi?}, ...]}
    let tokenIndexMap = new Map();   // tok → index into pitchData.tokens; rebuilt on each load
    let songPitchRange = null;       // {lo, hi} fixed across the song so bars don't shift vertically as the window scrolls
    let scorer = null;               // createScorer() for the current song + difficulty
    let lastRating = null;           // {text, at} — most recent phrase rating, for the HUD pop-up
    let karaokeMode = false;         // user toggle
    let savedShowLyrics = true;      // restore on toggle off
    let generating = false;          // suppress double-clicks during /generate
    let inflightFetch = 0;           // monotonic token; stale fetches drop their result
    let songLoad = null;             // onSongLoaded's in-flight body, awaited by the API's setKaraokeMode
    let songLoadFor = null;          // filename songLoad is loading
    // Session overrides another plugin (Build-a-Band) sets through
    // window.lyricsKaraoke. Never persisted; null clears.
    const overrides = createSessionOverrides({ getSavedDifficulty: getDifficulty });

    // ── DOM refs ───────────────────────────────────────────────────────
    let toggleBtn = null;
    let overlayEl = null;            // wrapper div that hosts the canvas
    let stripHost = null;            // element another plugin mounted the strip in (null = #player)
    let canvas = null;
    let ctx = null;
    let rafHandle = null;
    let resizeObserver = null;

    // ── Constants ──────────────────────────────────────────────────────
    const VISIBLE_SECONDS = 6.0;     // window of upcoming syllables shown
    const PLAYHEAD_FRAC = 0.18;      // playhead x as fraction of canvas width
    const RIBBON_BG = 'rgba(8, 8, 14, 0.78)';
    const BAR_COLOR_DIM = 'rgba(120, 80, 230, 0.55)';
    const BAR_COLOR_FILL = '#e8c040';
    const BAR_COLOR_ACTIVE = '#ffe080';
    const PLAYHEAD_COLOR = 'rgba(255, 255, 255, 0.85)';
    const TEXT_COLOR = '#f4f4ff';
    const TEXT_COLOR_PAST = 'rgba(160,170,200,0.9)';
    const MIN_PITCH_SPAN_SEMITONES = 7;  // never collapse the strip flatter than a 5th
    const BAR_PAD_PX = 2;
    const BAR_RADIUS = 4;

    // Centralized class strings — every render path picks one of these so
    // the disabled/enabled visual state always matches the .disabled flag.
    // Spelled out as plain `opacity-*` / `cursor-not-allowed` rather than
    // Tailwind's `disabled:` modifier prefix because the modifier only
    // takes effect when the rule is in the class list AND the disabled
    // attribute is set; rebuilding the class string per render is more
    // predictable than relying on conditional Tailwind variants.
    const BTN_CLASS_DISABLED =
        'px-3 py-1.5 bg-dark-600 rounded-lg text-xs text-gray-500 transition ' +
        'opacity-40 cursor-not-allowed';
    const BTN_CLASS_PROMPT =
        'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-300 transition';
    const BTN_CLASS_ACTIVE =
        'px-3 py-1.5 bg-yellow-900/40 hover:bg-yellow-900/60 rounded-lg text-xs text-yellow-200 transition';

    // ── Utilities ──────────────────────────────────────────────────────

    function safeFetch(url, opts) {
        // Wrap fetch with a uniform error shape so callers don't have to
        // remember "did fetch reject or was it a 4xx?"
        return fetch(url, opts).then(async (r) => {
            const text = await r.text();
            let body = null;
            try { body = text ? JSON.parse(text) : null; } catch (_) { body = { error: text }; }
            return { ok: r.ok, status: r.status, body };
        });
    }

    function syllableText(s) {
        const t = (s && s.w) || '';
        return (t.endsWith('+') || t.endsWith('-')) ? t.slice(0, -1) : t;
    }

    function isSloppakSong(song) {
        if (!song || !song.filename) return false;
        // The server emits format='sloppak' on song_info; fall back to
        // the filename suffix in case format isn't populated yet (the
        // first song:loaded fires while song_info is still arriving).
        if (song.format === 'sloppak') return true;
        return /\.sloppak(\/)?$/i.test(String(song.filename));
    }

    // ── Status / data fetch ────────────────────────────────────────────

    async function fetchStatus(filename) {
        const token = ++inflightFetch;
        const url = `/api/plugins/lyrics_karaoke/status?filename=${encodeURIComponent(filename)}`;
        const res = await safeFetch(url);
        if (token !== inflightFetch) return null;  // a newer song took over
        if (!res.ok) return null;
        status = res.body;
        return status;
    }

    async function fetchPitchData(filename) {
        const token = ++inflightFetch;
        const url = `/api/plugins/lyrics_karaoke/data?filename=${encodeURIComponent(filename)}`;
        const res = await safeFetch(url);
        if (token !== inflightFetch) return null;
        if (!res.ok) return null;
        pitchData = res.body;
        songPitchRange = computeSongPitchRange(pitchData);
        tokenIndexMap = new Map();
        if (pitchData && Array.isArray(pitchData.tokens)) {
            pitchData.tokens.forEach((tok, i) => { if (tok) tokenIndexMap.set(tok, i); });
        }
        rebuildScorer();
        return pitchData;
    }

    function rebuildScorer() {
        const tokens = (pitchData && Array.isArray(pitchData.tokens)) ? pitchData.tokens : null;
        scorer = tokens
            ? createScorer({ tokens, phrases: buildPhrases(tokens), difficulty: overrides.difficulty() })
            : null;
        lastRating = null;
    }

    // Compute a fixed pitch range for the whole song so a syllable's
    // vertical position stays put as the playhead scrolls. The previous
    // code recomputed lo/hi from the visible window every frame, which
    // made stable bars appear to jump (a bar at the centre of the strip
    // would suddenly snap to the top when a lower-pitched syllable
    // entered the window). We trim 5%/95% percentiles so a single
    // octave-error outlier doesn't squash the rest of the song flat.
    function computeSongPitchRange(data) {
        const tokens = (data && Array.isArray(data.tokens)) ? data.tokens : [];
        const midis = [];
        for (const t of tokens) {
            if (t && typeof t.midi === 'number') midis.push(t.midi);
        }
        if (!midis.length) return { lo: 60, hi: 60 + MIN_PITCH_SPAN_SEMITONES };
        midis.sort((a, b) => a - b);
        const pct = (p) => midis[Math.min(midis.length - 1, Math.max(0, Math.floor(p * (midis.length - 1))))];
        let lo = pct(0.05);
        let hi = pct(0.95);
        if (hi - lo < MIN_PITCH_SPAN_SEMITONES) {
            const center = (hi + lo) / 2;
            const half = MIN_PITCH_SPAN_SEMITONES / 2;
            lo = center - half;
            hi = center + half;
        }
        return { lo, hi };
    }

    // ── Button wiring ──────────────────────────────────────────────────

    function ensureToggleButton() {
        if (toggleBtn) return;
        const lyricsBtn = document.getElementById('btn-lyrics');
        if (!lyricsBtn || !lyricsBtn.parentNode) return;
        toggleBtn = document.createElement('button');
        toggleBtn.id = 'btn-karaoke';
        toggleBtn.type = 'button';
        // Disabled styling on creation; refreshButtonState() rewrites
        // className on every state transition so the visual stays in
        // sync with the .disabled flag.
        toggleBtn.disabled = true;
        toggleBtn.className = BTN_CLASS_DISABLED;
        toggleBtn.textContent = 'Karaoke';
        toggleBtn.title = 'Karaoke pitch view (sloppak only)';
        toggleBtn.addEventListener('click', onToggleClick);
        lyricsBtn.parentNode.insertBefore(toggleBtn, lyricsBtn.nextSibling);
        // Hidden until song:loaded tells us whether to show it.
        toggleBtn.style.display = 'none';
        // The mic-feedback button rides next to the karaoke toggle and
        // only surfaces while karaoke mode is active. Inject it now so
        // the button order is stable; refreshMicUi() handles visibility.
        ensureMicButton();
    }

    function refreshButtonState() {
        refreshKaraokeToggle();
        // Mic UI tracks the karaoke toggle's eligibility — keep them
        // updated together so toggling/hiding can't desync.
        refreshMicUi();
    }

    function refreshKaraokeToggle() {
        if (!toggleBtn) return;
        const sloppak = isSloppakSong(currentSong);
        if (!sloppak) {
            toggleBtn.style.display = 'none';
            return;
        }
        toggleBtn.style.display = '';

        if (generating) {
            toggleBtn.disabled = true;
            toggleBtn.className = BTN_CLASS_DISABLED;
            toggleBtn.textContent = 'Generating…';
            toggleBtn.title = 'Extracting vocal pitch — this can take a minute.';
            return;
        }

        if (!status) {
            toggleBtn.disabled = true;
            toggleBtn.className = BTN_CLASS_DISABLED;
            toggleBtn.textContent = 'Karaoke';
            toggleBtn.title = 'Checking…';
            return;
        }

        if (!status.has_lyrics) {
            toggleBtn.disabled = true;
            toggleBtn.className = BTN_CLASS_DISABLED;
            toggleBtn.textContent = 'Karaoke';
            toggleBtn.title = 'Karaoke needs synced lyrics. Run Lyrics Sync first.';
            return;
        }

        if (!status.has_vocals) {
            toggleBtn.disabled = true;
            toggleBtn.className = BTN_CLASS_DISABLED;
            toggleBtn.textContent = 'Karaoke';
            toggleBtn.title = 'Karaoke needs an isolated vocals stem. Split stems with Demucs first.';
            return;
        }

        if (!status.has_pitch) {
            toggleBtn.disabled = false;
            toggleBtn.className = BTN_CLASS_PROMPT;
            toggleBtn.textContent = 'Generate Karaoke';
            toggleBtn.title = 'Extract per-syllable pitch from the vocals stem.';
            return;
        }

        // Karaoke ready — toggle between text and karaoke modes.
        toggleBtn.disabled = false;
        toggleBtn.className = karaokeMode ? BTN_CLASS_ACTIVE : BTN_CLASS_PROMPT;
        toggleBtn.textContent = karaokeMode ? 'Karaoke ✓' : 'Karaoke';
        toggleBtn.title = 'Switch between text lyrics and karaoke pitch ribbon.';
    }

    async function onToggleClick() {
        if (!currentSong || !status || generating) return;
        if (!status.has_lyrics || !status.has_vocals) return;

        // Pin the filename at click time. If the user changes songs
        // mid-generation, we don't want to apply the result to a
        // different song's state.
        const clickFilename = currentSong.filename;

        if (!status.has_pitch) {
            // Generate path
            generating = true;
            refreshButtonState();
            try {
                const res = await safeFetch('/api/plugins/lyrics_karaoke/generate-pitch', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filename: clickFilename }),
                });
                if (currentSong && currentSong.filename !== clickFilename) {
                    // Song changed while we were waiting — let the
                    // caller's resetForNewSong path own state. The new
                    // song's onSongLoaded already kicked off its own
                    // status fetch; we'd just clobber it otherwise.
                    return;
                }
                if (!res.ok) {
                    const msg = (res.body && res.body.error) || `Failed (${res.status})`;
                    alert('Karaoke generation failed: ' + msg);
                } else {
                    // Refresh status, then auto-enable karaoke mode
                    await fetchStatus(clickFilename);
                    if (currentSong && currentSong.filename !== clickFilename) return;
                    if (status && status.has_pitch) {
                        await fetchPitchData(clickFilename);
                        if (currentSong && currentSong.filename !== clickFilename) return;
                        setKaraokeMode(true);
                    }
                }
            } finally {
                generating = false;
                if (currentSong && currentSong.filename === clickFilename) {
                    refreshButtonState();
                }
            }
            return;
        }

        // Toggle path
        if (karaokeMode) {
            setKaraokeMode(false);
        } else {
            if (!pitchData) {
                await fetchPitchData(clickFilename);
                if (currentSong && currentSong.filename !== clickFilename) return;
            }
            setKaraokeMode(!!pitchData);
        }
    }

    function setKaraokeMode(on) {
        if (on === karaokeMode) {
            refreshButtonState();
            return;
        }
        karaokeMode = on;
        if (on) {
            // Stash the current text-lyrics visibility so we can restore
            // it when the user toggles back. Don't blow away their pref.
            if (window.highway && typeof window.highway.getLyricsVisible === 'function') {
                savedShowLyrics = window.highway.getLyricsVisible();
                if (typeof window.highway.setLyricsVisible === 'function') {
                    window.highway.setLyricsVisible(false);
                }
            }
            showOverlay();
            refreshMicPickers();   // device names/plugs may have changed since load
            // Restore the mic-on intent if the user had it on for the
            // current song's session. Scoped per-song deliberately —
            // resetForNewSong clears micWantOnForSong, so a one-time
            // opt-in on song A doesn't auto-prompt on song B.
            // Fire-and-forget; refreshMicUi reflects the requesting/
            // listening/error transitions as the promise progresses.
            if (micWantOnForSong && status && status.has_pitch && songHasMidi() && micState === 'off') {
                startMic();
            }
        } else {
            hideOverlay();
            // Tear the mic stream down with the overlay — there's nothing
            // to render to. keepFlag preserves the on/off intent so the
            // next karaoke toggle on the same song restores the mic.
            if (micState !== 'off') stopMic({ keepFlag: true });
            resetUserResults();
            if (window.highway && typeof window.highway.setLyricsVisible === 'function') {
                window.highway.setLyricsVisible(savedShowLyrics);
            }
        }
        refreshButtonState();
    }

    // ── Overlay canvas lifecycle ───────────────────────────────────────

    // The strip's host: a connected element another plugin mounted it in,
    // else #player. A torn-down host never swallows solo karaoke.
    function resolveHost() {
        if (stripHost && stripHost.isConnected) return stripHost;
        return document.getElementById('player');
    }

    // Put the overlay in `host`: filling it when hosted, else just below
    // #player's HUD row (above highway, below HUD/controls).
    function placeOverlay(host) {
        Object.assign(overlayEl.style, stripHostStyle(host !== document.getElementById('player')));
        if (overlayEl.parentNode !== host) host.appendChild(overlayEl);
    }

    function showOverlay() {
        const host = resolveHost();
        if (!host) return;
        if (host === document.getElementById('player') && !document.getElementById('highway')) return;

        if (!overlayEl) {
            overlayEl = document.createElement('div');
            overlayEl.id = 'lyrics-karaoke-overlay';

            canvas = document.createElement('canvas');
            canvas.style.width = '100%';
            canvas.style.height = '100%';
            canvas.style.display = 'block';
            overlayEl.appendChild(canvas);
            placeOverlay(host);

            ctx = canvas.getContext('2d');
            sizeCanvas();
        } else {
            overlayEl.style.display = '';
            if (overlayEl.parentNode !== host) {
                placeOverlay(host);
                sizeCanvas();
            }
        }

        if (!resizeObserver && typeof ResizeObserver !== 'undefined') {
            resizeObserver = new ResizeObserver(sizeCanvas);
            resizeObserver.observe(overlayEl);
        }
        startRaf();
    }

    function hideOverlay() {
        stopRaf();
        if (overlayEl) overlayEl.style.display = 'none';
    }

    function teardownOverlay() {
        // Full teardown — used on song change so a stale canvas doesn't
        // linger across reloads.
        stopRaf();
        if (resizeObserver) {
            try { resizeObserver.disconnect(); } catch (_) { /* noop */ }
            resizeObserver = null;
        }
        if (overlayEl && overlayEl.parentNode) {
            overlayEl.parentNode.removeChild(overlayEl);
        }
        overlayEl = null;
        canvas = null;
        ctx = null;
    }

    function sizeCanvas() {
        if (!canvas || !overlayEl) return;
        const rect = overlayEl.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.floor(rect.width * dpr));
        const h = Math.max(1, Math.floor(rect.height * dpr));
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== h) canvas.height = h;
    }

    // ── Render loop ────────────────────────────────────────────────────

    function startRaf() {
        if (rafHandle) return;
        const tick = () => {
            rafHandle = requestAnimationFrame(tick);
            try { drawFrame(); } catch (e) {
                // Don't kill the rAF loop on a one-off render bug; log and continue.
                console.warn('lyrics_karaoke draw error', e);
            }
        };
        rafHandle = requestAnimationFrame(tick);
    }

    function stopRaf() {
        if (rafHandle) {
            cancelAnimationFrame(rafHandle);
            rafHandle = null;
        }
    }

    function getNow() {
        if (window.highway && typeof window.highway.getTime === 'function') {
            return window.highway.getTime();
        }
        return 0;
    }

    function visibleBars(now) {
        // Use the absolute window [now - playhead-frac * VISIBLE_SECONDS,
        // now + (1-frac) * VISIBLE_SECONDS]. A small overscan on either
        // side keeps bars from popping at the edges.
        if (!pitchData || !Array.isArray(pitchData.tokens)) return [];
        const winLeft = now - PLAYHEAD_FRAC * VISIBLE_SECONDS - 0.5;
        const winRight = now + (1 - PLAYHEAD_FRAC) * VISIBLE_SECONDS + 0.5;
        const out = [];
        for (const tok of pitchData.tokens) {
            if (!tok || typeof tok.t !== 'number') continue;
            const t1 = tok.t + (tok.d || 0);
            if (t1 < winLeft || tok.t > winRight) continue;
            // Tokens without midi still get rendered as text-only so a
            // whole phrase that pYIN couldn't voice (e.g. quiet/whispered
            // sections) doesn't vanish from the chart.
            const hasMidi = typeof tok.midi === 'number';
            out.push({ tok, midi: hasMidi ? tok.midi : null });
        }
        return out;
    }

    function pitchRange(visible) {
        // Auto-fit the strip to the local vocal range, but never collapse
        // tighter than MIN_PITCH_SPAN_SEMITONES so a held single note still
        // sits in the middle of the strip rather than filling it.
        if (!visible.length) return { lo: 60, hi: 60 + MIN_PITCH_SPAN_SEMITONES };
        let lo = Infinity, hi = -Infinity;
        for (const v of visible) {
            if (v.midi < lo) lo = v.midi;
            if (v.midi > hi) hi = v.midi;
        }
        if (hi - lo < MIN_PITCH_SPAN_SEMITONES) {
            const center = (hi + lo) / 2;
            const half = MIN_PITCH_SPAN_SEMITONES / 2;
            lo = center - half;
            hi = center + half;
        }
        return { lo, hi };
    }

    function drawFrame() {
        if (!canvas || !ctx) return;
        if (!pitchData) return;

        const W = canvas.width;
        const H = canvas.height;
        ctx.clearRect(0, 0, W, H);

        // Background — soft band so the ribbon reads against any highway.
        ctx.fillStyle = RIBBON_BG;
        roundFillRect(ctx, 4, 4, W - 8, H - 8, 10);

        const now = getNow();
        const pxPerSec = W / VISIBLE_SECONDS;
        const playheadX = W * PLAYHEAD_FRAC;

        // Compute screen-X from absolute time.
        const xFor = (t) => playheadX + (t - now) * pxPerSec;

        const visible = visibleBars(now);
        // Use the song-wide pitch range so a bar's vertical position
        // doesn't shift as new syllables enter/leave the visible window.
        // Fall back to a per-frame range only when the song-wide range
        // hasn't been computed yet (data still loading).
        const { lo, hi } = songPitchRange || pitchRange(visible);

        // Reserve the bottom ~36px for syllable text; the bars live above.
        const dpr = window.devicePixelRatio || 1;
        const TEXT_BAND_CSS = 36;
        const textBandPx = TEXT_BAND_CSS * dpr;
        const barTop = 12 * dpr;
        const barBand = H - textBandPx - barTop - 4 * dpr;
        const barHeight = Math.max(8 * dpr, Math.min(22 * dpr, barBand / 8));

        const yFor = (midi) => {
            const span = Math.max(1, hi - lo);
            const frac = (hi - midi) / span;       // 0 = top, 1 = bottom
            return barTop + frac * Math.max(0, barBand - barHeight);
        };

        ctx.font = `${Math.round(14 * dpr)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';

        for (const { tok, midi } of visible) {
            const x0 = xFor(tok.t);
            const x1 = xFor(tok.t + (tok.d || 0));
            const w = Math.max(2 * dpr, x1 - x0 - 2 * BAR_PAD_PX * dpr);
            const x = x0 + BAR_PAD_PX * dpr;

            const isPast = (tok.t + (tok.d || 0)) <= now;
            const isActive = tok.t <= now && now < tok.t + (tok.d || 0);

            if (midi !== null) {
                const y = yFor(midi);

                // Draw the dim "future" / "past unreached" bar in full.
                ctx.fillStyle = BAR_COLOR_DIM;
                roundFillRect(ctx, x, y, w, barHeight, BAR_RADIUS * dpr);

                // Fill the portion to the left of the playhead in bright color.
                const fillRight = Math.max(x, Math.min(x + w, playheadX));
                const fillW = fillRight - x;
                if (fillW > 0 && (isPast || isActive)) {
                    ctx.fillStyle = isActive ? BAR_COLOR_ACTIVE : BAR_COLOR_FILL;
                    roundFillRect(ctx, x, y, fillW, barHeight, BAR_RADIUS * dpr);
                }
            }

            // Syllable text below the bar, centered on its midpoint.
            // Render even when midi is missing so phrases pYIN couldn't
            // voice still appear in the lyric stream.
            const text = syllableText(tok);
            if (text) {
                ctx.fillStyle = isPast ? TEXT_COLOR_PAST : TEXT_COLOR;
                const cx = (x0 + x1) / 2;
                const ty = barTop + barBand + 4 * dpr;
                ctx.fillText(text, cx, ty);
            }
        }

        // Score phrases the playhead has passed — only while listening,
        // so turning the mic off doesn't rate the rest of the song Awful.
        if (scorer && micState === 'listening') {
            const events = scorer.advanceTo(now - (micLatencyMs / 1000) * getPlaybackRate());
            if (events.length) {
                lastRating = { text: events[events.length - 1].rating, at: _wallNow() };
                emitScoring(busEmit, events, scorer.snapshot());
            }
        }
        const hasScored = !!scorer && scorer.snapshot().ratedCount > 0;

        // Mic-feedback overlays — only when the user has been singing.
        if (scorer && (hasScored || micState === 'listening')) {
            for (const { tok, midi } of visible) {
                if (midi == null) continue;
                const idx = tokenIndexMap.get(tok);
                if (idx === undefined) continue;
                const acc = scorer.tokenAccuracy(idx);
                if (acc === null) continue;
                const x0 = xFor(tok.t);
                const x1 = xFor(tok.t + (tok.d || 0));
                const w = Math.max(2 * dpr, x1 - x0 - 2 * BAR_PAD_PX * dpr);
                const x = x0 + BAR_PAD_PX * dpr;
                const y = yFor(midi);
                ctx.fillStyle = `rgba(${Math.round(255 * (1 - acc))}, ${Math.round(255 * acc)}, 64, 0.55)`;
                roundFillRect(ctx, x, y, w, barHeight, BAR_RADIUS * dpr);
            }

            // Pitch feedback, SingStar/Rock Band style. Your pitch is drawn in
            // the octave nearest the target note (scoring ignores octave too),
            // as a trail over what you just sang plus an arrow at the playhead —
            // green inside the difficulty's tolerance, orange outside.
            const tolCents = (DIFFICULTIES[overrides.difficulty()] || DIFFICULTIES.medium).toleranceCents;
            const targetAt = (t) => {
                let best = null;
                for (const { tok, midi } of visible) {
                    if (midi == null) continue;
                    if (t >= tok.t && t < tok.t + (tok.d || 0)) return midi;
                    if (!best || Math.abs(tok.t - t) < Math.abs(best.tok.t - t)) best = { tok, midi };
                }
                return best ? best.midi : null;
            };
            const yMin = barTop;
            const yMax = barTop + Math.max(0, barBand - barHeight);
            const yClip = (m) => Math.max(yMin, Math.min(yMax, yFor(m))) + barHeight / 2;
            const ON = '#4ade80', OFF = '#fb923c';

            // Trail: samples from the visible past, broken at gaps.
            const trailFrom = now - PLAYHEAD_FRAC * VISIBLE_SECONDS;
            ctx.lineWidth = 3 * dpr;
            ctx.lineCap = 'round';
            let prev = null;
            let trailShift = null;
            for (const smp of userPitchSamples) {
                if (smp.t < trailFrom || smp.t > now) { prev = null; continue; }
                const target = targetAt(smp.t);
                const folded = foldSticky(smp.midi, target, trailShift);
                trailShift = folded.shift;
                const shown = folded.shown;
                const onPitch = target != null && Math.abs(pitchClassCents(smp.midi, target)) <= tolCents;
                const pt = { x: xFor(smp.t), y: yClip(shown), t: smp.t };
                if (prev && pt.t - prev.t < 0.15) {
                    // Dark outline first so the trail reads over same-colour bars.
                    ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
                    ctx.lineWidth = 6 * dpr;
                    ctx.beginPath();
                    ctx.moveTo(prev.x, prev.y);
                    ctx.lineTo(pt.x, pt.y);
                    ctx.stroke();
                    ctx.strokeStyle = onPitch ? ON : OFF;
                    ctx.lineWidth = 3 * dpr;
                    ctx.beginPath();
                    ctx.moveTo(prev.x, prev.y);
                    ctx.lineTo(pt.x, pt.y);
                    ctx.stroke();
                }
                prev = pt;
            }

            // Freshness uses wall-clock ms, not song time — when playback
            // is paused getNow() stops advancing but the user has stopped
            // singing live too, so the arrow/pill should still age out.
            const fresh = (_wallNow() - userLastSampleWallAt) <= _LK_SAMPLE_FRESH_MS;
            if (fresh && userPitchSamples.length) {
                const last = userPitchSamples[userPitchSamples.length - 1];
                const target = targetAt(now);
                // Sticky octave: a steady voice stays put as the target note moves.
                const folded = foldSticky(last.midi, target, userDisplayShift);
                userDisplayShift = folded.shift;
                const shownNow = folded.shown;
                if (userDisplayMidi == null || Math.abs(shownNow - userDisplayMidi) > 6) {
                    userDisplayMidi = shownNow;
                } else {
                    // Simple low-pass (α=0.4) keeps the arrow from snapping
                    // jaggedly between adjacent semitones without lagging.
                    userDisplayMidi += 0.4 * (shownNow - userDisplayMidi);
                }
                const onPitch = target != null && Math.abs(pitchClassCents(last.midi, target)) <= tolCents;
                const y = yClip(userDisplayMidi);
                const sz = 9 * dpr;
                ctx.fillStyle = onPitch ? ON : OFF;
                ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
                ctx.lineWidth = 2 * dpr;
                ctx.beginPath();
                ctx.moveTo(playheadX + 2 * dpr, y);
                ctx.lineTo(playheadX - sz * 1.6, y - sz);
                ctx.lineTo(playheadX - sz * 1.6, y + sz);
                ctx.closePath();
                ctx.fill();
                ctx.stroke();

                // Glow the note you're singing while you're on it.
                if (onPitch) {
                    for (const { tok, midi } of visible) {
                        if (midi == null || !(now >= tok.t && now < tok.t + (tok.d || 0))) continue;
                        const x0 = xFor(tok.t) + BAR_PAD_PX * dpr;
                        const w = Math.max(2 * dpr, xFor(tok.t + (tok.d || 0)) - xFor(tok.t) - 2 * BAR_PAD_PX * dpr);
                        ctx.strokeStyle = ON;
                        ctx.lineWidth = 2.5 * dpr;
                        ctx.strokeRect(x0, yFor(midi), w, barHeight);
                    }
                }
            } else {
                // Discard the smoothed value so re-acquire snaps cleanly
                // rather than drifting from the last fresh pitch.
                userDisplayMidi = null;
                userDisplayShift = null;
            }
            updateMicPill();
            drawHud(dpr, playheadX);
        }

        if (micState === 'error' && micErrorMsg) {
            const warn = '⚠ ' + micErrorMsg;
            ctx.save();
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.font = `bold ${Math.round(12 * dpr)}px sans-serif`;
            const ww = ctx.measureText(warn).width;
            ctx.fillStyle = 'rgba(8, 8, 14, 0.85)';
            roundFillRect(ctx, 8 * dpr, 6 * dpr, ww + 12 * dpr, 18 * dpr, 6 * dpr);
            ctx.fillStyle = '#f87171';
            ctx.fillText(warn, 14 * dpr, 9 * dpr);
            ctx.restore();
        }

        // Playhead.
        ctx.strokeStyle = PLAYHEAD_COLOR;
        ctx.lineWidth = Math.max(1, 1.5 * dpr);
        ctx.beginPath();
        ctx.moveTo(playheadX, 6 * dpr);
        ctx.lineTo(playheadX, H - 6 * dpr);
        ctx.stroke();
    }

    // Score, multiplier and stars on one line at the top left (other
    // plugins' panels sit over the top-right corner); the latest phrase
    // rating floats above the playhead and fades out.
    function drawHud(dpr, playheadX) {
        ctx.save();
        ctx.textBaseline = 'top';
        ctx.textAlign = 'left';
        // A host with its own score display (Build-a-Band) hides the pill;
        // warnings and ratings keep their places.
        if (!overrides.scoreHudHidden()) {
            const snap = scorer.snapshot();
            const parts = [
                [snap.score.toLocaleString(), `bold ${Math.round(15 * dpr)}px sans-serif`, TEXT_COLOR],
                [`×${snap.multiplier}`, `bold ${Math.round(13 * dpr)}px sans-serif`,
                    snap.multiplier > 1 ? BAR_COLOR_ACTIVE : TEXT_COLOR_PAST],
                ['★'.repeat(snap.stars) + '☆'.repeat(5 - snap.stars), `${Math.round(13 * dpr)}px sans-serif`, BAR_COLOR_FILL],
            ];
            const gap = 10 * dpr;
            const widths = parts.map(([text, font]) => { ctx.font = font; return ctx.measureText(text).width; });
            const total = widths.reduce((a, b) => a + b, 0) + gap * (parts.length - 1);
            const y = 8 * dpr;
            // Backing pill keeps the HUD legible over high-pitched bars.
            ctx.fillStyle = 'rgba(8, 8, 14, 0.85)';
            roundFillRect(ctx, 8 * dpr, 4 * dpr, total + 12 * dpr, 22 * dpr, 8 * dpr);
            let x = 14 * dpr;
            parts.forEach(([text, font, color], i) => {
                ctx.font = font;
                ctx.fillStyle = color;
                ctx.fillText(text, x, y);
                x += widths[i] + gap;
            });
        }
        // Mic setup problems (built-in mic, speakers) make scoring meaningless —
        // say so where the singer is looking.
        const howlNotice = _wallNow() < howlNoticeUntil
            ? 'Feedback detected — voice volume lowered' : null;
        if (micState === 'listening' && (howlNotice || micSetupWarnings.length)) {
            const warn = '⚠ ' + (howlNotice || micSetupWarnings[0]);
            ctx.font = `bold ${Math.round(12 * dpr)}px sans-serif`;
            const ww = ctx.measureText(warn).width;
            ctx.fillStyle = 'rgba(8, 8, 14, 0.85)';
            roundFillRect(ctx, 8 * dpr, 28 * dpr, ww + 12 * dpr, 18 * dpr, 6 * dpr);
            ctx.fillStyle = '#f87171';
            ctx.fillText(warn, 14 * dpr, 31 * dpr);
        }

        if (lastRating) {
            const age = _wallNow() - lastRating.at;
            if (age < _LK_RATING_SHOW_MS) {
                ctx.globalAlpha = 1 - age / _LK_RATING_SHOW_MS;
                ctx.textAlign = 'center';
                ctx.font = `bold ${Math.round(16 * dpr)}px sans-serif`;
                ctx.fillStyle = _LK_RATING_COLORS[lastRating.text] || TEXT_COLOR;
                const ratingY = (micState === 'listening' && (micSetupWarnings.length || _wallNow() < howlNoticeUntil)) ? 50 : 26;
                ctx.fillText(lastRating.text, playheadX, ratingY * dpr);
            }
        }
        ctx.restore();
    }

    function roundFillRect(c, x, y, w, h, r) {
        const rr = Math.max(0, Math.min(r, w / 2, h / 2));
        c.beginPath();
        c.moveTo(x + rr, y);
        c.lineTo(x + w - rr, y);
        c.quadraticCurveTo(x + w, y, x + w, y + rr);
        c.lineTo(x + w, y + h - rr);
        c.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
        c.lineTo(x + rr, y + h);
        c.quadraticCurveTo(x, y + h, x, y + h - rr);
        c.lineTo(x, y + rr);
        c.quadraticCurveTo(x, y, x + rr, y);
        c.closePath();
        c.fill();
    }

    // ── Mic pitch feedback (live) ──────────────────────────────────────
    //
    // YIN + getUserMedia + ScriptProcessor accumulator are adapted from
    // the slopsmith note_detect plugin. Vocals are monophonic so YIN alone
    // is sufficient — no CREPE/HPS/WASM. Once a third consumer of this
    // pattern arrives, factor into a shared module (tracked as issue #5).
    const _LK_YIN_FRAME_SIZE = 2048;
    const _LK_YIN_MIN_SAMPLES = 4096;
    const _LK_YIN_MIN_HZ = VOCAL_MIN_HZ;      // singing range, see pitch.js
    const _LK_YIN_MAX_HZ = VOCAL_MAX_HZ;
    const _LK_YIN_CONFIDENCE = VOCAL_CONFIDENCE;
    const _LK_SAMPLE_FRESH_MS = 200;  // stale samples don't draw the user line
    const _LK_SAMPLE_RING_CAP = 256;  // ~12 s at 50 ms cadence
    const _LK_STORAGE_KEY = 'lyrics_karaoke.micFeedback';
    const _LK_RATING_SHOW_MS = 1200;
    const _LK_RATING_COLORS = {
        Awesome: '#ffe080', Strong: '#ffe080',
        Good: '#9be7a0', OK: '#9be7a0',
        Messy: '#f87171', Awful: '#f87171',
    };

    // Mic state — implicit-flag style mirroring note_detect's pattern.
    let micState = 'off';            // 'off' | 'requesting' | 'listening' | 'error'
    let micBtn = null;
    let micPill = null;
    let micStream = null;
    let micCtx = null;
    let micSourceNode = null;
    let micProcessor = null;
    let micTimer = null;
    let micSessionGen = 0;            // bumped on stop to invalidate stale frames
    let micRingBuffer = null;         // preallocated sliding window (Float32Array, _LK_YIN_MIN_SAMPLES)
    let micRingCount = 0;             // total samples written into ring since mic start
    let micPendingBuffer = null;      // preallocated snapshot buffer (Float32Array, same size)
    let micPendingReady = false;      // true when pending buffer has a fresh snapshot
    let micPendingBufferAt = -Infinity;  // song-time at the buffer's midpoint
    let micPendingSession = 0;           // micSessionGen at the time the snapshot was taken
    let micLastCapturedAt = -Infinity;   // previous frame's song-time, for stall/seek detection
    let micErrorMsg = '';
    let micPillLastText = '';            // last text written to micPill; avoids per-frame DOM writes
    let micDeviceLabel = '';             // label of the mic actually opened
    let micSetupWarnings = [];           // micWarnings(): built-in mic, speaker output
    let micLatencyMs = 0;                // latency correction read once per mic start
    let diffSelect = null;               // in-player difficulty <select>
    let micSelect = null;                // in-player microphone <select>
    let monitorSlider = null;            // in-player voice-volume slider
    let monitorGain = null;              // GainNode: your voice → the game's output
    let monitorLimiter = null;           // limiter after monitorGain, → destination
    let howlCooldownUntil = -Infinity;   // song time before which the howl guard won't act again
    let howlNoticeUntil = -Infinity;     // wall-clock ms until which the 'feedback' notice shows
    const howlSamples = [];              // every confident pitch (any range), for the howl guard
    const diag = { howlDucks: 0, lastHz: null, frames: 0, rmsDb: -Infinity, peakDb: -Infinity, voiced: 0, unvoiced: 0, lastMidi: null, lastConfidence: 0 };
    // Session-scoped intent: "the user enabled mic for THIS song." Used
    // to auto-restore the mic when karaoke is toggled off and back on
    // for the same song without spilling that intent across songs (a
    // resetForNewSong clears it). The persisted localStorage flag is
    // separate and serves a future "remember on reload" surface.
    let micWantOnForSong = false;

    // Per-song bookkeeping for the live overlay.
    const userPitchSamples = [];      // ring of {t, midi, confidence}
    let userDisplayMidi = null;       // smoothed value used for the pitch line + pill
    let userDisplayShift = null;      // the arrow's current octave shift (foldSticky)
    let userLastSampleWallAt = -Infinity; // wall-clock ms of latest sample (used for staleness)

    function _wallNow() {
        return (typeof performance !== 'undefined' && performance.now)
            ? performance.now() : Date.now();
    }

    function getPlaybackRate() {
        // The player's <audio> element drives song time; its playbackRate
        // is the song-seconds-per-wall-second ratio. Plugins access it
        // through the DOM rather than a window global because app.js
        // keeps the reference module-scoped.
        const a = (typeof document !== 'undefined') ? document.getElementById('audio') : null;
        if (a && typeof a.playbackRate === 'number' && a.playbackRate > 0) {
            return a.playbackRate;
        }
        return 1.0;
    }

    function songHasMidi() {
        if (!pitchData || !Array.isArray(pitchData.tokens)) return false;
        for (const t of pitchData.tokens) {
            if (t && typeof t.midi === 'number') return true;
        }
        return false;
    }

    function resetUserResults() {
        userPitchSamples.length = 0;
        if (scorer) scorer.reset();
        lastRating = null;
        userDisplayMidi = null;
        userDisplayShift = null;
        userLastSampleWallAt = -Infinity;
        // Also drop the transport-tracking cursor so the next frame
        // doesn't compare against a stale previous time.
        micLastCapturedAt = -Infinity;
        busEmit(RESET_EVENT, scorer ? scorer.snapshot() : null);
    }

    // Core's event bus; a listener's error never breaks karaoke.
    function busEmit(name, detail) {
        try {
            const bus = window.feedBack || window.slopsmith;
            if (bus && typeof bus.emit === 'function') bus.emit(name, detail);
        } catch (_) { /* noop */ }
    }

    function processYinFrame(buffer, sampleRate, capturedAt, sessionAtCapture) {
        if (sessionAtCapture !== micSessionGen) return;  // stop happened mid-frame

        // Transport awareness. If the playhead didn't advance (paused),
        // drop the sample so the live pitch line ages out. A backward
        // jump (replay, seek-back, practice loop) is handled by the
        // scorer, which resets itself so old phrases don't resurrect.
        if (micLastCapturedAt > -Infinity && Math.abs(capturedAt - micLastCapturedAt) < 1e-3) return;
        micLastCapturedAt = capturedAt;

        const r = yinDetect(buffer, sampleRate, _LK_YIN_MIN_HZ);
        diag.lastConfidence = r ? r.confidence : 0;
        if (!r || r.freq <= 0 || r.confidence < _LK_YIN_CONFIDENCE) { diag.unvoiced += 1; return; }
        diag.voiced += 1;
        diag.lastHz = r.freq;
        // Feedback usually rings at 1–3 kHz, above the singing range filtered
        // below, so the howl guard watches every confident pitch.
        howlSamples.push({ t: capturedAt, midi: freqToMidi(r.freq) });
        if (howlSamples.length > 64) howlSamples.shift();
        guardAgainstHowl(capturedAt);
        if (r.freq < _LK_YIN_MIN_HZ || r.freq > _LK_YIN_MAX_HZ) return;
        const midi = freqToMidi(r.freq);
        if (!isFinite(midi)) return;

        userPitchSamples.push({ t: capturedAt, midi, confidence: r.confidence });
        if (userPitchSamples.length > _LK_SAMPLE_RING_CAP) userPitchSamples.shift();
        userLastSampleWallAt = _wallNow();

        diag.lastMidi = midi;
        if (scorer) scorer.addSample({ t: capturedAt, midi });
    }

    // Feedback guard: a speaker→mic howl is one pitch held dead steady. When the
    // monitor is on and that shows up, drop the voice volume 6 dB and say so.
    function guardAgainstHowl(now) {
        if (!monitorGain || now < howlCooldownUntil) return;
        if (!isHowling(howlSamples, now)) return;
        const lowered = Math.max(0, getMonitorVolume() - 0.5);   // 0.5 of the slider = 6 dB
        setMonitorVolume(lowered);
        if (micCtx) monitorGain.gain.setTargetAtTime(monitorGainFor(lowered), micCtx.currentTime, 0.01);
        if (monitorSlider) {
            monitorSlider.value = String(Math.round(lowered * 100));
            monitorSlider.title = `Your voice volume: ${monitorSlider.value}%`;
        }
        howlCooldownUntil = now + 1.5;
        howlNoticeUntil = _wallNow() + 4000;
        diag.howlDucks += 1;
    }

    async function startMic() {
        if (micState === 'listening' || micState === 'requesting') return;
        // Only ever open the mic the user picked — no system-default guess.
        const gate = micStartError(getDeviceId(), []);
        if (gate) {
            micErrorMsg = gate;
            micState = 'error';
            refreshMicUi();
            promptMicPicker();
            return;
        }
        micState = 'requesting';
        micErrorMsg = '';
        refreshMicUi();

        const session = ++micSessionGen;
        let pendingStream = null;
        let pendingCtx = null;
        try {
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                const isHttp = location.protocol === 'http:'
                    && location.hostname !== 'localhost'
                    && location.hostname !== '127.0.0.1';
                throw new Error(isHttp
                    ? 'Microphone access requires HTTPS (or localhost).'
                    : 'Microphone access is not available in this browser. Try Chrome or Edge.');
            }
            // Create + resume the AudioContext BEFORE awaiting
            // getUserMedia so the original user activation is still
            // valid when Safari/iOS evaluates resume(). After the
            // await, activation can be consumed and resume() would
            // refuse, leaving us silently in 'listening' with no audio.
            pendingCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
            if (pendingCtx.state === 'suspended') {
                try { await pendingCtx.resume(); } catch (e) {
                    throw new Error('Audio context could not resume. Click 🎤 again.');
                }
                if (pendingCtx.state === 'suspended') {
                    throw new Error('Audio context is suspended. Click 🎤 again.');
                }
            }
            try {
                pendingStream = await navigator.mediaDevices.getUserMedia(micConstraints(getDeviceId()));
            } catch (e) {
                // Never substitute another mic for the one the user chose.
                if (isDeviceMissingError(e)) {
                    throw new Error("Your chosen microphone isn't connected — plug it in or pick another.");
                }
                throw e;
            }
            if (session !== micSessionGen) {
                // Stop happened while the permission prompt was open.
                pendingStream.getTracks().forEach((t) => { try { t.stop(); } catch (_) { /* noop */ } });
                try { pendingCtx.close(); } catch (_) { /* noop */ }
                return;
            }
            micStream = pendingStream;
            micCtx = pendingCtx;
            const track = micStream.getAudioTracks()[0];
            micDeviceLabel = (track && track.label) || '';
            micSetupWarnings = [];
            listMediaDevicesSafe().then((devices) => {
                if (session !== micSessionGen) return;
                micSetupWarnings = micWarnings(micDeviceLabel, devices);
                refreshMicUi();
            });
            refreshMicPickers();
            micSourceNode = micCtx.createMediaStreamSource(micStream);
            micProcessor = micCtx.createScriptProcessor(_LK_YIN_FRAME_SIZE, 1, 1);
            // Preallocate fixed-size buffers to avoid per-frame Float32Array
            // allocation / GC pressure in the hot onaudioprocess path.
            // ringSize must cover 2*tauMax samples so yinDetect can search
            // down to _LK_YIN_MIN_HZ at any sample rate (e.g. 192 kHz needs
            // 2*⌈192000/50⌉ = 7680 samples, well above _LK_YIN_MIN_SAMPLES).
            const sampleRate = micCtx.sampleRate;
            const ringSize = Math.max(_LK_YIN_MIN_SAMPLES,
                2 * Math.ceil(sampleRate / _LK_YIN_MIN_HZ));
            micRingBuffer = new Float32Array(ringSize);
            micPendingBuffer = new Float32Array(ringSize);
            micRingCount = 0;
            micPendingReady = false;

            // The captured audio represents the most recent
            // ringSize frames of mic input — i.e. it spans
            // [now - bufferDurationWall, now] in wall-clock seconds.
            // Tag the *midpoint* of that window as the buffer's
            // representative song time so the scorer credits
            // against the syllable actually being sung, not the one
            // under the cursor when the 50 ms timer wakes. Convert
            // wall-clock to song-time via the current playback rate so
            // slow/fast practice still maps frames to the correct
            // syllable (read fresh per frame — the user can scrub the
            // speed slider mid-song).
            const midpointWallSec = (ringSize / 2) / sampleRate;
            micLatencyMs = getLatencyMs();

            micProcessor.onaudioprocess = (e) => {
                if (micState !== 'listening') return;
                const input = e.inputBuffer.getChannelData(0);
                const n = input.length;
                // Level meter for diagnostics (cheap: one pass per ~43 ms block).
                let sumSq = 0, peak = 0;
                for (let i = 0; i < n; i++) { const v = input[i]; sumSq += v * v; const a = v < 0 ? -v : v; if (a > peak) peak = a; }
                diag.frames += 1;
                diag.rmsDb = 10 * Math.log10(sumSq / n || 1e-12);
                diag.peakDb = 20 * Math.log10(peak || 1e-6);
                // Slide the ring buffer left by n samples (in-place, no allocation):
                // copies bytes [n .. ringSize-1] to [0 .. ringSize-n-1],
                // then the new frame fills the vacated tail.
                micRingBuffer.copyWithin(0, n);
                micRingBuffer.set(input, ringSize - n);
                micRingCount += n;
                // Only expose a pending snapshot once we have a full window.
                // After that, every ScriptProcessor callback (~46 ms at
                // 44100 Hz) produces a fresh snapshot — well within the
                // 50 ms timer cadence.
                if (micRingCount >= ringSize) {
                    micPendingBuffer.set(micRingBuffer);
                    micPendingBufferAt = micSongTime(getNow(), midpointWallSec, micLatencyMs, getPlaybackRate());
                    micPendingSession = session;
                    micPendingReady = true;
                }
            };

            micSourceNode.connect(micProcessor);
            // ScriptProcessor needs a sink to actually pump audio. Routing
            // to destination would feed the mic to the speakers; route to
            // a muted gain node instead so we get callbacks without
            // creating a feedback loop.
            const muteSink = micCtx.createGain();
            muteSink.gain.value = 0;
            micProcessor.connect(muteSink);
            muteSink.connect(micCtx.destination);

            // Hear-myself off (a session override) builds no path to the speakers.
            if (overrides.hearMyself()) connectMonitor();
            routeMonitorToGameOutput(micCtx, session);

            micTimer = setInterval(() => {
                if (!micPendingReady) return;
                const at = micPendingBufferAt;
                const sessionAtCapture = micPendingSession;
                micPendingReady = false;
                processYinFrame(micPendingBuffer, sampleRate, at, sessionAtCapture);
            }, 50);

            micState = 'listening';
            micWantOnForSong = true;
            try { localStorage.setItem(_LK_STORAGE_KEY, '1'); } catch (_) { /* noop */ }
            refreshMicUi();
        } catch (e) {
            console.warn('lyrics_karaoke mic start failed', e);
            micErrorMsg = (e && e.message) || 'Microphone unavailable';
            // Clean up partial state — we may have created the context
            // and/or stream before the throw, but they aren't yet
            // assigned to micCtx/micStream that stopMic operates on.
            if (pendingStream && pendingStream !== micStream) {
                try { pendingStream.getTracks().forEach((t) => t.stop()); } catch (_) { /* noop */ }
            }
            if (pendingCtx && pendingCtx !== micCtx) {
                try { pendingCtx.close(); } catch (_) { /* noop */ }
            }
            // Clear both the persisted flag and the per-song intent on
            // failure. Otherwise a revoked permission or unplugged
            // input would re-trigger the prompt on every karaoke
            // toggle (persisted flag) or every karaoke off/on for the
            // current song (in-memory intent). The user re-clicks 🎤
            // to retry; a successful start re-sets both flags.
            micWantOnForSong = false;
            stopMic({ keepFlag: false });
            // stopMic resets to 'off'; re-flag as 'error' so the pill/title
            // surface why the start failed.
            micState = 'error';
            refreshMicUi();
        }
    }

    // Vocal monitor: your voice through the same device that plays the
    // game's audio, at the user's volume. A hard limiter keeps a loud
    // note (or the start of a feedback howl) from clipping harshly.
    function connectMonitor() {
        if (!micCtx || !micSourceNode || monitorGain) return;
        monitorGain = micCtx.createGain();
        monitorGain.gain.value = monitorGainFor(getMonitorVolume());
        const limiter = micCtx.createDynamicsCompressor();
        limiter.threshold.value = -6;
        limiter.knee.value = 0;
        limiter.ratio.value = 20;
        limiter.attack.value = 0.002;
        limiter.release.value = 0.1;
        micSourceNode.connect(monitorGain);
        monitorGain.connect(limiter);
        limiter.connect(micCtx.destination);
        monitorLimiter = limiter;
    }

    function disconnectMonitor() {
        if (micSourceNode && monitorGain) {
            try { micSourceNode.disconnect(monitorGain); } catch (_) { /* noop */ }
        }
        if (monitorGain) { try { monitorGain.disconnect(); } catch (_) { /* noop */ } }
        if (monitorLimiter) { try { monitorLimiter.disconnect(); } catch (_) { /* noop */ } }
        monitorGain = null;
        monitorLimiter = null;
    }

    // Follow the hear-myself override while the mic is open.
    function applyHearMyself() {
        if (micState !== 'listening') return;
        const on = overrides.hearMyself();
        if (on && !monitorGain) connectMonitor();
        else if (!on && monitorGain) disconnectMonitor();
    }

    // Point the mic context at the device playing the game: the OS default
    // for browser playback, or the native engine's output when it plays the song.
    async function routeMonitorToGameOutput(ctxForMic, session) {
        if (!ctxForMic || typeof ctxForMic.setSinkId !== 'function') return;
        let engineOutput = '';
        const bridge = window.feedBackDesktop && window.feedBackDesktop.audio;
        if (window._juceMode && bridge && typeof bridge.getCurrentDevice === 'function') {
            try { engineOutput = ((await bridge.getCurrentDevice()) || {}).output || ''; } catch (_) { /* noop */ }
        }
        const sink = monitorSinkId(await listMediaDevicesSafe(), { juceMode: !!window._juceMode, engineOutput });
        if (session !== micSessionGen || !sink) return;
        try { await ctxForMic.setSinkId(sink); } catch (e) { console.warn('lyrics_karaoke: monitor output switch failed', e); }
    }

    async function listMediaDevicesSafe() {
        try { return await navigator.mediaDevices.enumerateDevices(); } catch (_) { return []; }
    }

    function stopMic(opts) {
        const keepFlag = !!(opts && opts.keepFlag);
        monitorGain = null;   // closed with micCtx below
        monitorLimiter = null;
        micDeviceLabel = '';
        micSetupWarnings = [];
        micSessionGen += 1;  // any in-flight YIN frame becomes stale
        if (micTimer) { clearInterval(micTimer); micTimer = null; }
        if (micProcessor) {
            try { micProcessor.disconnect(); } catch (_) { /* noop */ }
            micProcessor.onaudioprocess = null;
            micProcessor = null;
        }
        if (micSourceNode) {
            try { micSourceNode.disconnect(); } catch (_) { /* noop */ }
            micSourceNode = null;
        }
        if (micStream) {
            try { micStream.getTracks().forEach((t) => t.stop()); } catch (_) { /* noop */ }
            micStream = null;
        }
        if (micCtx) {
            try { micCtx.close(); } catch (_) { /* noop */ }
            micCtx = null;
        }
        micRingBuffer = null;
        micRingCount = 0;
        micPendingBuffer = null;
        micPendingReady = false;
        micPendingBufferAt = -Infinity;
        micLastCapturedAt = -Infinity;
        if (!keepFlag) {
            try { localStorage.setItem(_LK_STORAGE_KEY, '0'); } catch (_) { /* noop */ }
        }
        micState = 'off';
        refreshMicUi();
    }

    function ensureMicButton() {
        if (micBtn) return;
        if (!toggleBtn || !toggleBtn.parentNode) return;
        micBtn = document.createElement('button');
        micBtn.id = 'btn-karaoke-mic';
        micBtn.type = 'button';
        micBtn.disabled = true;
        micBtn.className = BTN_CLASS_DISABLED;
        micBtn.textContent = '🎤';
        micBtn.title = 'Toggle live mic feedback';
        micBtn.setAttribute('aria-label', 'Toggle live mic feedback');
        micBtn.setAttribute('aria-pressed', 'false');
        micBtn.addEventListener('click', onMicClick);
        toggleBtn.parentNode.insertBefore(micBtn, toggleBtn.nextSibling);

        micPill = document.createElement('span');
        micPill.id = 'btn-karaoke-mic-pill';
        micPill.className = 'text-xs text-gray-500 ml-1 inline-block min-w-8 text-center';
        micPill.textContent = '';
        toggleBtn.parentNode.insertBefore(micPill, micBtn.nextSibling);

        diffSelect = document.createElement('select');
        diffSelect.id = 'btn-karaoke-difficulty';
        diffSelect.className = 'ml-1 bg-dark-600 text-gray-300 text-xs rounded-lg px-2 py-1.5';
        diffSelect.title = 'Vocal difficulty';
        diffSelect.setAttribute('aria-label', 'Vocal difficulty');
        for (const d of Object.values(DIFFICULTIES)) {
            const opt = document.createElement('option');
            opt.value = d.id;
            opt.textContent = d.label;
            diffSelect.appendChild(opt);
        }
        diffSelect.value = overrides.difficulty();
        refreshDiffSelectLock();
        diffSelect.addEventListener('change', () => {
            setDifficulty(diffSelect.value);
            onDifficultyChanged();
            // Hand focus back so space/arrow shortcuts drive the player
            // again instead of silently changing difficulty.
            diffSelect.blur();
        });
        toggleBtn.parentNode.insertBefore(diffSelect, micPill.nextSibling);

        micSelect = document.createElement('select');
        micSelect.id = 'btn-karaoke-mic-device';
        micSelect.className = 'ml-1 bg-dark-600 text-gray-300 text-xs rounded-lg px-2 py-1.5 max-w-[11rem]';
        micSelect.title = 'Microphone for karaoke';
        micSelect.setAttribute('aria-label', 'Microphone for karaoke');
        micSelect.addEventListener('change', () => {
            onMicDeviceChosen(micSelect.value);
            micSelect.blur();
        });
        toggleBtn.parentNode.insertBefore(micSelect, diffSelect.nextSibling);

        monitorSlider = document.createElement('input');
        monitorSlider.type = 'range';
        monitorSlider.id = 'btn-karaoke-monitor-volume';
        monitorSlider.min = '0';
        monitorSlider.max = '100';
        monitorSlider.step = '5';
        monitorSlider.value = String(Math.round(getMonitorVolume() * 100));
        monitorSlider.className = 'ml-1 w-20 accent-accent align-middle';
        monitorSlider.title = `Your voice volume: ${monitorSlider.value}%`;
        monitorSlider.setAttribute('aria-label', 'Your voice volume');
        monitorSlider.addEventListener('input', () => {
            setMonitorVolume(Number(monitorSlider.value) / 100);
            monitorSlider.title = `Your voice volume: ${monitorSlider.value}%`;
            if (monitorGain && micCtx) monitorGain.gain.setTargetAtTime(monitorGainFor(getMonitorVolume()), micCtx.currentTime, 0.02);
        });
        monitorSlider.addEventListener('change', () => monitorSlider.blur());
        toggleBtn.parentNode.insertBefore(monitorSlider, micSelect.nextSibling);
        refreshMicPickers();
        if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === 'function') {
            navigator.mediaDevices.addEventListener('devicechange', () => refreshMicPickers());
        }

        micBtn.style.display = 'none';
        micPill.style.display = 'none';
        diffSelect.style.display = 'none';
        micSelect.style.display = 'none';
        monitorSlider.style.display = 'none';
    }

    async function onMicClick() {
        if (micBtn && micBtn.disabled) return;
        if (micState === 'listening') {
            // User-initiated stop — clear the per-song intent so karaoke
            // off/on for this song doesn't auto-resume a mic the user
            // explicitly turned off.
            micWantOnForSong = false;
            stopMic({ keepFlag: false });
            resetUserResults();
            return;
        }
        // 'off' or 'error' — request (or retry) mic acquisition.
        await startMic();
    }

    function refreshMicUi() {
        if (!micBtn) return;
        const sloppak = isSloppakSong(currentSong);
        const eligible = sloppak && karaokeMode && !!status && status.has_pitch && songHasMidi();
        if (diffSelect) diffSelect.style.display = eligible ? '' : 'none';
        if (micSelect) micSelect.style.display = eligible ? '' : 'none';
        if (monitorSlider) monitorSlider.style.display = eligible ? '' : 'none';
        if (!eligible) {
            micBtn.style.display = 'none';
            if (micPill) micPill.style.display = 'none';
            return;
        }
        micBtn.style.display = '';
        if (micPill) micPill.style.display = '';

        switch (micState) {
            case 'requesting':
                micBtn.disabled = true;
                micBtn.className = BTN_CLASS_DISABLED;
                micBtn.title = 'Requesting microphone…';
                micBtn.setAttribute('aria-label', 'Requesting microphone…');
                micBtn.setAttribute('aria-pressed', 'false');
                if (micPill) { micPill.textContent = '…'; micPillLastText = '…'; }
                break;
            case 'listening':
                micBtn.disabled = false;
                micBtn.className = BTN_CLASS_ACTIVE;
                micBtn.title = [
                    `Listening on ${micDeviceLabel || 'your chosen mic'} — click to stop`,
                    ...micSetupWarnings,
                ].filter(Boolean).join('\n');
                micBtn.setAttribute('aria-label', 'Stop live mic feedback');
                micBtn.setAttribute('aria-pressed', 'true');
                micPillLastText = '';
                // Pill text is set by updateMicPill() each render frame.
                break;
            case 'error':
                micBtn.disabled = false;
                micBtn.className = BTN_CLASS_PROMPT;
                micBtn.title = 'Mic feedback error: ' + (micErrorMsg || 'unknown') + ' (click to retry)';
                micBtn.setAttribute('aria-label', 'Mic error — click to retry');
                micBtn.setAttribute('aria-pressed', 'false');
                if (micPill) { micPill.textContent = '!'; micPillLastText = '!'; }
                break;
            default:  // 'off'
                micBtn.disabled = false;
                micBtn.className = BTN_CLASS_PROMPT;
                micBtn.title = 'Toggle live mic feedback';
                micBtn.setAttribute('aria-label', 'Toggle live mic feedback');
                micBtn.setAttribute('aria-pressed', 'false');
                if (micPill) { micPill.textContent = ''; micPillLastText = ''; }
                break;
        }
    }

    function updateMicPill() {
        if (!micPill || micState !== 'listening') return;
        const text = (userDisplayMidi == null || !isFinite(userDisplayMidi))
            ? '—'
            : midiToName(userDisplayMidi);
        if (text === micPillLastText) return;
        micPillLastText = text;
        micPill.textContent = text;
    }

    // ── Song lifecycle wiring ──────────────────────────────────────────

    function resetForNewSong(song) {
        // If the previous song had karaoke mode on, the highway's
        // showLyrics flag is currently forced to false. Restore the
        // user's saved preference BEFORE we lose track of it — the
        // highway carries showLyrics across songs (it lives in factory
        // closure state and is only reset by toggleLyrics()), so
        // forgetting to restore here would leave text lyrics hidden on
        // the next song that doesn't support karaoke.
        if (karaokeMode) {
            if (window.highway && typeof window.highway.setLyricsVisible === 'function') {
                window.highway.setLyricsVisible(savedShowLyrics);
            }
            karaokeMode = false;
        }
        currentSong = song || null;
        status = null;
        pitchData = null;
        tokenIndexMap = new Map();
        songPitchRange = null;
        // Tear the overlay all the way down so a previous song's bars
        // don't briefly flash for the new song before its data arrives.
        teardownOverlay();
        // Drop mic state with the song. keepFlag preserves the
        // localStorage on/off bit (a future "remember on reload"
        // surface), but micWantOnForSong is per-song so a one-time
        // opt-in on song A doesn't auto-prompt on song B.
        if (micState !== 'off') stopMic({ keepFlag: true });
        micWantOnForSong = false;
        resetUserResults();
        refreshButtonState();
    }

    function onSongLoaded(song) {
        songLoadFor = song && song.filename;
        songLoad = loadSong(song);
        return songLoad;
    }

    async function loadSong(song) {
        resetForNewSong(song);
        ensureToggleButton();
        refreshButtonState();
        if (!isSloppakSong(song)) return;
        await fetchStatus(song.filename);
        // Pre-fetch pitch data so the first toggle is instant.
        if (status && status.has_pitch) {
            await fetchPitchData(song.filename);
        }
        refreshButtonState();
    }

    // ══════════════════════════════════════════════════════════════════
    // SETUP SCREEN — wizard for "Add karaoke to this song"
    // ══════════════════════════════════════════════════════════════════
    //
    // The setup screen DOM is in screen.html. The functions below are
    // exposed on window.lk* because screen.html uses inline onclick=
    // attributes (innerHTML-injected screens can't hydrate via
    // addEventListener at parse time — that's a Slopsmith convention,
    // not a personal preference).

    const setup = {
        selectedFilename: null,
        selectedTitle: '',
        selectedArtist: '',
        // Last alignment result (returned by /align). Held in memory
        // until the build pipeline auto-saves or the user discards.
        alignmentResult: null,
        // Last status fetch for the SETUP screen — kept separate from
        // the player overlay's `status` so a song change in the player
        // doesn't blow away setup state mid-build.
        status: null,
    };

    function setupEl(id) { return document.getElementById(id); }

    async function refreshServerStatus() {
        const el = setupEl('lk-server-status');
        if (!el) return;
        try {
            const res = await safeFetch('/api/plugins/lyrics_karaoke/server-status');
            const ok = res.ok && res.body && res.body.available;
            if (ok) {
                el.innerHTML =
                    '<div class="bg-green-900/20 border border-green-800/30 rounded-xl p-3 text-sm">' +
                    '<span class="text-green-400">Alignment server ready</span>' +
                    '</div>';
            } else {
                const reason = (res.body && res.body.reason) || 'Unknown error';
                el.innerHTML =
                    '<div class="bg-yellow-900/20 border border-yellow-800/30 rounded-xl p-4 text-sm">' +
                    '<p class="text-yellow-400 font-semibold mb-1">Alignment server unavailable</p>' +
                    '<p class="text-gray-400">' + escHtml(reason) + '</p>' +
                    '<p class="text-gray-500 mt-1">Set <code>demucs_server_url</code> in Stems / Sloppak Converter settings.</p>' +
                    '</div>';
            }
        } catch (_) {
            el.innerHTML =
                '<div class="bg-red-900/20 border border-red-800/30 rounded-xl p-3 text-sm">' +
                '<span class="text-red-400">Failed to check alignment server</span>' +
                '</div>';
        }
    }

    function escHtml(s) {
        // Local minimal HTML escape — keeps the plugin's setup-screen
        // markup safe even if app.js's global esc() helper is missing.
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    async function lkSearchSongs() {
        const input = setupEl('lk-search');
        const q = (input && input.value || '').trim();
        const container = setupEl('lk-search-results');
        if (!container) return;
        if (!q) {
            container.innerHTML = '';
            return;
        }
        const url = `/api/library?q=${encodeURIComponent(q)}&page=0&size=20&sort=artist&format=sloppak`;
        const res = await safeFetch(url);
        if (!res.ok) {
            container.innerHTML = '<p class="text-gray-500 text-xs py-2">Search failed.</p>';
            return;
        }
        const songs = (res.body && res.body.songs) || [];
        // Karaoke needs split stems (vocals.ogg). The library returns
        // stem_count; >1 means Demucs has run on this song. Songs with
        // only `full.ogg` aren't useful here — surface a hint instead
        // of silently dropping them.
        const withStems = songs.filter((s) => (s.stem_count || 0) > 1);
        const withoutStems = songs.length - withStems.length;
        if (!withStems.length) {
            container.innerHTML =
                '<p class="text-gray-500 text-xs py-2">' +
                'No sloppak songs with split stems matched. ' +
                'Run Demucs split (Stems plugin / Sloppak Converter) on a song first.' +
                (withoutStems > 0 ? ` (${withoutStems} matched without stems.)` : '') +
                '</p>';
            return;
        }
        container.innerHTML = withStems.map((s) => {
            const fn = encodeURIComponent(s.filename);
            const title = escHtml(s.title);
            const artist = escHtml(s.artist);
            // Stash the raw values on data attributes so the click
            // handler can read them without the brittle inline-string
            // escape dance the old lyrics_sync plugin used.
            return (
                '<div class="flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-dark-700/50 transition cursor-pointer" ' +
                'data-fn="' + fn + '" data-title="' + title + '" data-artist="' + artist + '" ' +
                'onclick="lkSelectFromResult(this)">' +
                '  <div class="flex-1 min-w-0">' +
                '    <span class="text-sm text-white">' + title + '</span> ' +
                '    <span class="text-xs text-gray-500 ml-2">' + artist + '</span>' +
                '  </div>' +
                '  <span class="text-xs text-gray-600">' + (s.stem_count | 0) + ' stems</span>' +
                '</div>'
            );
        }).join('');
    }

    function lkSelectFromResult(div) {
        if (!div) return;
        const fn = decodeURIComponent(div.getAttribute('data-fn') || '');
        const title = div.getAttribute('data-title') || '';
        const artist = div.getAttribute('data-artist') || '';
        lkSelectSong(fn, title, artist);
    }

    async function lkSelectSong(filename, title, artist) {
        setup.selectedFilename = filename;
        setup.selectedTitle = title;
        setup.selectedArtist = artist;
        setup.alignmentResult = null;
        const results = setupEl('lk-search-results');
        if (results) results.innerHTML = '';
        const search = setupEl('lk-search');
        if (search) search.value = '';
        const sel = setupEl('lk-selected-song');
        const lbl = setupEl('lk-selected-label');
        if (sel) sel.classList.remove('hidden');
        if (lbl) lbl.textContent = `${title} — ${artist}`;
        await refreshSetupStatus();
    }

    function lkClearSong() {
        setup.selectedFilename = null;
        setup.selectedTitle = '';
        setup.selectedArtist = '';
        setup.alignmentResult = null;
        setup.status = null;
        const sel = setupEl('lk-selected-song');
        const lbl = setupEl('lk-selected-label');
        if (sel) sel.classList.add('hidden');
        if (lbl) lbl.textContent = '';
        // Hide all the per-song sections.
        for (const id of ['lk-checklist-section', 'lk-lyrics-section', 'lk-build-section', 'lk-done', 'lk-progress', 'lk-error']) {
            const el = setupEl(id);
            if (el) el.classList.add('hidden');
        }
    }

    async function refreshSetupStatus() {
        if (!setup.selectedFilename) return;
        const url = `/api/plugins/lyrics_karaoke/status?filename=${encodeURIComponent(setup.selectedFilename)}`;
        const res = await safeFetch(url);
        if (!res.ok) return;
        // Pinned to selectedFilename — refreshSetupStatus is called from
        // synchronous flows (selectSong, post-build), so a song-change
        // race would manifest as a stale status. Cheap to guard.
        if (!res.body || res.body.filename !== setup.selectedFilename) return;
        setup.status = res.body;
        renderSetupStatus();
    }

    function renderSetupStatus() {
        const s = setup.status;
        if (!s) return;
        const checklist = setupEl('lk-checklist');
        const checklistSection = setupEl('lk-checklist-section');
        if (checklistSection) checklistSection.classList.remove('hidden');

        // Update the three checklist rows by data-key.
        function setRow(key, mark, klass, detail) {
            if (!checklist) return;
            const row = checklist.querySelector(`li[data-key="${key}"]`);
            if (!row) return;
            const check = row.querySelector('.lk-check');
            const det = row.querySelector('.lk-detail');
            if (check) {
                check.textContent = mark;
                check.className = 'lk-check w-5 ' + klass;
            }
            if (det) det.textContent = detail || '';
        }

        if (s.has_vocals) {
            setRow('vocals', '✓', 'text-green-400', 'stems/vocals.ogg');
        } else {
            setRow('vocals', '✗', 'text-red-400', 'Run Demucs split first');
        }

        if (s.has_lyrics) {
            setRow('lyrics', '✓', 'text-green-400', 'lyrics.json present');
        } else {
            setRow('lyrics', '✗', 'text-yellow-400', 'Paste plain text below');
        }

        if (s.has_pitch) {
            setRow('pitch', '✓', 'text-green-400', `${s.pitch_count} voiced syllables`);
        } else if (!s.has_lyrics) {
            setRow('pitch', '⏸', 'text-gray-500', 'Waiting for synced lyrics');
        } else {
            setRow('pitch', '✗', 'text-yellow-400', 'Will extract on Build');
        }

        // Lyrics input section — show only when synced lyrics are missing
        // AND vocals exist (no point pasting text without a stem to align).
        const lyricsSection = setupEl('lk-lyrics-section');
        if (lyricsSection) {
            if (!s.has_lyrics && s.has_vocals) {
                lyricsSection.classList.remove('hidden');
            } else {
                lyricsSection.classList.add('hidden');
            }
        }

        // Build section — visible if vocals exist and either lyrics need
        // aligning or pitch needs extracting. Hidden when there's
        // genuinely nothing to do (everything ready) — that surface goes
        // to the done state instead.
        const buildSection = setupEl('lk-build-section');
        const doneSection = setupEl('lk-done');
        if (s.has_vocals && (!s.has_lyrics || !s.has_pitch)) {
            if (buildSection) buildSection.classList.remove('hidden');
            if (doneSection) doneSection.classList.add('hidden');
        } else if (s.has_vocals && s.has_lyrics && s.has_pitch) {
            if (buildSection) buildSection.classList.add('hidden');
            renderDoneState(s);
        } else {
            // No vocals — neither section is actionable.
            if (buildSection) buildSection.classList.add('hidden');
            if (doneSection) doneSection.classList.add('hidden');
        }

        updateBuildBtn();
    }

    function renderDoneState(s) {
        const doneSection = setupEl('lk-done');
        const detail = setupEl('lk-done-detail');
        if (doneSection) doneSection.classList.remove('hidden');
        if (detail) {
            detail.textContent =
                `${setup.selectedArtist} — ${setup.selectedTitle} has lyrics + pitch persisted` +
                ` (${s.pitch_count || 0} voiced syllables). Open in the player and toggle Karaoke.`;
        }
        // Only offer the .lrc download if we have a fresh alignment
        // result in memory — re-loading from disk would lose word/line
        // boundaries that the export format expects.
        const exportBtn = setupEl('lk-export-btn');
        if (exportBtn) {
            if (setup.alignmentResult && setup.alignmentResult.length) {
                exportBtn.classList.remove('hidden');
            } else {
                exportBtn.classList.add('hidden');
            }
        }
    }

    function updateBuildBtn() {
        const btn = setupEl('lk-build-btn');
        if (!btn) return;
        const s = setup.status;
        if (!s || !setup.selectedFilename || !s.has_vocals) {
            btn.disabled = true;
            return;
        }
        // If lyrics are missing, we need pasted text to align. If lyrics
        // are present (only pitch missing), we can build with no input.
        if (!s.has_lyrics) {
            const ta = setupEl('lk-lyrics');
            const has = ta && ta.value.trim().length > 0;
            btn.disabled = !has;
            btn.textContent = 'Build Karaoke';
        } else if (!s.has_pitch) {
            btn.disabled = false;
            btn.textContent = 'Extract pitch';
        } else {
            btn.disabled = true;
            btn.textContent = 'Karaoke ready';
        }
    }

    function lkFileUpload(input) {
        const file = input && input.files && input.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            const ta = setupEl('lk-lyrics');
            if (ta) ta.value = String(reader.result || '');
            lkUpdateLineCount();
            updateBuildBtn();
        };
        reader.readAsText(file);
        input.value = '';
    }

    function lkUpdateLineCount() {
        const ta = setupEl('lk-lyrics');
        const out = setupEl('lk-lyrics-count');
        const text = ta ? ta.value.trim() : '';
        const count = text ? text.split('\n').filter((l) => l.trim()).length : 0;
        if (out) out.textContent = `${count} line${count !== 1 ? 's' : ''}`;
    }

    function setupGranularity() {
        const checked = document.querySelector('input[name="lk-granularity"]:checked');
        return checked ? checked.value : 'syllable';
    }

    function showProgress(label, detail) {
        const p = setupEl('lk-progress');
        const lbl = setupEl('lk-progress-label');
        const det = setupEl('lk-progress-detail');
        if (p) p.classList.remove('hidden');
        if (lbl) lbl.textContent = label || 'Working…';
        if (det) det.textContent = detail || '';
        const err = setupEl('lk-error');
        if (err) err.classList.add('hidden');
    }

    function hideProgress() {
        const p = setupEl('lk-progress');
        if (p) p.classList.add('hidden');
    }

    function showError(msg) {
        hideProgress();
        const err = setupEl('lk-error');
        const det = setupEl('lk-error-detail');
        if (err) err.classList.remove('hidden');
        if (det) det.textContent = msg || 'Unknown error';
    }

    async function lkBuild() {
        if (!setup.selectedFilename || !setup.status) return;
        const filename = setup.selectedFilename;
        const btn = setupEl('lk-build-btn');
        if (btn) btn.disabled = true;

        try {
            // Step 1 — align lyrics if missing.
            if (!setup.status.has_lyrics) {
                const ta = setupEl('lk-lyrics');
                const text = ta ? ta.value.trim() : '';
                if (!text) { showError('Paste lyrics text first.'); return; }
                showProgress('Aligning lyrics with Whisper…', 'This can take a minute on the alignment server.');
                const lang = (setupEl('lk-language') || {}).value || '';
                const granularity = setupGranularity();
                const alignRes = await safeFetch('/api/plugins/lyrics_karaoke/align', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        filename,
                        lyrics_text: text,
                        language: lang || undefined,
                        granularity,
                    }),
                });
                if (filename !== setup.selectedFilename) return;
                if (!alignRes.ok || !alignRes.body || !Array.isArray(alignRes.body.segments)) {
                    showError((alignRes.body && alignRes.body.error) || `Alignment failed (${alignRes.status})`);
                    return;
                }
                setup.alignmentResult = alignRes.body.segments;

                showProgress('Saving aligned lyrics…');
                const saveRes = await safeFetch('/api/plugins/lyrics_karaoke/save-lyrics', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filename, segments: setup.alignmentResult }),
                });
                if (filename !== setup.selectedFilename) return;
                if (!saveRes.ok) {
                    showError((saveRes.body && saveRes.body.error) || `Save failed (${saveRes.status})`);
                    return;
                }
            }

            // Step 2 — extract pitch (always do this; status flag may be
            // stale after step 1 wrote new lyrics).
            showProgress('Extracting per-syllable pitch with pYIN…', 'Reading the vocals stem; ~30s for a 4-min song.');
            const pitchRes = await safeFetch('/api/plugins/lyrics_karaoke/generate-pitch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename }),
            });
            if (filename !== setup.selectedFilename) return;
            if (!pitchRes.ok) {
                showError((pitchRes.body && pitchRes.body.error) || `Pitch extraction failed (${pitchRes.status})`);
                return;
            }

            // Refresh status and render the done state.
            hideProgress();
            await refreshSetupStatus();
            // Also refresh the player overlay's cached status for this
            // song so the in-player toggle picks up the new pitch data
            // immediately if the user navigates straight to playback.
            if (currentSong && currentSong.filename === filename) {
                await fetchStatus(filename);
                refreshButtonState();
            }
        } catch (e) {
            showError(e && e.message ? e.message : String(e));
        } finally {
            if (btn) btn.disabled = false;
            updateBuildBtn();
        }
    }

    async function lkRedoPitch() {
        if (!setup.selectedFilename) return;
        const filename = setup.selectedFilename;
        showProgress('Re-extracting per-syllable pitch…');
        const res = await safeFetch('/api/plugins/lyrics_karaoke/generate-pitch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename }),
        });
        if (filename !== setup.selectedFilename) return;
        if (!res.ok) {
            showError((res.body && res.body.error) || `Pitch extraction failed (${res.status})`);
            return;
        }
        hideProgress();
        await refreshSetupStatus();
        if (currentSong && currentSong.filename === filename) {
            pitchData = null;  // force the player overlay to refetch on toggle
            tokenIndexMap = new Map();
            await fetchStatus(filename);
            refreshButtonState();
        }
    }

    async function lkExport() {
        if (!setup.alignmentResult || !setup.alignmentResult.length) return;
        const res = await fetch('/api/plugins/lyrics_karaoke/export', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                segments: setup.alignmentResult,
                title: setup.selectedTitle,
                artist: setup.selectedArtist,
            }),
        });
        if (!res.ok) return;
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const disposition = res.headers.get('Content-Disposition') || '';
        const match = disposition.match(/filename="(.+)"/);
        a.download = match ? match[1] : 'lyrics.lrc';
        a.href = url;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    function lkOpenInPlayer() {
        if (!setup.selectedFilename) return;
        if (typeof window.playSong === 'function') {
            window.playSong(setup.selectedFilename);
        } else if (typeof window.showScreen === 'function') {
            window.showScreen('player');
        }
    }

    // Bind input listeners after the screen is injected. The setup
    // screen's <textarea> isn't in the DOM at script-load time (it's
    // added when loadPlugins() injects the screen HTML), so attach
    // lazily on first showScreen('plugin-lyrics_karaoke').
    let setupHydrated = false;
    function hydrateSetupScreen() {
        if (setupHydrated) return;
        const ta = setupEl('lk-lyrics');
        if (!ta) return;  // screen not in DOM yet
        ta.addEventListener('input', () => { lkUpdateLineCount(); updateBuildBtn(); });
        setupHydrated = true;
    }

    function onSetupScreenShown() {
        hydrateSetupScreen();
        refreshServerStatus();
        // Don't auto-clear selection — users who drilled into a song
        // and back-buttoned to the screen expect their selection to
        // persist.
        if (setup.selectedFilename) {
            refreshSetupStatus();
        }
    }

    // Read-only diagnostics for debugging a live session (DevTools console:
    // lyricsKaraokeDiag()). Never mutates state.
    window.lyricsKaraokeDiag = () => ({
        micState, micErrorMsg, device: micDeviceLabel, warnings: micSetupWarnings.slice(),
        ctxState: micCtx ? micCtx.state : null,
        sampleRate: micCtx ? micCtx.sampleRate : null,
        sinkId: micCtx && 'sinkId' in micCtx ? micCtx.sinkId : null,
        monitorGain: monitorGain ? monitorGain.gain.value : null,
        trackState: micStream ? micStream.getAudioTracks().map((t) => ({ label: t.label, enabled: t.enabled, muted: t.muted, readyState: t.readyState })) : null,
        difficulty: overrides.difficulty(),
        hearMyself: overrides.hearMyself(),
        scoreHudHidden: overrides.scoreHudHidden(),
        stripHosted: resolveHost() !== document.getElementById('player'),
        ...diag,
    });

    // Public API for other plugins (Build-a-Band). See README.md.
    window.lyricsKaraoke = createKaraokeApi({
        overrides,
        mountStrip(el) {
            stripHost = el;
            if (!overlayEl) return;
            const host = resolveHost();
            if (!host) return;
            placeOverlay(host);
            sizeCanvas();
        },
        setKaraokeMode: apiSetKaraokeMode,
        isKaraokeMode: () => karaokeMode,
        startMic,
        stopMic: () => { if (micState !== 'off') { stopMic({ keepFlag: true }); resetUserResults(); } },
        getMicState: () => micState,
        onDifficultyChanged,
        applyHearMyself,
        getSnapshot: () => (scorer ? scorer.snapshot() : null),
    });

    // Turn karaoke mode on once the current song's status and pitch data
    // are in (song:ready can beat karaoke's own song:loaded fetches).
    async function apiSetKaraokeMode(on) {
        if (!on) {
            setKaraokeMode(false);
            return karaokeMode;
        }
        const filename = currentSong && currentSong.filename;
        if (!filename) return false;
        try { await songLoad; } catch (_) { /* its own error path */ }
        if (!currentSong || currentSong.filename !== filename) return false;
        if (!status || !status.has_pitch) return false;
        if (!pitchData) {
            await fetchPitchData(filename);
            if (!currentSong || currentSong.filename !== filename) return false;
        }
        setKaraokeMode(!!pitchData);
        return karaokeMode;
    }

    // Expose setup-screen API for inline onclick= handlers.
    window.lkSearchSongs = lkSearchSongs;
    window.lkSelectFromResult = lkSelectFromResult;
    window.lkClearSong = lkClearSong;
    window.lkBuild = lkBuild;
    window.lkRedoPitch = lkRedoPitch;
    window.lkExport = lkExport;
    window.lkOpenInPlayer = lkOpenInPlayer;
    window.lkFileUpload = lkFileUpload;

    // ══════════════════════════════════════════════════════════════════
    // SETTINGS PAGE — difficulty, mic device, latency (settings.html)
    // ══════════════════════════════════════════════════════════════════

    function applyMicOptions(sel, devices) {
        sel.innerHTML = '';
        for (const o of buildMicOptions(devices, getDeviceId())) {
            const opt = document.createElement('option');
            opt.value = o.value;
            opt.textContent = o.label;
            opt.selected = o.selected;
            sel.appendChild(opt);
        }
    }

    async function fillDeviceSelect(sel, msgEl) {
        let devices = [];
        try { devices = await listInputDevices(); } catch (_) { /* noop */ }
        applyMicOptions(sel, devices);
        if (msgEl) {
            const unnamed = devices.length > 0 && devices.every((d) => /^Microphone \d+$/.test(d.label));
            msgEl.textContent = unnamed ? 'Click "Show device names" to see microphone names.' : '';
        }
    }

    // Keep every mic picker (settings page + player) in step with the
    // saved choice and the devices currently plugged in.
    async function refreshMicPickers() {
        let devices = [];
        try { devices = await listInputDevices(); } catch (_) { /* noop */ }
        if (micSelect) applyMicOptions(micSelect, devices);
        const setSel = document.getElementById('lk-set-device');
        if (setSel) applyMicOptions(setSel, devices);
    }

    // Explicit, user-requested permission prompt so device names appear.
    // The stream is stopped at once; nothing listens to it.
    async function unlockMicNames() {
        try {
            const s = await navigator.mediaDevices.getUserMedia({ audio: true });
            s.getTracks().forEach((t) => t.stop());
        } catch (_) { /* permission denied — the list stays unnamed */ }
        refreshMicPickers();
    }

    function promptMicPicker() {
        if (!micSelect || micSelect.style.display === 'none') return;
        micSelect.classList.add('ring-2', 'ring-red-400');
        try { micSelect.focus(); } catch (_) { /* noop */ }
    }

    async function onMicDeviceChosen(deviceId) {
        if (micSelect) micSelect.classList.remove('ring-2', 'ring-red-400');
        if (deviceId === SHOW_MIC_NAMES) { await unlockMicNames(); return; }
        setDeviceId(deviceId);
        refreshMicPickers();
        // Switch the live mic straight away rather than on the next start.
        if (micState === 'listening' || micState === 'error') {
            stopMic({ keepFlag: true });
            await startMic();
        }
    }

    function hydrateSettings() {
        const diffSel = document.getElementById('lk-set-difficulty');
        if (!diffSel || diffSel.dataset.lkHydrated) return;
        diffSel.dataset.lkHydrated = '1';

        for (const d of Object.values(DIFFICULTIES)) {
            const opt = document.createElement('option');
            opt.value = d.id;
            opt.textContent = d.label;
            diffSel.appendChild(opt);
        }
        diffSel.value = getDifficulty();
        diffSel.addEventListener('change', () => { setDifficulty(diffSel.value); onDifficultyChanged(); });

        const devSel = document.getElementById('lk-set-device');
        const devMsg = document.getElementById('lk-set-device-msg');
        const namesBtn = document.getElementById('lk-set-device-names');
        if (devSel) {
            fillDeviceSelect(devSel, devMsg);
            devSel.addEventListener('change', () => onMicDeviceChosen(devSel.value));
        }
        if (namesBtn && devSel) {
            namesBtn.addEventListener('click', async () => {
                // Device labels are hidden until the page has mic permission.
                try {
                    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
                    s.getTracks().forEach((t) => t.stop());
                } catch (e) {
                    if (devMsg) devMsg.textContent = 'Microphone permission was denied.';
                    return;
                }
                fillDeviceSelect(devSel, devMsg);
            });
        }

        const lat = document.getElementById('lk-set-latency');
        const latVal = document.getElementById('lk-set-latency-val');
        if (lat) {
            lat.value = String(getLatencyMs());
            if (latVal) latVal.textContent = `${getLatencyMs()} ms`;
            lat.addEventListener('input', () => {
                setLatencyMs(lat.value);
                if (latVal) latVal.textContent = `${getLatencyMs()} ms`;
            });
        }
    }

    // Difficulty changes mid-song start scoring over at the new level.
    function onDifficultyChanged() {
        const d = overrides.difficulty();
        if (diffSelect && diffSelect.value !== d) diffSelect.value = d;
        refreshDiffSelectLock();
        const setSel = document.getElementById('lk-set-difficulty');
        if (setSel && setSel.value !== d) setSel.value = d;
        rebuildScorer();
        resetUserResults();
    }

    // While a host's difficulty override is active the player's picker
    // shows it and can't change it.
    function refreshDiffSelectLock() {
        if (!diffSelect) return;
        const locked = overrides.hasDifficulty();
        diffSelect.disabled = locked;
        diffSelect.title = locked ? 'Set on the band screen' : 'Vocal difficulty';
    }

    // ══════════════════════════════════════════════════════════════════
    // INIT
    // ══════════════════════════════════════════════════════════════════

    function init() {
        ensureToggleButton();
        hydrateSettings();
        if (window.slopsmith && typeof window.slopsmith.on === 'function') {
            // window.slopsmith is an EventTarget; .on() forwards to
            // addEventListener, so the handler receives a CustomEvent
            // whose `.detail` is the actual payload (the song info).
            window.slopsmith.on('song:loaded', (e) => onSongLoaded(e && e.detail));
            // Core's single repositioning funnel ({from, to, reason}). Seeks
            // backward start a new scoring pass; forward seeks skip phrases.
            window.slopsmith.on('song:seek', (e) => {
                const to = Number(e && e.detail && e.detail.to);
                if (!Number.isFinite(to)) return;
                if (scorer) {
                    scorer.seek(to - (micLatencyMs / 1000) * getPlaybackRate());
                    lastRating = null;
                    micLastCapturedAt = -Infinity;
                }
                busEmit(RESET_EVENT, scorer ? scorer.snapshot() : null);
            });
            // Catch-up: plugin scripts load after app.js, so the very
            // first `song:loaded` may have already fired by the time
            // this listener attaches. Read the cached currentSong as a
            // fallback. Subsequent songs go through the listener.
            if (window.slopsmith.currentSong) {
                onSongLoaded(window.slopsmith.currentSong);
            }
        }
        // showScreen wrapper — clean up overlays when leaving the player,
        // and hydrate the setup screen when entering it. Keep the
        // wrapper minimal so we play nice with other plugins that also
        // hook showScreen (load order isn't deterministic).
        const origShowScreen = window.showScreen;
        if (typeof origShowScreen === 'function') {
            window.showScreen = function (name) {
                const ret = origShowScreen.apply(this, arguments);
                if (name !== 'player') {
                    if (karaokeMode) setKaraokeMode(false);
                    teardownOverlay();
                    // setKaraokeMode(false) already stops the mic when
                    // karaoke was on; this catches the rare case where
                    // we leave the player while karaoke was already off
                    // but the mic somehow lingered.
                    if (micState !== 'off') { stopMic({ keepFlag: true }); resetUserResults(); }
                }
                if (name === 'plugin-lyrics_karaoke') {
                    onSetupScreenShown();
                }
                if (name === 'settings') hydrateSettings();
                return ret;
            };
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
