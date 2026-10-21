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
| `startMic()` | `Promise<string>` | Opens the mic picked in karaoke's settings (`lyrics_karaoke.deviceId`) and resolves the mic state. It never writes karaoke's saved mic on/off flag. |
| `stopMic()` | `void` | Closes the mic and resets the score. Karaoke's saved mic on/off flag is left alone. |
| `getMicState()` | `string` | `'off'`, `'requesting'`, `'listening'` or `'error'`. |
| `setDifficulty(id \| null)` | `boolean` | Session difficulty: `easy`, `medium`, `hard` or `expert`. Scoring restarts when the difficulty actually changes. While an override is set (even one equal to the saved difficulty), the player's and the settings page's difficulty pickers show it and are disabled. Any other id returns `false` and changes nothing. |
| `getDifficulty()` | `string` | The difficulty in effect. |
| `setHearMyself(on \| null)` | `boolean` | Session switch for hearing your own voice. Off builds no path from the mic to the speakers, and turning it off while singing disconnects it. Default on. A non-boolean returns `false`. |
| `getHearMyself()` | `boolean` | The hear-myself value in effect. |
| `setScoreHudHidden(hidden)` | `boolean` | Hides the score / multiplier / stars pill on the strip. Phrase ratings and mic warnings stay. A non-boolean returns `false`. |
| `isScoreHudHidden()` | `boolean` | Whether the pill is hidden. |
| `getScore()` | `object \| null` | `{ score, multiplier, streak, stars, ratedCount }`, or `null` with no scorer. |

**Overrides are not saved.** `setDifficulty`, `setHearMyself` and `setScoreHudHidden` last
for the session only and never change the user's saved settings. Pass `null` to
`setDifficulty` or `setHearMyself` to clear an override back to karaoke's own value.

### Events

Karaoke emits these on core's event bus (`window.feedBack.on(name, handler)`; the payload
is the event's `detail`):

- **`karaoke:phrase`**, once per rated phrase, in order:
  `{ phraseIndex, rating, accuracy, points, multiplierBefore, score, multiplier, streak, stars, ratedCount }`.
  The first five fields describe the phrase. The last five are the running totals as of the
  end of the frame that rated it: when one frame rates several phrases, every one of those
  events carries the same totals, after all of them.
- **`karaoke:reset`**, when the score starts over (new song, difficulty change, mic
  turned off, seek): the same totals as `getScore()`, or `null` with no scorer.
