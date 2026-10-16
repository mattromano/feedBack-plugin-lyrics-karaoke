# Rock Band–style Vocal Scoring (Tier 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make lyrics_karaoke playable as a scored vocal part. It should ignore the octave when matching pitch, rate each phrase and keep a score, a multiplier and stars. It should have Easy, Medium, Hard and Expert difficulty, let the player choose the mic, and correct for mic latency.

**Architecture:** Switch the plugin to the host's ES-module layout (`scriptType: "module"`). `screen.js` becomes `import './src/main.js'`. The pure logic moves into small modules under `src/` that Node can test without a DOM:
- `pitch.js`: pitch maths
- `phrases.js`: phrase segmentation
- `scoring.js`: the scoring state machine
- `prefs.js`: settings

`src/main.js` holds today's `screen.js` body. It feeds YIN samples into the scorer and draws the HUD.

**Tech Stack:** Vanilla browser JS (ES modules, no build step), Web Audio + `getUserMedia`, `node --test` for JS tests, pytest for the existing `routes.py` tests.

**Spec:** The user's request in session (Tier 1 of the karaoke gap analysis): octave-agnostic matching, phrase ratings and score, difficulty levels, a mic picker and a latency offset. Talkies, the scrolling note lane, harmonies and core changes are explicitly **out of scope**.

## Global Constraints

- Repo: `~/Desktop/repos/feedback-upstream/feedBack-plugin-lyrics-karaoke`, branch `feature/rockband-vocal-scoring` (already created from `main` @ `14585eb`).
- Commit as `mattromano <42412983+mattromano@users.noreply.github.com>` with `git commit -s`. GitHub rejects the gmail address.
- Host is feedBack `0.3.0-alpha.1`. Set `"minHost": "0.3.0-alpha.1"` and `"scriptType": "module"`. Module files live under `src/` and are served by `/api/plugins/lyrics_karaoke/src/{path}`.
- No new runtime dependencies and no build step. `package.json` is `"type": "module"`, `"private": true`, with `"test": "node --test tests/*.test.mjs"`.
- All user settings go in `localStorage` under the prefix `lyrics_karaoke.`. Keys: `difficulty`, `deviceId`, `latencyMs`. Every read and write goes through try/catch.
- Leave the setup-screen code and `routes.py` unchanged.
- Bump `plugin.json` version `1.4.1` → `1.5.0`.

## Scoring rules (decided here; tasks reference these)

| Difficulty | `toleranceCents` (full credit) | Credit falls to 0 at | `fill` (share of a note you must cover) |
|---|---|---|---|
| easy | 250 | 375 | 0.50 |
| medium (default) | 175 | 262.5 | 0.60 |
| hard | 125 | 187.5 | 0.70 |
| expert | 75 | 112.5 | 0.80 |

- **Octave-agnostic error:** `cents = ((sung − target)·100)` wrapped into `[−600, 600)`.
- **Sample credit:**
  - 1 when `|cents| ≤ tol`.
  - Falls linearly to 0 at `tol·1.5`.
  - 0 beyond that.
- **Token credit:**
  - Each sample adds `credit × min(songDt, 0.1)` song-seconds to the token under the playhead.
  - `songDt` is the song time since the previous accepted sample.
  - Token accuracy = `min(1, credited / (d × fill))`.
  - Silence earns nothing, so a note you skip scores 0. Slow-speed practice still works because credit is counted in song time.
- **Phrase accuracy:** the duration-weighted mean of token accuracy over **pitched** tokens. A phrase with no pitched tokens is skipped: no rating, and the streak is unchanged.
- **Phrase finalizes** when the scored time passes `phrase.end + 0.25 s`.
- **Ratings** (thresholds on phrase accuracy): Awesome ≥ 0.90, Strong ≥ 0.75, Good ≥ 0.55, OK ≥ 0.35, Messy ≥ 0.15, Awful < 0.15.
- **Points:**
  - `round(1000 × accuracy) × multiplier`, using the multiplier in effect *before* this phrase.
  - Afterwards, Awesome, Strong or Good adds 1 to the streak; anything else sets it to 0.
  - `multiplier = 1 + min(streak, 3)`, which runs from 1× to 4×.
- **Stars:** from the mean accuracy of finalized rated phrases, with thresholds `[0.20, 0.40, 0.60, 0.75, 0.90]` giving 1 to 5 stars. 0 stars before any phrase is rated.
- **Phrase split:**
  - A new phrase starts after a token whose `w` ends in `+`.
  - A new phrase also starts when the gap to the next token is more than 4.0 s.
  - A phrase longer than 10.0 s is split before the first token that would push it past 10 s.
- **Latency:** `capturedAt = getNow() − (midpointWallSec + latencyMs/1000) × playbackRate`. Positive values mean "my voice arrives late". Range −100…400 ms, default 0, step 10.

## Review Focus

1. **Seeking backward or A-B practice loops:** the score resets cleanly with no phantom phrase ratings. Today's `delta < 0` path calls `scorer.reset()` (Task 4 test `reset on backward time`).
2. **Pause:** samples with `songDt ≤ 0.001` add no credit and finalize nothing (Task 4 test `paused samples add nothing`).
3. **Saved mic unplugged:** `OverconstrainedError` or `NotFoundError` with a saved `deviceId` retries on the system default and tells the user, instead of erroring (Task 5 test `isDeviceMissingError`, Task 6 manual step).
4. **Transcribed lyrics with no `+` markers:** phrases still split by gap and by the 10 s cap (Task 3 test `caps long phrases at 10s`).
5. **Phrase made only of unpitched tokens:** it doesn't break the streak or get rated (Task 4 test `unpitched phrase skipped`).

---

### Task 1: Move to the ES-module layout and add the JS test harness

Behaviour stays the same. This is only file movement.

**Files:**
- Create: `src/main.js` (the current contents of `screen.js`, unchanged)
- Modify: `screen.js` → one line: `import './src/main.js';`
- Modify: `plugin.json` (add `"scriptType": "module"`, `"minHost": "0.3.0-alpha.1"`, version `1.5.0`)
- Create: `package.json`, `tests/smoke.test.mjs`

- [ ] **Step 1:** `git mv screen.js src/main.js`, then write the new one-line `screen.js`. Update the header comment in `src/main.js` to say it is the module entry body.
- [ ] **Step 2:** Write `tests/smoke.test.mjs`. It asserts that `screen.js`'s text is exactly `import './src/main.js';\n` and that `node --check src/main.js` exits 0 (use `child_process.spawnSync`).
- [ ] **Step 3:** Run `npm test`. Expected: 1 pass. Run `python -m pytest tests -q`. Expected: all existing tests pass.
- [ ] **Step 4:** Commit: `refactor: switch to ES-module plugin layout`.

### Task 2: Pitch maths module

**Files:**
- Create: `src/pitch.js`, `tests/pitch.test.mjs`
- Modify: `src/main.js` (delete its local `freqToMidi`, `midiToName` and `yinDetect`, plus the `_yinWorkBuffer`, `_LK_PITCH_NAMES` and `_LK_MATCH_TOLERANCE` constants; import from `./pitch.js`)

**Interfaces (Produces):**
- `export const DIFFICULTIES = { easy, medium, hard, expert }`: each entry is `{ id, label, toleranceCents, fill }` with the values from the table.
- `export const DEFAULT_DIFFICULTY = 'medium'`
- `export function pitchClassCents(sungMidi: number, targetMidi: number): number`: result is in `[-600, 600)`.
- `export function sampleCredit(cents: number, toleranceCents: number): number`: result is in `[0, 1]`.
- `export function freqToMidi(hz)`, `export function midiToName(midi)`, `export function yinDetect(buffer, sampleRate, minFreqHz) → { freq, confidence }`: moved verbatim, with the work buffer kept module-local.

- [ ] **Step 1: Write the failing tests**
  - `pitchClassCents(48, 60) === 0` (an octave below matches)
  - `pitchClassCents(72.5, 60) === 50`
  - `pitchClassCents(59, 60) === -100`
  - `pitchClassCents(66, 60) === -600` (the tritone wraps to the lower bound)
  - `sampleCredit(0, 175) === 1`
  - `sampleCredit(175, 175) === 1`
  - `sampleCredit(-218.75, 175)` ≈ 0.5
  - `sampleCredit(262.5, 175) === 0`
  - `sampleCredit(600, 175) === 0`
  - `DIFFICULTIES.expert.toleranceCents === 75`
  - `DIFFICULTIES.easy.fill === 0.5`
  - `yinDetect` on a 2048-sample 220 Hz sine at 48 kHz returns a `freq` within 1 Hz of 220 and `confidence > 0.9`
  - `midiToName(69) === 'A4'`
- [ ] **Step 2:** Run `npm test`. Expected: FAIL (module not found).
- [ ] **Step 3:** Implement `src/pitch.js` and switch `src/main.js` to import from it.
- [ ] **Step 4:** Run `npm test` and `node --check src/main.js`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: octave-agnostic pitch credit and difficulty table`.

### Task 3: Phrase segmentation

**Files:** Create `src/phrases.js`, `tests/phrases.test.mjs`

**Interfaces (Produces):**
- `export function buildPhrases(tokens: Array<{t, d, w, midi?}>): Array<{ start: number, end: number, tokenIdxs: number[], pitchedIdxs: number[] }>`
  - Indices refer to the input array.
  - `end` is the max of `t + d`.
  - Follows the split rules in "Scoring rules".
  - Null or timeless tokens are skipped.
- `export const PHRASE_GAP_S = 4.0`, `export const PHRASE_MAX_S = 10.0`

- [ ] **Step 1: Write the failing tests**
  - Splits after the `+` suffix: `["Hel-","lo+","world+"]` → 2 phrases, tokenIdxs `[0,1]` and `[2]`.
  - Splits on a 4.5 s gap with no markers.
  - `caps long phrases at 10s`: 30 tokens, 0.5 s apart, 0.4 s long each, no markers → every phrase has `end − start ≤ 10.0`, and together they cover all 30 indices exactly once.
  - `pitchedIdxs` leaves out tokens without `midi`.
  - Empty input → `[]`.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement `buildPhrases` with a single pass that closes the current phrase on any of the three conditions.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: phrase segmentation for vocal scoring`.

### Task 4: Scorer state machine

**Files:** Create `src/scoring.js`, `tests/scoring.test.mjs`

**Interfaces:**
- Consumes: `DIFFICULTIES` and `pitchClassCents`/`sampleCredit` (Task 2); `buildPhrases` output (Task 3).
- Produces:
  - `export const RATINGS = ['Awesome','Strong','Good','OK','Messy','Awful']`
  - `export function rateAccuracy(acc: number): string`
  - `export function starsFor(meanAcc: number | null): 0|1|2|3|4|5`
  - `export function createScorer({ tokens, phrases, difficulty }): Scorer`. `Scorer` has:
    - `addSample({ t: number, midi: number }): void`: `t` is the latency-corrected song time.
      - It finds the latest-starting pitched token whose `[t0, t0 + d)` contains `t`, the same rule as today's `findActiveTokenIndex`.
      - It credits that token.
      - It tracks the previous `t` internally. On the first sample, `songDt` is 0.05.
      - If `t` moves backward, it calls `reset()` and then processes the sample.
    - `advanceTo(t: number): Array<{ phraseIndex, rating, accuracy, points, multiplierBefore }>`: finalizes every phrase whose `end + 0.25 ≤ t` that isn't finalized yet, in order, and returns those events.
    - `reset(): void`
    - `tokenAccuracy(idx: number): number | null`: `null` if the token was never reached.
    - `snapshot(): { score, multiplier, streak, stars, ratedCount }`

- [ ] **Step 1: Write the failing tests** (build tokens and phrases inline; sample every 0.05 s)
  - `octave-down singing is Awesome`: one phrase, two pitched tokens at midi 64 and 67, each 1 s long. Sing 52 and 55 across them on expert. `advanceTo(end + 0.3)` gives rating `Awesome` and points 1000.
  - `silence is Awful and resets streak`: three phrases. Sing phrases 0 and 1 perfectly and give no samples for phrase 2. Phrase points are 1000, then 2000, then 0. After that, `snapshot().streak === 0` and `multiplier === 1`.
  - `multiplier caps at 4`: 6 perfect phrases. The `multiplierBefore` sequence is `[1,2,3,4,4,4]`.
  - `difficulty changes outcome`: a constant +150-cent error gives accuracy 1 on medium and 0 on expert.
  - `paused samples add nothing`: repeated `addSample` at the same `t` leaves `tokenAccuracy` unchanged.
  - `reset on backward time`: finalize phrase 0, then `addSample` at an earlier `t`. `snapshot().score === 0` and `ratedCount === 0`.
  - `unpitched phrase skipped`: a phrase with no `midi` tokens produces no event from `advanceTo` and doesn't change the streak.
  - `starsFor(null) === 0`, `starsFor(0.76) === 4`, `rateAccuracy(0.55) === 'Good'`.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement following "Scoring rules" exactly.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: phrase rating, score, multiplier and stars`.

### Task 5: Prefs module and settings page (difficulty, mic, latency)

**Files:**
- Create: `src/prefs.js`, `settings.html`, `tests/prefs.test.mjs`
- Modify: `plugin.json` (add `"settings": { "html": "settings.html", "category": "audio" }`)

**Interfaces (Produces):**
- `export function getDifficulty(): string`, `export function setDifficulty(id)`: unknown or corrupt values fall back to `DEFAULT_DIFFICULTY`.
- `export function getDeviceId(): string`, `export function setDeviceId(id)`: `''` means system default.
- `export function getLatencyMs(): number`, `export function setLatencyMs(ms)`: clamped to −100…400 and rounded to steps of 10. Default 0.
- `export function micConstraints(deviceId: string): MediaStreamConstraints`: returns `{ audio: { echoCancellation:false, noiseSuppression:false, autoGainControl:false, channelCount:1, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) } }`.
- `export function isDeviceMissingError(e): boolean`: true for `name === 'OverconstrainedError'` with `constraint === 'deviceId'`, or `name === 'NotFoundError'`.
- `export async function listInputDevices(): Promise<Array<{ deviceId, label }>>`: `enumerateDevices()` filtered to `audioinput`. If a label is empty it becomes `Microphone N`.

**settings.html** follows the stems markup style. It has:
- `#lk-set-difficulty` (`<select>` of the 4 difficulties)
- `#lk-set-device` (`<select>`, first option "System default")
- `#lk-set-device-names` (button "Show device names": calls `getUserMedia({audio:true})`, stops the tracks, then re-lists)
- `#lk-set-latency` (range −100…400, step 10) with `#lk-set-latency-val` (ms readout)
- A one-line hint: "Raise this if your notes score late; USB headsets usually need 0–50 ms."

- [ ] **Step 1: Write the failing tests.** Set `globalThis.localStorage` to a Map-backed stub, and one that throws for the corrupt case.
  - Round-trips for all three settings.
  - `setLatencyMs(999)` → `getLatencyMs() === 400`
  - `setLatencyMs(-133)` → `-130`
  - A `localStorage` that throws → defaults are returned and nothing throws.
  - `micConstraints('')` has no `deviceId` key.
  - `micConstraints('abc').audio.deviceId.exact === 'abc'`
  - `isDeviceMissingError({name:'OverconstrainedError', constraint:'deviceId'})` → true
  - `isDeviceMissingError({name:'NotAllowedError'})` → false
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement `src/prefs.js` and write `settings.html`. Wire the settings controls in `src/main.js` `init()`: settings HTML is already in the DOM when the script loads, as in the stems plugin. Populate `#lk-set-device` with `listInputDevices()` and keep the saved selection.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: settings for difficulty, mic device and latency`.

### Task 6: Wire scoring, mic choice and latency into the player; draw the HUD

**Files:** Modify `src/main.js`, `CHANGELOG.md` (create it if missing, with a `1.5.0` entry)

**Interfaces:**
- Consumes everything from Tasks 2–5.

- [ ] **Step 1: Scorer lifecycle.**
  - Build `phrases = buildPhrases(pitchData.tokens)` and `scorer = createScorer({ tokens, phrases, difficulty: getDifficulty() })` in `fetchPitchData`.
  - `resetUserResults()` also calls `scorer?.reset()`.
  - Delete `userResults` and `findActiveTokenIndex`. In `processYinFrame`, after a voiced sample, call `scorer.addSample({ t: capturedAt, midi })`. Remove its own backward-seek branch: the scorer handles that now. Keep the pause drop (`delta < 1e-3`) and the `userPitchSamples` ring for the live pitch line.
- [ ] **Step 2: Latency.** In `onaudioprocess`, change `micPendingBufferAt` to the formula in "Scoring rules", reading `getLatencyMs()` once per mic start.
- [ ] **Step 3: Mic device.**
  - `startMic` uses `getUserMedia(micConstraints(getDeviceId()))`.
  - On `isDeviceMissingError(e)` with a non-empty device id, retry once with `micConstraints('')`. Then set `micNotice = 'Saved mic not found — using system default.'`, which is appended to the 🎤 button title while listening.
  - Also pass `{ latencyHint: 'interactive' }` to `new AudioContext(...)`.
- [ ] **Step 4: Difficulty in the player.**
  - Add a `<select id="btn-karaoke-difficulty">` after the mic pill in `ensureMicButton()`.
  - It follows the mic button's visibility rule in `refreshMicUi()`.
  - On `change`, call `setDifficulty`, rebuild the scorer and reset results.
- [ ] **Step 5: HUD in `drawFrame()`.**
  - Each frame, call `scorer.advanceTo(getNow() − latencyMs/1000)`. Keep the last event in `lastRating = { text, at: _wallNow() }`.
  - Draw these at the top right of the ribbon, only while the mic is listening or after something has been rated:
    - score (`toLocaleString()`)
    - `×N`
    - five stars (filled `★` for `snapshot().stars`, empty `☆` for the rest)
  - Show the rating text above the playhead for 1200 ms, fading out:
    - Awesome/Strong: `#ffe080`
    - Good/OK: `#9be7a0`
    - Messy/Awful: `#f87171`
  - Past bars are coloured from `scorer.tokenAccuracy(idx)` using the existing red→green formula. Skip tokens where it is `null`.
- [ ] **Step 6:** Run `npm test`, `node --check src/main.js` and `python -m pytest tests -q`. Expected: all pass.
- [ ] **Step 7: Manual check in the Mac app** with the Jabra EVOLVE 20.
  - Set up the plugin:
    - Run `../feedBack-desktop` dev or the installed build.
    - Point the plugin at this checkout. The plugins dir symlink is described in `slopsmith-custom/feedback-fork/dev-sync.sh`.
  - Check the settings page:
    - Settings → Lyrics Karaoke lists "Jabra EVOLVE 20" after "Show device names".
    - Select it.
  - Play a karaoke-ready sloppak:
    - Phrase ratings appear.
    - Singing an octave low still scores.
    - Switching to Expert lowers ratings.
    - A 100 ms latency setting moves where credit lands.
  - Unplug the Jabra and start the mic: it falls back with the notice.
- [ ] **Step 8:** Commit: `feat: Rock Band-style vocal scoring HUD in the karaoke overlay`.

## Not in this plan (later tiers)

Talkies, a scrolling note lane, hearing your own mic, an end-of-song results screen and scorecard integration, harmonies, and the core data or import work (Rocksmith XML pitch, `PART VOCALS`).
