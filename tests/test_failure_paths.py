"""
Test suite verifying that all handled failure modes produce friendly structured errors or clean fallbacks.
"""

import json
import os
import subprocess
import sys
import tempfile
import pytest

PIPELINE_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "backend", "pipeline.py"))


def run_pipeline_raw(args, env_override=None):
    env = os.environ.copy()
    if env_override:
        env.update(env_override)
    proc = subprocess.run(
        [sys.executable, PIPELINE_PATH] + args,
        capture_output=True,
        text=True,
        env=env,
    )
    return proc


def test_failure_file_not_found():
    proc = run_pipeline_raw(["nonexistent_song_12345.mp3"])
    assert proc.returncode != 0
    # Must contain structured JSON error
    found_error = False
    for line in proc.stdout.splitlines():
        try:
            data = json.loads(line.strip())
            if data.get("error") == "file_not_found":
                found_error = True
                break
        except Exception:
            continue
    assert found_error, f"Expected file_not_found JSON error, got: {proc.stdout}"


def test_failure_empty_audio_file():
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
        temp_path = f.name

    try:
        proc = run_pipeline_raw([temp_path])
        assert proc.returncode != 0
        found_error = False
        for line in proc.stdout.splitlines():
            try:
                data = json.loads(line.strip())
                if data.get("error") == "invalid_audio":
                    found_error = True
                    break
            except Exception:
                continue
        assert found_error, f"Expected invalid_audio JSON error, got: {proc.stdout}"
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)


def test_offline_mode_skips_acoustid_with_friendly_status():
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
        f.write(b"ID3\x03\x00\x00dummy audio content for test")
        temp_path = f.name

    try:
        proc = run_pipeline_raw(
            [
                "--offline",
                temp_path,
                "--enabled-providers",
                "embedded",
                "sidecar",
                "lrclib",
            ],
            env_override={"ACOUSTID_API_KEY": ""},
        )
        # Should NOT crash with unhandled exception or KeyError
        assert "Traceback" not in proc.stderr
        assert "Couldn't identify by fingerprint, searching by tags instead" in proc.stdout
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)


def test_failure_missing_ffmpeg():
    # If ffmpeg is absent from PATH when unknown track falls through to AI
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
        f.write(b"ID3\x03\x00\x00fake audio content without title or artist")
        temp_path = f.name

    try:
        # Override PATH with minimal path excluding ffmpeg
        clean_path = "C:\\Windows\\System32;C:\\Windows"
        proc = run_pipeline_raw(
            ["--offline", temp_path],
            env_override={"PATH": clean_path, "ACOUSTID_API_KEY": ""},
        )
        assert proc.returncode != 0
        found_missing_dep = False
        for line in proc.stdout.splitlines():
            try:
                data = json.loads(line.strip())
                if data.get("error") == "missing_dependency" and "ffmpeg" in data.get("detail", "").lower():
                    found_missing_dep = True
                    break
            except Exception:
                continue
        assert found_missing_dep, f"Expected ffmpeg missing_dependency error, got: {proc.stdout}"
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)
