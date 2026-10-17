# Changelog

## [Unreleased]

### Added
- Hear yourself: while the karaoke mic is on, your voice plays through the same device
  as the game's audio (not forced into a headset), with a 🔊 volume slider next to the
  mic picker and a limiter so loud notes don't clip. The slider boosts (50% = +12 dB,
  100% = +30 dB) because a headset mic with auto-gain off sits ~20 dB under the song.
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
