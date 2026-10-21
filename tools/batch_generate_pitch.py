#!/usr/bin/env python3
"""Batch-generate karaoke pitch (vocal_pitch.json) for zip sloppaks.

Runs the same local pYIN extractor as the in-app "Generate Karaoke" button
(routes._extract_pitch_per_syllable) over every song that has a vocals stem
and synced lyrics but no pitch yet, and writes the result into the archive.

Before an archive is rewritten, its original manifest is saved under
--backup-dir/<path relative to --dlc>/manifest.yaml. The only changes to an
archive are the added vocal_pitch.json and the manifest's `vocal_pitch` key,
so `--restore` can undo a run exactly from those manifests.

Needs librosa, numpy, soundfile, pyyaml and fastapi (for importing routes):

    python -m venv lkvenv && lkvenv/bin/pip install librosa numpy soundfile pyyaml fastapi
    lkvenv/bin/python tools/batch_generate_pitch.py --dlc ~/Desktop/rocksmith/dlc \\
        --backup-dir ~/Desktop/rocksmith/karaoke-pitch-backup --dry-run
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
import zipfile
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Makes the calls do nothing where claude-progress is not installed.
_bytecode, sys.dont_write_bytecode = sys.dont_write_bytecode, True  # no __pycache__ in the plugin
try:
    sys.path.insert(0, os.environ["CLAUDE_PROGRESS_DIR"]); from claude_progress import claude_progress
except Exception:
    def claude_progress(*args): pass
finally:
    sys.dont_write_bytecode = _bytecode

MANIFEST_NAMES = ("manifest.yaml", "manifest.yml")
PITCH_NAME = "vocal_pitch.json"


def _manifest_name(zf: zipfile.ZipFile) -> str | None:
    names = set(zf.namelist())
    return next((n for n in MANIFEST_NAMES if n in names), None)


def _lyrics_tokens(raw) -> list[dict]:
    """Same filtering as routes._lyrics_tokens: keep {t, d, w} with d > 0."""
    if not isinstance(raw, list):
        return []
    out = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        try:
            t, d = float(item.get("t", 0.0)), float(item.get("d", 0.0))
        except (TypeError, ValueError):
            continue
        if d > 0:
            out.append({"t": t, "d": d, "w": str(item.get("w", ""))})
    return out


def inspect_sloppak(path: Path) -> dict:
    """Decide whether a zip sloppak needs pitch. Returns a dict with
    `eligible`, a `reason` when not, and `vocals`/`lyrics` when it is."""
    try:
        with zipfile.ZipFile(path) as zf:
            mname = _manifest_name(zf)
            if not mname:
                return {"eligible": False, "reason": "no manifest"}
            manifest = yaml.safe_load(zf.read(mname)) or {}
            if manifest.get("vocal_pitch"):
                return {"eligible": False, "reason": "already has pitch"}
            vocals = next((str(s.get("file", "")).strip() for s in manifest.get("stems") or []
                           if isinstance(s, dict) and str(s.get("id", "")).lower() == "vocals"), "")
            if not vocals or vocals not in zf.namelist():
                return {"eligible": False, "reason": "no vocals stem"}
            lrel = manifest.get("lyrics")
            lyrics = []
            if lrel and str(lrel) in zf.namelist():
                try:
                    lyrics = _lyrics_tokens(json.loads(zf.read(str(lrel)).decode("utf-8")))
                except Exception:
                    lyrics = []
            if not lyrics:
                return {"eligible": False, "reason": "no synced lyrics"}
            return {"eligible": True, "vocals": vocals, "lyrics": lyrics}
    except zipfile.BadZipFile:
        return {"eligible": False, "reason": "not a zip sloppak"}


def _rewrite(path: Path, manifest_bytes: bytes, pitch_bytes: bytes | None) -> None:
    """Rewrite the archive with a new manifest and (optionally) pitch file.
    Every other entry is copied byte-for-byte with its original compression.
    Written to a temp file next to the archive, verified, then swapped in."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    try:
        with zipfile.ZipFile(path) as zin, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
            mname = _manifest_name(zin) or "manifest.yaml"
            for info in zin.infolist():
                if info.filename in (mname, PITCH_NAME):
                    continue
                zout.writestr(info, zin.read(info))
            zout.writestr(mname, manifest_bytes)
            if pitch_bytes is not None:
                zout.writestr(PITCH_NAME, pitch_bytes)
        with zipfile.ZipFile(tmp) as check:
            bad = check.testzip()
            if bad is not None:
                raise RuntimeError(f"verification failed on {bad}")
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            tmp.unlink()


def write_pitch_into_sloppak(path: Path, notes: list[dict]) -> None:
    with zipfile.ZipFile(path) as zf:
        manifest = yaml.safe_load(zf.read(_manifest_name(zf))) or {}
    manifest["vocal_pitch"] = PITCH_NAME
    manifest_bytes = yaml.safe_dump(manifest, sort_keys=False, allow_unicode=True).encode("utf-8")
    pitch_bytes = json.dumps({"version": 1, "notes": notes}, indent=2, ensure_ascii=False).encode("utf-8")
    _rewrite(path, manifest_bytes, pitch_bytes)


def _backup_path(path: Path, dlc_root: Path, backup_root: Path) -> Path:
    return backup_root / path.resolve().relative_to(dlc_root.resolve()) / "manifest.yaml"


def backup_manifest(path: Path, dlc_root: Path, backup_root: Path) -> Path:
    """Save the archive's original manifest once (never overwritten)."""
    dest = _backup_path(path, dlc_root, backup_root)
    if not dest.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(path) as zf:
            dest.write_bytes(zf.read(_manifest_name(zf)))
    return dest


def restore_sloppak(path: Path, dlc_root: Path, backup_root: Path) -> None:
    """Undo a run: put the saved manifest back and drop vocal_pitch.json."""
    saved = _backup_path(path, dlc_root, backup_root)
    _rewrite(path, saved.read_bytes(), None)


def process_one(path_str: str, dlc_root: str, backup_root: str) -> dict:
    path = Path(path_str)
    started = time.time()
    info = inspect_sloppak(path)
    if not info["eligible"]:
        return {"file": path_str, "status": "skipped", "reason": info["reason"]}
    import routes  # local: worker processes import librosa lazily via routes

    with tempfile.TemporaryDirectory(prefix="lk-batch-") as td:
        vocals = Path(td) / Path(info["vocals"]).name
        with zipfile.ZipFile(path) as zf:
            vocals.write_bytes(zf.read(info["vocals"]))
        try:
            notes = routes._extract_pitch_per_syllable(vocals, info["lyrics"])
        except Exception as exc:  # noqa: BLE001
            return {"file": path_str, "status": "failed", "reason": f"extraction: {exc}"}
    if not notes:
        return {"file": path_str, "status": "failed", "reason": "no voiced syllables"}
    backup_manifest(path, Path(dlc_root), Path(backup_root))
    try:
        write_pitch_into_sloppak(path, notes)
    except Exception as exc:  # noqa: BLE001
        return {"file": path_str, "status": "failed", "reason": f"write: {exc}"}
    return {"file": path_str, "status": "ok", "notes": len(notes),
            "syllables": len(info["lyrics"]), "seconds": round(time.time() - started, 1)}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dlc", required=True, type=Path, help="library root (DLC_DIR)")
    ap.add_argument("--backup-dir", required=True, type=Path, help="where original manifests are saved")
    ap.add_argument("--list", type=Path, help="file of sloppak paths relative to --dlc (default: all *.sloppak)")
    ap.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) - 2))
    ap.add_argument("--limit", type=int, default=0, help="stop after N eligible songs (0 = all)")
    ap.add_argument("--dry-run", action="store_true", help="only report what would be processed")
    ap.add_argument("--restore", action="store_true", help="undo a previous run from --backup-dir")
    args = ap.parse_args()

    dlc = args.dlc.expanduser()
    backup = args.backup_dir.expanduser()
    if args.list:
        paths = [dlc / line.strip() for line in args.list.read_text().splitlines() if line.strip()]
    else:
        paths = sorted(p for p in dlc.rglob("*.sloppak") if p.is_file())

    if args.restore:
        restored = 0
        for p in paths:
            if _backup_path(p, dlc, backup).exists():
                restore_sloppak(p, dlc, backup)
                restored += 1
        print(f"restored {restored} archive(s)")
        return 0

    todo = [p for p in paths if inspect_sloppak(p)["eligible"]]
    if args.limit:
        todo = todo[: args.limit]
    print(f"{len(paths)} archive(s) checked, {len(todo)} need pitch")
    if args.dry_run or not todo:
        return 0

    backup.mkdir(parents=True, exist_ok=True)
    log = backup / "run-log.jsonl"
    counts = {"ok": 0, "failed": 0, "skipped": 0}
    claude_progress("-n", "karaoke-pitch", "-t", str(len(todo)))
    with ProcessPoolExecutor(max_workers=args.workers) as pool, log.open("a") as lf:
        futures = {pool.submit(process_one, str(p), str(dlc), str(backup)): p for p in todo}
        for fut in as_completed(futures):
            try:
                res = fut.result()
            except Exception as exc:  # noqa: BLE001 — a crashed worker shouldn't stop the run
                res = {"file": str(futures[fut]), "status": "failed", "reason": f"worker: {exc}"}
            counts[res["status"]] += 1
            lf.write(json.dumps(res) + "\n")
            lf.flush()
            claude_progress("-n", "karaoke-pitch", "+1", Path(res["file"]).name)
            done = sum(counts.values())
            print(f"[{done}/{len(todo)}] {res['status']:7} {Path(res['file']).name}"
                  + (f" — {res.get('reason')}" if res["status"] != "ok" else f" ({res['notes']} notes, {res['seconds']}s)"),
                  flush=True)
    claude_progress("-n", "karaoke-pitch", "done", f"{counts['ok']} ok, {counts['failed']} failed")
    print(f"done: {counts}. Log: {log}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
