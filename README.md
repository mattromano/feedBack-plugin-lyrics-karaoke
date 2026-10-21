# Lyrics Karaoke

A feedBack plugin for karaoke-style synced lyrics during playback.

- **Setup screen** ("Lyrics Karaoke" in the nav): picks a sloppak song, shows what it is
  missing (vocals stem, synced lyrics, pitch contour) and builds whatever is needed.
- **In the player**: the Karaoke button draws a pitch ribbon above the highway, one bar
  per syllable. Turn on 🎤 to sing along: karaoke detects your pitch, rates each phrase
  and keeps a score, multiplier and stars. Difficulty, microphone, latency and voice
  volume live in Settings → Microphone & Detection.

`lyricsKaraokeDiag()` in the DevTools console reports the mic and routing state.

## Plugin API (`window.lyricsKaraoke`)

Other plugins (Build-a-Band) drive karaoke through `window.lyricsKaraoke`. Check
`window.lyricsKaraoke && window.lyricsKaraoke.apiVersion >= 1` before using it: the
object is missing when the plugin is disabled or hasn't loaded yet.

| Member | Returns | What it does |
|---|---|---|
| `apiVersion` | `1` | API version. |
| `mountStrip(el \| null)` | `boolean` | Draws the karaoke strip inside `el`, filling it. `null` puts it back in the player (below the HUD row, 140 px tall). A host that is later removed from the page counts as `null`. Returns `false` for anything that isn't an element or `null`. |
| `setKaraokeMode(on)` | `Promise<boolean>` | Turns karaoke on or off for the current song. Turning it on waits for the song's karaoke data; it resolves `false` if the song has no vocal pitch or changed meanwhile. Resolves the resulting mode. |
| `isKaraokeMode()` | `boolean` | Whether karaoke is on. |
| `startMic()` | `Promise<string>` | Opens the mic picked in karaoke's settings (`lyrics_karaoke.deviceId`) and resolves the mic state. With no mic picked it resolves `'error'` without prompting or focusing karaoke's picker (show your own message). It never writes karaoke's saved mic on/off flag. |
| `stopMic()` | `void` | Closes the mic and resets the score. It also ends the mic for the song, so turning karaoke back on later doesn't reopen it. Karaoke's saved mic on/off flag is left alone. |
| `getMicState()` | `string` | `'off'`, `'requesting'`, `'listening'` or `'error'`. |
| `setDifficulty(id \| null)` | `boolean` | Session difficulty: `easy`, `medium`, `hard` or `expert`. Scoring restarts when the difficulty actually changes. While an override is set (even one equal to the saved difficulty), the player's and the settings page's difficulty pickers show it and are disabled. Any other id returns `false` and changes nothing. |
| `getDifficulty()` | `string` | The difficulty in effect. |
| `setHearMyself(on \| null)` | `boolean` | Session switch for hearing your own voice. Off builds no path from the mic to the speakers, and turning it off while singing disconnects it. Default on. A non-boolean returns `false`. |
| `getHearMyself()` | `boolean` | The hear-myself value in effect. |
| `setScoreHudHidden(hidden)` | `boolean` | Hides karaoke's whole scoring HUD on the strip: the score / multiplier / stars pill and any later scoring display, such as an overdrive meter. Phrase ratings and mic warnings stay. A non-boolean returns `false`. |
| `isScoreHudHidden()` | `boolean` | Whether the scoring HUD is hidden. |
| `getScore()` | `object \| null` | `{ score, multiplier, streak, stars, ratedCount }`, or `null` with no scorer. |
| `getOverdrive()` | `object` | The vocal overdrive meter now: `{ fill, active, ready }`. `fill` runs 0 to 1 (a full bar); `ready` means not active and at least half full. `{ fill: 0, active: false, ready: false }` with no scorer. |
| `setMicHitThreshold(db \| null)` | `boolean` | Session threshold (dBFS) for the mic hit that deploys overdrive. Rounded to a whole dB and clamped to −48 … −12; it applies to the live mic at once. `null` clears it back to the default (−30). Anything else returns `false`. |
| `getMicHitThreshold()` | `number` | The mic-hit threshold in effect. |
| `micHit` | `object` | The mic-hit rule, shared so a host's sensitivity check matches what fires in the song: `{ riseDb: 25, defaultDb: -30, minDb: -48, maxDb: -12, createDetector({ thresholdDb }) }`. A detector's `push(db, t)` returns `true` on a hit: the frame level is at or above the threshold, at least `riseDb` above the previous frame, and at least 0.3 s after the last hit (the first frame never hits). It only reads numbers; it never touches audio. Also `setThreshold(db)`, `threshold()` and `reset()`. |

**Overrides are not saved.** `setDifficulty`, `setHearMyself`, `setScoreHudHidden` and
`setMicHitThreshold` last for the session only and never change the user's saved settings.
Pass `null` to `setDifficulty`, `setHearMyself` or `setMicHitThreshold` to clear an override
back to karaoke's own value.

### Events

Karaoke emits these on core's event bus (`window.feedBack.on(name, handler)`; the payload
is the event's `detail`):

- **`karaoke:phrase`**, once per rated phrase, in order:
  `{ phraseIndex, rating, accuracy, points, multiplierBefore, overdrive, score, multiplier, streak, stars, ratedCount }`.
  The first six fields describe the phrase; any further field the scorer adds to a phrase
  passes through too. The last five are the running totals as of the end of the frame that
  rated it: when one frame rates several phrases, every one of those events carries the same
  totals, after all of them. Treat the totals in each `karaoke:phrase` as authoritative.
- **`karaoke:reset`**, a totals resync (new song, difficulty change, seek): the same
  totals as `getScore()`, or `null` with no scorer.

Vocal overdrive (Rock Band style, numbers from YARG; see `NOTICE.md`): each phrase rated
Strong or better earns a quarter bar; at half a bar or more a mic hit (a clap or shout into
the mic) deploys it in a gap between sung phrases (after a phrase ends and at least 0.25 s
before the next one starts). A mic hit inside a sung phrase, from 0.25 s before it starts to
its end, doesn't deploy; a loud ad-lib or clap between phrases does. A full bar lasts 8
measures. Phrase
events carry `overdrive`; points double while overdrive is active; `multiplier` stays the
streak multiplier. A backward seek empties the bar; a forward seek keeps it.

- **`karaoke:od-gain`** `{ fill }`: a phrase earned overdrive.
- **`karaoke:od-ready`** `{ fill }`: that gain made the bar ready to deploy.
- **`karaoke:od-activate`** `{ fill, t }`: a mic hit deployed overdrive at song time `t`.
- **`karaoke:od-end`** `{ t }`: overdrive ended: the bar ran out, or a reset (backward seek,
  mic stop) emptied it while active.
- **`karaoke:mic-hit`** `{ t, db, deployed }`: the mic-hit detector fired; `deployed` says
  whether it deployed overdrive (it doesn't inside a sung phrase or when the bar isn't ready).
