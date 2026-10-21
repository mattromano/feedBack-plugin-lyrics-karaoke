# Changelog

## [Unreleased]

### Added
- Vocal overdrive (KRB-8, YARG numbers; `src/yarg-overdrive.js` is LGPL-3.0, see NOTICE.md):
  phrases rated Strong or better earn a quarter bar, a clap or shout into the mic between
  sung phrases deploys it at half a bar or more, and phrase points double while it lasts (8 measures for a full bar).
  A small blue meter under the score pill and an "Overdrive!" flash show it. Plugins get
  `getOverdrive()`, `setMicHitThreshold()`, the shared `micHit` detector and `karaoke:od-*` /
  `karaoke:mic-hit` events.
- `window.lyricsKaraoke` lets other plugins (Build-a-Band) mount the karaoke strip in their
  own layout, turn karaoke and the mic on, set a session difficulty and hear-myself that
  are never saved, hide the score pill, and follow scoring through `karaoke:phrase` and
  `karaoke:reset` events. See README.md.
- Hear yourself: while the karaoke mic is on, your voice plays through the same device
  as the game's audio (not forced into a headset), with a 🔊 volume slider next to the
  mic picker and a limiter so loud notes don't clip. The slider boosts (50% = +12 dB,
  100% = +18 dB) because a headset mic with auto-gain off sits ~20 dB under the song.
- Feedback guard: a speaker→mic howl (one pitch held within 10 cents for ~1 s, at any
  frequency — they usually ring at 1–3 kHz) drops your voice volume 6 dB and shows
  "Feedback detected — voice volume lowered". Echo cancellation stays off: with your
  voice coming out of the speakers it scrubs your own voice and breaks pitch detection.
- Pitch feedback you can see: an arrow at the playhead and a trail over what you just
  sang, green inside the difficulty's tolerance and orange outside, drawn in the octave
  nearest the note so singing an octave low lines up with the bars. The note you're on
  glows while you hold it in tune.
- `lyricsKaraokeDiag()` in the DevTools console reports mic level, voiced samples and
  routing for debugging.

### Changed
- Karaoke never opens a microphone you didn't pick. With no mic chosen, 🎤 says "Pick a
  microphone first" instead of using the system default. If your chosen mic is unplugged
  it tells you rather than falling back to another one.
- A microphone picker sits next to 🎤 in the player. The settings page moved to
  Settings → Microphone & Detection.

### Added
- The 🎤 tooltip names the mic in use, and a red line on the karaoke strip warns when it
  is a built-in laptop mic (or a built-in mic over speakers).
- `tools/batch_generate_pitch.py` generates karaoke pitch for a whole library.
  `--regenerate` re-runs it over songs that already have auto pitch (never
  hand-charted Rock Band imports), keeping the old pitch so `--restore` undoes it.

### Fixed
- Auto pitch on short syllables ("of", "the"): where pYIN isn't confident on any frame,
  the syllable now takes pYIN's best-guess pitch instead of copying a neighbour's note.
  Against 40 Harmonix Rock Band vocal charts (6,671 notes) this lifts notes within a
  semitone of the chart from 74% to 86%, and exact notes from 60% to 69%.
- Auto pitch on notes sung well above the singer's usual range (a chorus over a low
  verse): the detector's second pass now searches two octaves above the singer's centre
  instead of one, so those notes stop being reported an octave low. Against the same
  charts, target bars in the right octave go from 79% to 81% and notes within a
  semitone from 86% to 87%, with no song worse.

## [1.5.0] - 2026-10-16

### Added
- Rock Band–style vocal scoring in the karaoke overlay. Each phrase is rated
  Awesome / Strong / Good / OK / Messy / Awful, and your score, multiplier (up to 4×)
  and stars (1 to 5) build up across the song.
- Pitch matching ignores the octave, so singing a part an octave lower or higher scores the same.
- Easy, Medium, Hard and Expert difficulty, chosen in the player or on the settings page.
- Settings page: choose the microphone (falls back to the system default if the saved
  one is unplugged) and set a mic latency correction from −100 to 400 ms.

### Changed
- The plugin now uses the ES-module layout (`scriptType: "module"`, code under `src/`)
  and needs feedBack 0.3.0-alpha.1 or later.
- Phrases already under way when you join (mic started mid-song, or a seek that lands
  mid-phrase) are left unrated instead of counting as misses.
