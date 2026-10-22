"""routes._extract_pitch_per_syllable on synthetic vocals.

Needs librosa (skipped without it). Measured against Green Day "Holiday"'s
Rock Band chart, the misses were short syllables (~90 ms) where pYIN found no
confidently voiced frame, so the extractor copied a neighbour's pitch. These
pin that a short, weakly voiced syllable gets its own pitch instead.
"""

import sys
from pathlib import Path

import numpy as np
import pytest

librosa = pytest.importorskip("librosa")
sf = pytest.importorskip("soundfile")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import routes  # noqa: E402

SR = 22050


def _tone(midi, secs, amp, rng):
    t = np.arange(int(SR * secs)) / SR
    hz = 440.0 * 2 ** ((midi - 69) / 12)
    # A few harmonics so it reads like a voice rather than a pure sine.
    sig = sum(amp / k * np.sin(2 * np.pi * hz * k * t) for k in (1, 2, 3))
    return sig + rng.normal(0, 0.02, t.size)


def _write_vocals(tmp_path, notes):
    """notes: [(midi | None, secs, amp)] laid end to end; returns (path, lyrics)."""
    rng = np.random.default_rng(7)
    parts, lyrics, t = [], [], 0.0
    for midi, secs, amp in notes:
        parts.append(_tone(midi, secs, amp, rng) if midi is not None
                     else rng.normal(0, 0.02, int(SR * secs)))
        if midi is not None:
            lyrics.append({"t": round(t, 4), "d": secs, "w": "la"})
        t += secs
    path = tmp_path / "vocals.wav"
    sf.write(path, np.concatenate(parts).astype(np.float32), SR)
    return path, lyrics


def _pc_semitones(a, b):
    return abs((((a - b) * 100 + 600) % 1200 + 1200) % 1200 - 600) / 100


def test_steady_notes_keep_their_pitch(tmp_path):
    path, lyrics = _write_vocals(tmp_path, [(None, 0.3, 0), (57, 0.6, 0.5), (62, 0.6, 0.5),
                                            (64, 0.6, 0.5), (None, 0.3, 0)])
    out = routes._extract_pitch_per_syllable(path, lyrics)
    assert [_pc_semitones(o["midi"], m) for o, m in zip(out, (57, 62, 64))] == [0, 0, 0]


def test_short_quiet_syllable_gets_its_own_pitch(tmp_path):
    # A short, quiet pickup ("of", "the") with a breath either side: pYIN is
    # not confident on any of its frames, which used to fall back to a
    # neighbour's pitch (57).
    path, lyrics = _write_vocals(tmp_path, [(None, 0.3, 0), (57, 0.6, 0.5), (None, 0.1, 0),
                                            (62, 0.12, 0.06), (None, 0.1, 0),
                                            (57, 0.6, 0.5), (None, 0.3, 0)])
    out = routes._extract_pitch_per_syllable(path, lyrics)
    assert out[1]["midi"] is not None
    assert _pc_semitones(out[1]["midi"], 62) <= 1, out


def test_high_notes_above_the_singers_centre_keep_their_octave(tmp_path):
    # A low verse (A2) and a chorus line 14 semitones up (B3). The second
    # pYIN pass searches a window around the singer's median; when that window
    # ended 12 semitones up, the chorus could only be reported an octave low.
    verse = [(45, 0.5, 0.5)] * 8
    chorus = [(59, 0.5, 0.5)] * 4
    path, lyrics = _write_vocals(tmp_path, [(None, 0.3, 0), *verse, *chorus,
                                            *verse, (None, 0.3, 0)])
    out = routes._extract_pitch_per_syllable(path, lyrics)
    assert [o["midi"] for o in out[8:12]] == [59] * 4, out[8:12]


def test_held_note_is_extended_to_where_the_voice_stops(tmp_path):
    # Rocksmith often charts a held note as a short syllable: here the voice
    # holds A3 for 1.0 s but the lyric says 0.3 s. Without the extension the
    # last 0.7 s of singing has no target at all.
    path, lyrics = _write_vocals(tmp_path, [(None, 0.3, 0), (57, 1.0, 0.5), (None, 0.4, 0),
                                            (62, 0.5, 0.5), (None, 0.3, 0)])
    lyrics[0]["d"] = 0.3
    out = routes._extract_pitch_per_syllable(path, lyrics)
    assert out[0]["t"] == lyrics[0]["t"], "start times never move (pitch pairs with lyrics by t)"
    assert out[0]["d"] >= 0.85, out[0]
    assert out[0]["t"] + out[0]["d"] <= out[1]["t"], "never runs into the next syllable"


def test_extension_never_shortens_a_syllable(tmp_path):
    path, lyrics = _write_vocals(tmp_path, [(None, 0.3, 0), (57, 0.4, 0.5), (None, 0.6, 0),
                                            (62, 0.5, 0.5), (None, 0.3, 0)])
    lyrics[0]["d"] = 0.8      # charted longer than the voice: keep the charted length
    out = routes._extract_pitch_per_syllable(path, lyrics)
    # Never shorter; pYIN's window may carry voicing a few ms past the note,
    # but nothing stretches it across the 0.6 s of silence that follows.
    assert 0.8 <= out[0]["d"] < 0.85, out[0]
