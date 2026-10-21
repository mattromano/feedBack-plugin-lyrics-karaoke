"""Archive rewrite + candidate checks for tools/batch_generate_pitch.py.
Uses synthetic sloppak zips; pitch extraction itself is not exercised here."""

import json
import sys
import zipfile
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))

import batch_generate_pitch as bgp  # noqa: E402

MANIFEST = {
    "title": "Song",
    "stems": [{"id": "full", "file": "stems/full.ogg"}, {"id": "vocals", "file": "stems/vocals.ogg"}],
    "lyrics": "lyrics.json",
}
LYRICS = [{"t": 1.0, "d": 0.5, "w": "Hel-"}, {"t": 1.5, "d": 0.5, "w": "lo+"}]


def make_sloppak(path: Path, manifest=None, lyrics=LYRICS, extra=None):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.yaml", yaml.safe_dump(manifest or MANIFEST, sort_keys=False))
        if lyrics is not None:
            zf.writestr("lyrics.json", json.dumps(lyrics))
        zf.writestr("stems/full.ogg", b"FULL" * 1000)
        zf.writestr("stems/vocals.ogg", b"VOX" * 1000)
        for name, data in (extra or {}).items():
            zf.writestr(name, data)
    return path


def test_candidate_needs_vocals_stem_lyrics_and_no_pitch(tmp_path):
    ok = make_sloppak(tmp_path / "ok.sloppak")
    info = bgp.inspect_sloppak(ok)
    assert info["eligible"] is True
    assert info["vocals"] == "stems/vocals.ogg"
    assert len(info["lyrics"]) == 2

    no_vox = make_sloppak(tmp_path / "novox.sloppak",
                          manifest={**MANIFEST, "stems": [{"id": "full", "file": "stems/full.ogg"}]})
    assert bgp.inspect_sloppak(no_vox)["reason"] == "no vocals stem"

    no_lyr = make_sloppak(tmp_path / "nolyr.sloppak", lyrics=None)
    assert bgp.inspect_sloppak(no_lyr)["reason"] == "no synced lyrics"

    done = make_sloppak(tmp_path / "done.sloppak",
                        manifest={**MANIFEST, "vocal_pitch": "vocal_pitch.json"},
                        extra={"vocal_pitch.json": json.dumps({"version": 1, "notes": []})})
    assert bgp.inspect_sloppak(done)["reason"] == "already has pitch"


def test_rewrite_adds_pitch_and_keeps_every_other_entry(tmp_path):
    src = make_sloppak(tmp_path / "song.sloppak", extra={"cover.jpg": b"\xff\xd8JPEG"})
    before = {i.filename: zipfile.ZipFile(src).read(i.filename) for i in zipfile.ZipFile(src).infolist()}
    notes = [{"t": 1.0, "d": 0.5, "midi": 60}]

    bgp.write_pitch_into_sloppak(src, notes)

    with zipfile.ZipFile(src) as zf:
        assert zf.testzip() is None
        names = zf.namelist()
        assert len(names) == len(set(names)), "no duplicate entries"
        for name, data in before.items():
            if name != "manifest.yaml":
                assert zf.read(name) == data, f"{name} changed"
        assert json.loads(zf.read("vocal_pitch.json")) == {"version": 1, "notes": notes}
        manifest = yaml.safe_load(zf.read("manifest.yaml"))
    assert manifest["vocal_pitch"] == "vocal_pitch.json"
    assert manifest["stems"] == MANIFEST["stems"] and manifest["lyrics"] == "lyrics.json"
    assert not list(tmp_path.glob("*.tmp")), "temp archive cleaned up"


def test_backup_saves_original_manifest_once(tmp_path):
    (tmp_path / "dlc" / "sloppak").mkdir(parents=True)
    src = make_sloppak(tmp_path / "dlc" / "sloppak" / "song.sloppak")
    backup_root = tmp_path / "backup"
    bgp.backup_manifest(src, tmp_path / "dlc", backup_root)
    saved = backup_root / "sloppak" / "song.sloppak" / "manifest.yaml"
    assert yaml.safe_load(saved.read_text()) == MANIFEST
    saved.write_text("sentinel")
    bgp.backup_manifest(src, tmp_path / "dlc", backup_root)   # second call must not overwrite
    assert saved.read_text() == "sentinel"


def test_restore_puts_original_manifest_back_and_drops_pitch(tmp_path):
    (tmp_path / "dlc" / "sloppak").mkdir(parents=True)
    src = make_sloppak(tmp_path / "dlc" / "sloppak" / "song.sloppak")
    backup_root = tmp_path / "backup"
    bgp.backup_manifest(src, tmp_path / "dlc", backup_root)
    bgp.write_pitch_into_sloppak(src, [{"t": 1.0, "d": 0.5, "midi": 60}])

    bgp.restore_sloppak(src, tmp_path / "dlc", backup_root)

    with zipfile.ZipFile(src) as zf:
        assert "vocal_pitch.json" not in zf.namelist()
        assert yaml.safe_load(zf.read("manifest.yaml")) == MANIFEST
        assert zf.read("stems/vocals.ogg") == b"VOX" * 1000


OLD_PITCH = json.dumps({"version": 1, "notes": [{"t": 1.0, "d": 0.5, "midi": 57}]})


def test_regenerate_reopens_auto_pitch_but_never_authored(tmp_path):
    auto = make_sloppak(tmp_path / "auto.sloppak",
                        manifest={**MANIFEST, "vocal_pitch": "vocal_pitch.json"},
                        extra={"vocal_pitch.json": OLD_PITCH})
    assert bgp.inspect_sloppak(auto)["reason"] == "already has pitch"
    assert bgp.inspect_sloppak(auto, regenerate=True)["eligible"] is True

    # A Rock Band / Clone Hero import: its pitch is hand-charted, so a better
    # extractor still must not overwrite it.
    charted = make_sloppak(tmp_path / "rb.sloppak",
                           manifest={**MANIFEST, "vocal_pitch": "vocal_pitch.json",
                                     "lyrics_source": "authored"},
                           extra={"vocal_pitch.json": OLD_PITCH})
    assert bgp.inspect_sloppak(charted, regenerate=True)["reason"] == "authored pitch"


def test_regenerate_backup_and_restore_bring_the_old_pitch_back(tmp_path):
    (tmp_path / "dlc" / "sloppak").mkdir(parents=True)
    manifest = {**MANIFEST, "vocal_pitch": "vocal_pitch.json"}
    src = make_sloppak(tmp_path / "dlc" / "sloppak" / "song.sloppak",
                       manifest=manifest, extra={"vocal_pitch.json": OLD_PITCH})
    backup_root = tmp_path / "backup"
    bgp.backup_manifest(src, tmp_path / "dlc", backup_root)
    assert (backup_root / "sloppak" / "song.sloppak" / "vocal_pitch.json").read_text() == OLD_PITCH
    bgp.write_pitch_into_sloppak(src, [{"t": 1.0, "d": 0.5, "midi": 62}])

    bgp.restore_sloppak(src, tmp_path / "dlc", backup_root)

    with zipfile.ZipFile(src) as zf:
        assert zf.read("vocal_pitch.json").decode() == OLD_PITCH
        assert yaml.safe_load(zf.read("manifest.yaml")) == manifest
