#!/usr/bin/env python3
"""
Lyrics Sync Desktop - Pipeline

Turns an audio file into timestamped lyric lines.

Pipeline Flow:
1. Validate audio input and check tool dependencies (ffmpeg, fpcalc).
2. Check local .cache/ for previously processed results using SHA-256 file hash.
3. Path A: Identify track via AcoustID fingerprint or embedded audio tags (ID3/Vorbis/MP4).
   If track metadata is found, search syncedlyrics providers and direct LRCLIB.
4. Path B (Fallback): Demucs vocal stem isolation -> faster-whisper word-level transcription.
5. Save successful result to local .cache/ for instant re-runs.

Communication Protocol:
Emits structured JSON events to stdout prefixed with '__LYRICS_EVENT__ ':
- Progress: {"type": "progress", "stage": str, "message": str}
- Result:   {"type": "result", "source": str, "title": str, "artist": str|None, "lines": list}
- Error:    {"type": "error", "error": str, "detail": str|None}
Also prints standard JSON on exit: {"error": ..., "detail": ...} on failure, {"source": ..., "lines": ...} on success.
"""

import argparse
import inspect
import glob
import hashlib
import json
import logging
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import requests
import syncedlyrics

ACOUSTID_API_KEY = os.environ.get("ACOUSTID_API_KEY")
LRCLIB_BASE = "https://lrclib.net/api"
UA_HEADERS = {"User-Agent": "LyricsSyncDesktop/0.2 (personal project)"}
LYRICS_MATCH_VERSION = 4
LYRICS_CACHE_SOURCES = {"lrclib", "syncedlyrics", "plain", "plain_estimated"}

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
CACHE_DIR = os.path.join(PROJECT_ROOT, ".cache")
_LRC_TIMESTAMP_PATTERN = re.compile(r"\[\d+:\d+(?:\.\d+)?\]")
_FEATURE_SUFFIX_PATTERN = re.compile(r"\s+(?:feat\.?|ft\.?)\s+.+$", re.IGNORECASE)
_ANNOTATION_PATTERN = re.compile(r"\s*[\(\[].*?[\)\]]")


@dataclass(frozen=True)
class LyricsSearchResult:
    text: str
    format: str
    provider: str
    source: str


def _lyrics_result_lines(result: LyricsSearchResult) -> List[Dict[str, Any]]:
    if result.format == "synced":
        return parse_lrc(result.text)
    return [
        {"text": line.strip()}
        for line in result.text.splitlines()
        if line.strip()
    ]


def read_audio_duration(audio_path: str) -> Optional[float]:
    """Reads media duration from the audio file, independent of song metadata."""
    errors: List[str] = []
    try:
        from tinytag import TinyTag

        tag = TinyTag.get(audio_path)
        duration = float(tag.duration) if tag and tag.duration is not None else None
        if duration is not None and math.isfinite(duration) and duration > 0:
            return duration
        errors.append("tinytag returned no positive duration")
    except Exception as exc:
        errors.append(f"tinytag: {exc}")

    ffprobe = shutil.which("ffprobe")
    if ffprobe:
        try:
            result = subprocess.run(
                [
                    ffprobe,
                    "-v", "error",
                    "-show_entries", "format=duration",
                    "-of", "default=noprint_wrappers=1:nokey=1",
                    audio_path,
                ],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
            )
            if result.returncode == 0:
                duration = float(result.stdout.strip())
                if math.isfinite(duration) and duration > 0:
                    return duration
            errors.append(result.stderr.strip() or "ffprobe returned no positive duration")
        except (OSError, subprocess.SubprocessError, ValueError) as exc:
            errors.append(f"ffprobe: {exc}")
    else:
        errors.append("ffprobe was not found on PATH")

    emit_event(
        "progress",
        stage="warning",
        message=f"Could not read audio duration for estimated lyrics: {'; '.join(errors)}",
    )
    return None


def estimate_lyrics_timestamps(
    lines: List[Dict[str, Any]], duration: float
) -> List[Dict[str, Any]]:
    """Evenly spaces plain lyric lines from the start across the track."""
    if not lines or not math.isfinite(duration) or duration <= 0:
        return []
    interval = duration / len(lines)
    return [
        {"time": round(index * interval, 2), "text": line["text"]}
        for index, line in enumerate(lines)
    ]


def prepare_lyrics_output(
    result: LyricsSearchResult, audio_path: str
) -> tuple[List[Dict[str, Any]], str, str]:
    lines = _lyrics_result_lines(result)
    if result.format != "plain" or not lines:
        return lines, result.source, result.format

    duration = read_audio_duration(audio_path)
    if duration is None:
        return lines, "plain", "plain"
    estimated_lines = estimate_lyrics_timestamps(lines, duration)
    return estimated_lines, "plain_estimated", "estimated"


def emit_event(event_type: str, **kwargs: Any) -> None:
    """Emits a structured JSON message to stdout with prefix for clean IPC."""
    payload = {"type": event_type, **kwargs}
    print(f"__LYRICS_EVENT__ {json.dumps(payload)}", flush=True)


def fail(error_code: str, detail: str) -> None:
    """Prints structured JSON error to stdout and stderr, emits IPC error event, and exits."""
    payload = {"error": error_code, "detail": detail}
    # Progress events always carry a "message" field (that's what the UI
    # already renders correctly for status text). Error events previously
    # only had "detail", so anything reading event.message for a banner
    # got undefined -> rendered blank. Mirror detail into message too.
    emit_event("error", error=error_code, detail=detail, message=detail)
    print(json.dumps(payload), file=sys.stdout, flush=True)
    print(json.dumps(payload), file=sys.stderr, flush=True)
    sys.exit(1)


def compute_file_hash(filepath: str) -> str:
    """Computes SHA-256 hash of file for deterministic caching."""
    hasher = hashlib.sha256()
    with open(filepath, "rb") as f:
        while chunk := f.read(65536):
            hasher.update(chunk)
    return hasher.hexdigest()


def load_cached_lyrics(file_hash: str, cache_dir: str = CACHE_DIR) -> Optional[Dict[str, Any]]:
    """Loads previously processed song result from cache if available."""
    cache_path = os.path.join(cache_dir, f"{file_hash}.json")
    if os.path.isfile(cache_path):
        try:
            with open(cache_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict) and "lines" in data:
                    if (
                        data.get("source") in LYRICS_CACHE_SOURCES
                        and data.get("match_version") != LYRICS_MATCH_VERSION
                    ):
                        return None
                    return data
        except Exception:
            return None
    return None


def save_cached_lyrics(file_hash: str, payload: Dict[str, Any], cache_dir: str = CACHE_DIR) -> None:
    """Persists song metadata and parsed/transcribed lines to cache directory."""
    try:
        os.makedirs(cache_dir, exist_ok=True)
        cache_path = os.path.join(cache_dir, f"{file_hash}.json")
        data = {
            "source": payload.get("source"),
            "title": payload.get("title"),
            "artist": payload.get("artist"),
            "format": payload.get("format"),
            "provider": payload.get("provider"),
            "lines": payload.get("lines", []),
            "file_hash": file_hash,
        }
        if data["source"] in LYRICS_CACHE_SOURCES:
            data["match_version"] = LYRICS_MATCH_VERSION
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
    except Exception:
        pass


def check_tool_availability() -> Dict[str, bool]:
    """Checks presence of required external command-line binaries."""
    return {
        "ffmpeg": shutil.which("ffmpeg") is not None,
        "fpcalc": shutil.which("fpcalc") is not None,
    }


def extract_audio_tags(audio_path: str) -> Optional[Dict[str, Any]]:
    """Extracts title, artist, and duration from embedded ID3/Vorbis/MP4 tags using tinytag."""
    try:
        from tinytag import TinyTag
        tag = TinyTag.get(audio_path)
        if tag and tag.title:
            return {
                "title": tag.title.strip(),
                "artist": tag.artist.strip() if tag.artist else None,
                "duration": round(tag.duration) if tag.duration else None,
            }
    except ImportError:
        pass
    except Exception:
        pass
    return None


def identify_song_acoustid(audio_path: str, tools: Dict[str, bool]) -> Optional[Dict[str, Any]]:
    """Fingerprints file and looks up track on AcoustID."""
    if not ACOUSTID_API_KEY:
        emit_event("progress", stage="fingerprint", message="ACOUSTID_API_KEY not configured. Checking audio tags...")
        return None

    if not tools.get("fpcalc"):
        emit_event("progress", stage="fingerprint", message="fpcalc binary not found on PATH. Checking audio tags...")
        return None

    try:
        import acoustid
    except ImportError:
        emit_event("progress", stage="fingerprint", message="pyacoustid library not installed. Checking audio tags...")
        return None

    try:
        emit_event("progress", stage="fingerprint", message="Fingerprinting audio with AcoustID...")
        duration, fingerprint = acoustid.fingerprint_file(audio_path)
        response = acoustid.lookup(ACOUSTID_API_KEY, fingerprint, duration, meta="recordings")
    except Exception as exc:
        emit_event("progress", stage="fingerprint", message=f"AcoustID lookup failed: {str(exc)}")
        return None

    results = response.get("results") or []
    if not results:
        return None

    best = max(results, key=lambda r: r.get("score", 0))
    if best.get("score", 0) < 0.5:
        return None

    recordings = best.get("recordings") or []
    if not recordings or not recordings[0].get("title"):
        return None

    rec = recordings[0]
    artists = rec.get("artists") or []
    return {
        "title": rec["title"],
        "artist": artists[0]["name"] if artists else None,
        "duration": round(duration),
    }


def parse_lrc(lrc_text: str) -> List[Dict[str, Any]]:
    """Converts LRC-format text into a sorted list of timestamped lines.
    Handles:
    - Multiple timestamps per line: [00:10.00][00:20.00]chorus
    - Header tags: [offset:1000]
    - Empty timestamp lines: preserved to indicate vocal pauses
    """
    if not lrc_text:
        return []

    offset_sec = 0.0
    offset_match = re.search(r"\[offset:\s*([+-]?\d+)\]", lrc_text, re.IGNORECASE)
    if offset_match:
        try:
            offset_sec = float(offset_match.group(1)) / 1000.0
        except ValueError:
            offset_sec = 0.0

    tag_regex = re.compile(r"\[(\d+):(\d+(?:\.\d+)?)\]")
    parsed_lines: List[Dict[str, Any]] = []

    for raw_line in lrc_text.splitlines():
        line = raw_line.strip()
        if not line:
            continue

        matches = list(tag_regex.finditer(line))
        if not matches:
            continue

        # Extract text following all timestamp tags
        last_match_end = matches[-1].end()
        text = line[last_match_end:].strip()

        for match in matches:
            mins, secs = match.groups()
            timestamp = round(int(mins) * 60 + float(secs) + offset_sec, 2)
            if timestamp < 0:
                timestamp = 0.0
            parsed_lines.append({"time": timestamp, "text": text})

    return sorted(parsed_lines, key=lambda item: item["time"])


def _clean_lyrics_title(title: str) -> str:
    cleaned = _ANNOTATION_PATTERN.sub(" ", title)
    cleaned = _FEATURE_SUFFIX_PATTERN.sub("", cleaned)
    return " ".join(cleaned.split())


def _lyrics_search_queries(title: str, artist: Optional[str]) -> List[str]:
    cleaned_title = _clean_lyrics_title(title)
    query_titles = [title, cleaned_title]
    if len(cleaned_title.split()) > 3:
        query_titles.append(cleaned_title)

    queries: List[str] = []
    for query_title in query_titles:
        query = " ".join(part for part in (query_title.strip(), (artist or "").strip()) if part)
        if query and query not in queries:
            queries.append(query)

    if len(cleaned_title.split()) > 3 and cleaned_title not in queries:
        queries.append(cleaned_title)
    return queries


class _SyncedLyricsProviderCapture(logging.Handler):
    def __init__(self) -> None:
        super().__init__(level=logging.INFO)
        self.synced_provider: Optional[str] = None
        self.plain_provider: Optional[str] = None

    def emit(self, record: logging.LogRecord) -> None:
        message = record.getMessage()
        synced_match = re.search(r'Lyrics found for ".+" on (.+)$', message)
        plain_match = re.search(r"Found plaintext lyrics on (.+), but continuing", message)
        if synced_match:
            self.synced_provider = synced_match.group(1)
        if plain_match:
            self.plain_provider = plain_match.group(1)


def _search_syncedlyrics(query: str) -> tuple[Optional[str], str]:
    logger = logging.getLogger("syncedlyrics")
    capture = _SyncedLyricsProviderCapture()
    previous_level = logger.level
    logger.setLevel(logging.INFO)
    logger.addHandler(capture)
    try:
        search_options: Dict[str, Any] = {}
        if "allow_plain_format" in inspect.signature(syncedlyrics.search).parameters:
            search_options["allow_plain_format"] = True
        lyrics = syncedlyrics.search(query, **search_options)
    finally:
        logger.removeHandler(capture)
        logger.setLevel(previous_level)

    if not isinstance(lyrics, str) or not lyrics.strip():
        return None, "syncedlyrics"

    lyrics_format = "synced" if _LRC_TIMESTAMP_PATTERN.search(lyrics) else "plain"
    provider = (
        capture.synced_provider if lyrics_format == "synced" else capture.plain_provider
    ) or "syncedlyrics (provider not reported)"
    return lyrics, provider


def _fetch_lrclib_lyrics(
    title: str, artist: Optional[str], duration: Optional[int]
) -> Optional[str]:
    """Queries lrclib.net directly as a fallback to the aggregated providers."""

    params: Dict[str, Any] = {"track_name": title}
    if artist:
        params["artist_name"] = artist
    if duration:
        params["duration"] = duration

    # 1. Exact match endpoint
    try:
        r = requests.get(f"{LRCLIB_BASE}/get", params=params, headers=UA_HEADERS, timeout=8)
        if r.status_code == 200:
            data = r.json()
            if data.get("syncedLyrics"):
                return data["syncedLyrics"]
    except requests.RequestException:
        pass

    # 2. Fuzzy search endpoint
    search_params = {"track_name": title}
    if artist:
        search_params["artist_name"] = artist

    try:
        r = requests.get(f"{LRCLIB_BASE}/search", params=search_params, headers=UA_HEADERS, timeout=8)
        if r.status_code == 200:
            results = r.json()
            if isinstance(results, list):
                candidates = [item for item in results if item.get("syncedLyrics")]
                if duration is not None:
                    duration_matches = []
                    for item in candidates:
                        try:
                            item_duration = float(item["duration"])
                        except (KeyError, TypeError, ValueError):
                            continue
                        duration_matches.append((abs(item_duration - duration), item))

                    if duration_matches:
                        duration_matches.sort(key=lambda match: match[0])
                        best_difference, best_match = duration_matches[0]
                        if best_difference > 3:
                            emit_event(
                                "progress",
                                stage="warning",
                                message=(
                                    f"Closest synced lyrics are {best_difference:.1f} seconds "
                                    f"from the audio duration; timing may drift."
                                ),
                            )
                        return best_match["syncedLyrics"]

                for item in candidates:
                    result_artist = item.get("artist_name")
                    if not artist or (
                        result_artist and artist.casefold() in result_artist.casefold()
                    ):
                        return item["syncedLyrics"]
    except requests.RequestException:
        pass

    return None


def fetch_synced_lyrics(
    title: str, artist: Optional[str], duration: Optional[int]
) -> Optional[LyricsSearchResult]:
    """Searches aggregate lyrics providers first, then LRCLIB directly."""
    plain_result: Optional[LyricsSearchResult] = None
    for query in _lyrics_search_queries(title, artist):
        emit_event("progress", stage="lyrics", message=f"Searching lyrics for '{query}'...")
        lyrics, provider = _search_syncedlyrics(query)
        if lyrics is None:
            continue

        lyrics_format = "synced" if _LRC_TIMESTAMP_PATTERN.search(lyrics) else "plain"
        source = "syncedlyrics"
        candidate = LyricsSearchResult(lyrics, lyrics_format, provider, source)
        if lyrics_format == "synced":
            return candidate
        plain_result = candidate
        break

    emit_event("progress", stage="lrclib", message="Searching lrclib.net directly...")
    direct_lyrics = _fetch_lrclib_lyrics(title, artist, duration)
    if direct_lyrics:
        return LyricsSearchResult(
            direct_lyrics,
            "synced",
            "LRCLIB (direct)",
            "lrclib",
        )
    return plain_result


def separate_vocals(audio_path: str, workdir: str) -> str:
    """Runs Demucs to isolate vocals. Returns the path to the vocals stem."""
    emit_event("progress", stage="demucs", message="Separating vocals from background music (Demucs)...")

    cmd = [sys.executable, "-m", "demucs", "--two-stems", "vocals", "-o", workdir, audio_path]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        # Fallback to direct demucs CLI if module call failed
        cmd_cli = ["demucs", "--two-stems", "vocals", "-o", workdir, audio_path]
        result_cli = subprocess.run(cmd_cli, capture_output=True, text=True)
        if result_cli.returncode != 0:
            err_msg = result.stderr or result_cli.stderr or "Demucs process failed"
            raise RuntimeError(err_msg.strip())

    vocals_matches = glob.glob(os.path.join(workdir, "**", "vocals.wav"), recursive=True)
    if not vocals_matches:
        raise RuntimeError("Demucs completed but vocals.wav stem was not found.")

    return vocals_matches[0]


def group_words_into_lines(
    words: List[Any],
    pause_threshold: float = 0.65,
    max_words_per_line: int = 8,
    min_trailing_words: int = 3,
) -> List[Dict[str, Any]]:
    """Groups words into timestamped lyric lines based on pauses and word count caps.
    Merges trailing lines under min_trailing_words into the preceding line to prevent orphan lines.
    """
    if not words:
        return []

    def get_prop(w: Any, prop: str) -> Any:
        if isinstance(w, dict):
            return w.get(prop)
        return getattr(w, prop, None)

    lines: List[Dict[str, Any]] = []
    current_words: List[str] = []
    line_start: Optional[float] = None
    last_end: Optional[float] = None

    def flush() -> None:
        nonlocal current_words, line_start
        if current_words and line_start is not None:
            text = " ".join(current_words).strip()
            if text:
                lines.append({"time": round(line_start, 2), "text": text})
            current_words = []
            line_start = None

    for word in words:
        raw_text = get_prop(word, "word")
        if not raw_text:
            continue
        word_text = str(raw_text).strip()
        if not word_text:
            continue

        w_start = float(get_prop(word, "start") or 0.0)
        w_end = float(get_prop(word, "end") or w_start)

        if line_start is None:
            line_start = w_start

        if last_end is not None and (w_start - last_end) > pause_threshold and current_words:
            flush()
            line_start = w_start

        current_words.append(word_text)
        last_end = w_end

        if len(current_words) >= max_words_per_line:
            flush()

    flush()

    # Merge trailing lines under min_trailing_words into the preceding line
    while len(lines) > 1 and len(lines[-1]["text"].split()) < min_trailing_words:
        orphan = lines.pop()
        lines[-1]["text"] = f"{lines[-1]['text']} {orphan['text']}".strip()

    return lines


def transcribe(audio_path: str, model_size: str = "small") -> List[Dict[str, Any]]:
    """Transcribes audio with word-level timestamps using faster-whisper."""
    emit_event("progress", stage="whisper", message=f"Transcribing vocals with faster-whisper ({model_size})...")

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        fail(
            "missing_dependency",
            "faster-whisper is not installed. Please run `pip install faster-whisper` in your Python environment.",
        )

    compute_type = "int8"
    try:
        model = WhisperModel(model_size, device="cpu", compute_type=compute_type)
    except Exception:
        try:
            model = WhisperModel(model_size, device="cpu", compute_type="float32")
        except Exception as exc:
            fail("transcription_failed", f"Failed to initialize Whisper model '{model_size}': {str(exc)}")

    def log_audio_diagnostics(vad_filter: bool) -> None:
        try:
            import av
            import numpy as np

            duration = 0.0
            peak = 0.0
            sum_squares = 0.0
            sample_count = 0

            with av.open(audio_path) as container:
                audio_stream = next(
                    (stream for stream in container.streams if stream.type == "audio"),
                    None,
                )
                if audio_stream is None:
                    raise ValueError("No audio stream found")

                for frame in container.decode(audio=audio_stream.index):
                    samples = frame.to_ndarray()
                    if samples.size == 0:
                        continue

                    sample_values = samples.astype(np.float64, copy=False)
                    if np.issubdtype(samples.dtype, np.integer):
                        full_scale = float(np.iinfo(samples.dtype).max)
                    else:
                        full_scale = 1.0

                    normalized = sample_values / full_scale
                    peak = max(peak, float(np.max(np.abs(normalized))))
                    sum_squares += float(np.sum(normalized * normalized))
                    sample_count += normalized.size
                    if frame.sample_rate:
                        duration += frame.samples / frame.sample_rate

            if sample_count == 0:
                raise ValueError("No decoded audio samples found")

            rms = (sum_squares / sample_count) ** 0.5
            peak_dbfs = 20 * math.log10(peak) if peak else float("-inf")
            rms_dbfs = 20 * math.log10(rms) if rms else float("-inf")
            print(
                f"[audio-debug] path={audio_path!r} duration={duration:.2f}s "
                f"peak={peak:.6f} ({peak_dbfs:.1f} dBFS) "
                f"rms={rms:.6f} ({rms_dbfs:.1f} dBFS) vad_filter={vad_filter}",
                file=sys.stderr,
                flush=True,
            )
        except Exception as exc:
            print(
                f"[audio-debug] unable to inspect {audio_path!r}: {exc}",
                file=sys.stderr,
                flush=True,
            )

    def run_pass(vad_filter: bool) -> List[Any]:
        log_audio_diagnostics(vad_filter)
        segments, _ = model.transcribe(
            audio_path,
            word_timestamps=True,
            condition_on_previous_text=False,
            vad_filter=vad_filter,
            vad_parameters=dict(min_silence_duration_ms=400) if vad_filter else None,
            no_speech_threshold=0.6,
        )
        words: List[Any] = []
        for segment in segments:
            segment_words = getattr(segment, "words", None) or []
            words.extend(segment_words)
        return words

    try:
        all_words = run_pass(vad_filter=True)

        if not all_words:
            # Voice-activity filtering is trained on clean speech and can
            # wrongly zero out an entire track when the audio is heavily
            # processed (e.g. a Demucs-separated vocal stem, or a dense,
            # bass-heavy mix used as a fallback). Retry once without it
            # before concluding there's genuinely no speech.
            emit_event(
                "progress",
                stage="whisper",
                message="No speech found with voice-activity filtering; retrying without it...",
            )
            all_words = run_pass(vad_filter=False)

        return group_words_into_lines(all_words)
    except Exception as exc:
        fail("transcription_failed", f"Transcription error: {str(exc)}")
        return []


def main() -> None:
    parser = argparse.ArgumentParser(description="Lyrics Sync Audio Pipeline")
    parser.add_argument("audio_path", help="Path to input audio file")
    parser.add_argument(
        "--model",
        default="small",
        choices=["tiny", "base", "small", "medium", "large", "large-v2", "large-v3"],
        help="faster-whisper model size (default: small)",
    )
    args = parser.parse_args()

    audio_path = os.path.abspath(args.audio_path)
    if not os.path.exists(audio_path):
        fail("file_not_found", f"Audio file not found: {audio_path}")

    if os.path.getsize(audio_path) == 0:
        fail("invalid_audio", f"Audio file is empty (0 bytes): {audio_path}")

    # Check local cache first
    try:
        file_hash = compute_file_hash(audio_path)
        cached_result = load_cached_lyrics(file_hash)
        if cached_result:
            emit_event("progress", stage="cache", message="Loaded cached lyrics for this track.")
            emit_event(
                "result",
                source=cached_result["source"],
                title=cached_result.get("title"),
                artist=cached_result.get("artist"),
                format=cached_result.get("format"),
                provider=cached_result.get("provider"),
                lines=cached_result.get("lines", []),
            )
            print(json.dumps(cached_result), flush=True)
            return
    except Exception as exc:
        file_hash = None
        emit_event("progress", stage="warning", message=f"Cache lookup failed: {str(exc)}")

    emit_event("progress", stage="init", message="Validating audio file and environment...")
    tools = check_tool_availability()

    # 1. Try AcoustID Identification
    song_info = identify_song_acoustid(audio_path, tools)

    # 2. Fallback to Embedded Audio Tags (ID3 / Vorbis / MP4)
    if not song_info:
        emit_event("progress", stage="tags", message="Reading audio tags from file...")
        song_info = extract_audio_tags(audio_path)

    # 3. If track metadata was found, search aggregated providers and LRCLIB.
    if song_info and song_info.get("title"):
        title = song_info["title"]
        artist = song_info.get("artist")
        duration = song_info.get("duration")

        lyric_result = fetch_synced_lyrics(title, artist, duration)
        if lyric_result:
            lines, source, lyrics_format = prepare_lyrics_output(
                lyric_result, audio_path
            )
            if lines:
                result_payload = {
                    "source": source,
                    "title": title,
                    "artist": artist,
                    "format": lyrics_format,
                    "provider": lyric_result.provider,
                    "lines": lines,
                }
                if file_hash:
                    save_cached_lyrics(file_hash, result_payload)
                emit_event("result", **result_payload)
                print(json.dumps(result_payload), flush=True)
                return

    # 4. Fallback AI Pipeline: Vocal Isolation + Whisper Transcription
    if not tools["ffmpeg"]:
        fail(
            "missing_dependency",
            "ffmpeg is required for vocal separation and transcription, but was not found on your system PATH.",
        )

    fallback_title = (
        song_info["title"]
        if (song_info and song_info.get("title"))
        else os.path.splitext(os.path.basename(audio_path))[0]
    )
    fallback_artist = song_info.get("artist") if song_info else None

    with tempfile.TemporaryDirectory() as workdir:
        vocals_path = audio_path
        try:
            vocals_path = separate_vocals(audio_path, workdir)
        except Exception as exc:
            emit_event(
                "progress",
                stage="warning",
                message=f"Demucs separation skipped ({str(exc)}). Transcribing mix directly...",
            )
            vocals_path = audio_path

        lines = transcribe(vocals_path, model_size=args.model)

    if not lines:
        fail("no_lyrics_detected", "No lyrics or vocal phrases were detected in this audio file.")

    final_result = {
        "source": "whisper",
        "title": fallback_title,
        "artist": fallback_artist,
        "lines": lines,
    }

    if file_hash:
        save_cached_lyrics(file_hash, final_result)

    emit_event("result", **final_result)
    print(json.dumps(final_result), flush=True)


if __name__ == "__main__":
    main()