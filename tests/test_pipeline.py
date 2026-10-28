"""
Unit tests for lyrics sync pipeline functions:
- parse_lrc()
- group_words_into_lines()
- compute_file_hash(), save_cached_lyrics(), load_cached_lyrics()
"""

import json
import os
import sys
import tempfile
import pytest

import pipeline

from pipeline import (
    parse_lrc,
    group_words_into_lines,
    compute_file_hash,
    save_cached_lyrics,
    load_cached_lyrics,
    fetch_synced_lyrics,
    LyricsSearchResult,
    _lyrics_result_lines,
    _lyrics_search_queries,
    estimate_lyrics_timestamps,
    prepare_lyrics_output,
    read_audio_duration,
    find_lyrics,
    read_embedded_lyrics,
    read_sidecar_lyrics,
    LYRICS_PROVIDERS,
    build_user_agent,
)


# Helper class to simulate faster-whisper word objects
class FakeWord:
    def __init__(self, word: str, start: float, end: float):
        self.word = word
        self.start = start
        self.end = end


class TestParseLrc:
    def test_empty_string(self):
        assert parse_lrc("") == []
        assert parse_lrc(None) == []

    def test_single_timestamps(self):
        lrc = """
        [00:04.50]First line of the song
        [00:09.25]Second line follows
        [01:15.00]One minute fifteen
        """
        parsed = parse_lrc(lrc)
        assert len(parsed) == 3
        assert parsed[0] == {"time": 4.5, "text": "First line of the song"}
        assert parsed[1] == {"time": 9.25, "text": "Second line follows"}
        assert parsed[2] == {"time": 75.0, "text": "One minute fifteen"}

    def test_multiple_timestamps_per_line(self):
        lrc = """
        [00:10.00][00:30.00]Chorus repeats here
        [00:20.00]Verse in between
        """
        parsed = parse_lrc(lrc)
        # Should be sorted chronologically
        assert len(parsed) == 3
        assert parsed[0] == {"time": 10.0, "text": "Chorus repeats here"}
        assert parsed[1] == {"time": 20.0, "text": "Verse in between"}
        assert parsed[2] == {"time": 30.0, "text": "Chorus repeats here"}

    def test_offset_header_positive(self):
        lrc = """
        [ti:Test Title]
        [ar:Test Artist]
        [offset:+1000]
        [00:05.00]Shifted by one second
        """
        parsed = parse_lrc(lrc)
        assert len(parsed) == 1
        # 5.00 + 1.00 offset = 6.00
        assert parsed[0] == {"time": 6.0, "text": "Shifted by one second"}

    def test_offset_header_negative(self):
        lrc = """
        [offset:-500]
        [00:05.50]Shifted earlier
        """
        parsed = parse_lrc(lrc)
        assert len(parsed) == 1
        # 5.50 - 0.50 offset = 5.00
        assert parsed[0] == {"time": 5.0, "text": "Shifted earlier"}

    def test_gap_lines_preserved(self):
        lrc = """
        [00:10.00]Singing phrase
        [00:15.00]
        [00:25.00]Next phrase after solo
        """
        parsed = parse_lrc(lrc)
        assert len(parsed) == 3
        assert parsed[0]["text"] == "Singing phrase"
        assert parsed[1]["text"] == ""  # Gap line to clear active lyric
        assert parsed[2]["text"] == "Next phrase after solo"

    def test_non_matching_lines_ignored(self):
        lrc = """
        [length: 03:45]
        [re: LRCLIB]
        Just random commentary without timestamp
        [00:01.00]Valid lyric
        """
        parsed = parse_lrc(lrc)
        assert len(parsed) == 1
        assert parsed[0] == {"time": 1.0, "text": "Valid lyric"}


class TestGroupWordsIntoLines:
    def test_empty_words(self):
        assert group_words_into_lines([]) == []

    def test_pause_based_splitting(self):
        # Two phrases separated by a 1.5s gap (> 0.65 threshold)
        words = [
            FakeWord("Hello", 0.0, 0.4),
            FakeWord("world", 0.5, 0.9),
            FakeWord("again", 1.0, 1.4),
            # Gap from 1.4 to 3.0 (1.6s)
            FakeWord("This", 3.0, 3.3),
            FakeWord("is", 3.4, 3.6),
            FakeWord("verse", 3.7, 4.1),
            FakeWord("two", 4.2, 4.6),
        ]
        lines = group_words_into_lines(words, pause_threshold=0.65)
        assert len(lines) == 2
        assert lines[0] == {"time": 0.0, "text": "Hello world again"}
        assert lines[1] == {"time": 3.0, "text": "This is verse two"}

    def test_merge_trailing_orphan_under_three_words(self):
        # 9 words: 8 words fit on line 1, 9th word leaves 1 trailing word
        words = [
            FakeWord("One", 0.0, 0.2),
            FakeWord("two", 0.3, 0.5),
            FakeWord("three", 0.6, 0.8),
            FakeWord("four", 0.9, 1.1),
            FakeWord("five", 1.2, 1.4),
            FakeWord("six", 1.5, 1.7),
            FakeWord("seven", 1.8, 2.0),
            FakeWord("eight", 2.1, 2.3),
            # 9th word after max_words_per_line cap
            FakeWord("nine", 2.4, 2.7),
        ]
        # With max_words_per_line=8 and min_trailing_words=3,
        # "nine" (1 word) should be merged back into the preceding line.
        lines = group_words_into_lines(words, max_words_per_line=8, min_trailing_words=3)
        assert len(lines) == 1
        assert lines[0]["text"] == "One two three four five six seven eight nine"
        assert lines[0]["time"] == 0.0

    def test_trailing_line_with_three_or_more_words_not_merged(self):
        # 11 words: 8 words on line 1, 3 words on line 2
        words = [
            FakeWord("One", 0.0, 0.2),
            FakeWord("two", 0.3, 0.5),
            FakeWord("three", 0.6, 0.8),
            FakeWord("four", 0.9, 1.1),
            FakeWord("five", 1.2, 1.4),
            FakeWord("six", 1.5, 1.7),
            FakeWord("seven", 1.8, 2.0),
            FakeWord("eight", 2.1, 2.3),
            # Line 2 has 3 words (meets min_trailing_words)
            FakeWord("nine", 3.0, 3.2),
            FakeWord("ten", 3.3, 3.5),
            FakeWord("eleven", 3.6, 3.9),
        ]
        lines = group_words_into_lines(words, max_words_per_line=8, min_trailing_words=3)
        assert len(lines) == 2
        assert lines[0]["text"] == "One two three four five six seven eight"
        assert lines[1]["text"] == "nine ten eleven"

    def test_dict_format_words_supported(self):
        words = [
            {"word": "Sing", "start": 1.0, "end": 1.5},
            {"word": "a", "start": 1.6, "end": 1.7},
            {"word": "song", "start": 1.8, "end": 2.2},
        ]
        lines = group_words_into_lines(words)
        assert len(lines) == 1
        assert lines[0] == {"time": 1.0, "text": "Sing a song"}

    def test_single_short_line_preserved(self):
        # If the entire song/input is only 1 or 2 words, it shouldn't be deleted
        words = [
            FakeWord("Hello", 0.5, 1.0),
            FakeWord("there", 1.1, 1.5),
        ]
        lines = group_words_into_lines(words, min_trailing_words=3)
        assert len(lines) == 1
        assert lines[0] == {"time": 0.5, "text": "Hello there"}


class TestCaching:
    def test_hashing_and_cache_roundtrip(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            audio_dummy = os.path.join(temp_dir, "test.mp3")
            with open(audio_dummy, "wb") as f:
                f.write(b"ID3\x03\x00\x00fake audio content for hash test 123456789")

            h1 = compute_file_hash(audio_dummy)
            h2 = compute_file_hash(audio_dummy)
            assert h1 == h2
            assert len(h1) == 64  # SHA256 hex string length

            cache_subfolder = os.path.join(temp_dir, "cache")
            payload = {
                "source": "lrclib",
                "title": "Bohemian Rhapsody",
                "artist": "Queen",
                "format": "synced",
                "provider": "LRCLIB (direct)",
                "lines": [{"time": 1.23, "text": "Is this the real life?"}],
            }

            save_cached_lyrics(h1, payload, cache_dir=cache_subfolder)
            loaded = load_cached_lyrics(h1, cache_dir=cache_subfolder)

            assert loaded is not None
            assert loaded["title"] == "Bohemian Rhapsody"
            assert loaded["artist"] == "Queen"
            assert loaded["format"] == "synced"
            assert loaded["provider"] == "LRCLIB (direct)"
            assert loaded["lines"] == [{"time": 1.23, "text": "Is this the real life?"}]
            assert loaded["file_hash"] == h1
            assert loaded["match_version"] == 5

    def test_cache_miss(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            assert load_cached_lyrics("nonexistent_hash", cache_dir=temp_dir) is None

    def test_old_lrclib_cache_is_ignored_after_matcher_update(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            cache_path = os.path.join(temp_dir, "old_match.json")
            with open(cache_path, "w", encoding="utf-8") as cache_file:
                json.dump(
                    {
                        "source": "lrclib",
                        "title": "Track",
                        "artist": "Artist",
                        "match_version": 3,
                        "lines": [{"time": 1, "text": "old match"}],
                    },
                    cache_file,
                )

            assert load_cached_lyrics("old_match", cache_dir=temp_dir) is None


class TestSyncedLyricsSearch:
    @staticmethod
    def response(status_code, payload):
        class FakeResponse:
            def __init__(self):
                self.status_code = status_code

            def json(self):
                return payload

        return FakeResponse()

    def test_search_chooses_duration_closest_match(self, monkeypatch):
        search_results = [
            {"syncedLyrics": "far match", "duration": 208, "artist_name": "Artist"},
            {"syncedLyrics": "closest match", "duration": 201.5, "artist_name": "Artist"},
            {"syncedLyrics": "within two seconds", "duration": 199, "artist_name": "Artist"},
        ]

        def fake_get(url, **_kwargs):
            if url.endswith("/get"):
                return self.response(404, {})
            return self.response(200, search_results)

        monkeypatch.setattr("pipeline._search_syncedlyrics", lambda _query, **_kwargs: (None, "syncedlyrics"))
        monkeypatch.setattr("pipeline.requests.get", fake_get)
        result = fetch_synced_lyrics("Track", "Artist", 200)
        assert result is not None
        assert result.text == "within two seconds"
        assert result.provider == "LRCLIB (direct)"

    def test_search_warns_when_closest_match_is_over_three_seconds_off(self, monkeypatch):
        search_results = [
            {"syncedLyrics": "farther match", "duration": 210, "artist_name": "Artist"},
            {"syncedLyrics": "closest match", "duration": 204.5, "artist_name": "Artist"},
        ]
        events = []

        def fake_get(url, **_kwargs):
            if url.endswith("/get"):
                return self.response(404, {})
            return self.response(200, search_results)

        monkeypatch.setattr("pipeline._search_syncedlyrics", lambda _query, **_kwargs: (None, "syncedlyrics"))
        monkeypatch.setattr("pipeline.requests.get", fake_get)
        monkeypatch.setattr("pipeline.emit_event", lambda event_type, **kwargs: events.append((event_type, kwargs)))

        result = fetch_synced_lyrics("Track", "Artist", 200)
        assert result is not None
        assert result.text == "closest match"
        warning_events = [
            event for event in events
            if event[0] == "progress" and event[1].get("stage") == "warning"
        ]
        assert warning_events == [
            (
                "progress",
                {
                    "stage": "warning",
                    "message": "Closest synced lyrics are 4.5 seconds from the audio duration; timing may drift.",
                },
            )
        ]

    def test_search_uses_query_variants_in_order_and_reports_provider(self, monkeypatch):
        queries = []

        def fake_search(query, *, allow_plain_format, providers):
            assert allow_plain_format is True
            assert providers == ["Musixmatch", "NetEase", "Megalobiz", "Genius"]
            queries.append(query)
            if len(queries) == 1:
                return None
            import logging
            logging.getLogger("syncedlyrics").info(
                'Lyrics found for "%s" on Musixmatch', query
            )
            return "[00:01.00]A lyric"

        monkeypatch.setattr("pipeline.syncedlyrics.search", fake_search)
        monkeypatch.setattr(
            "pipeline._fetch_lrclib_lyrics",
            lambda *_args: None,
        )

        result = fetch_synced_lyrics(
            "Song Title (2019 Remaster) feat. Guest Artist",
            "Main Artist",
            180,
            enabled_providers=["lrclib", "extra"],
        )

        assert queries == [
            "Song Title (2019 Remaster) feat. Guest Artist Main Artist",
            "Song Title Main Artist",
        ]
        assert result is not None
        assert result.format == "synced"
        assert result.provider == "Musixmatch"
        assert result.source == "extra"
        assert result.text == "[00:01.00]A lyric"

    def test_distinctive_title_adds_title_only_search_after_artist_query(self, monkeypatch):
        assert _lyrics_search_queries(
            "The Predatory Wasp of the Palisades Is Out to Get Us! (Live)",
            "Sufjan Stevens",
        ) == [
            "The Predatory Wasp of the Palisades Is Out to Get Us! (Live) Sufjan Stevens",
            "The Predatory Wasp of the Palisades Is Out to Get Us! Sufjan Stevens",
            "The Predatory Wasp of the Palisades Is Out to Get Us!",
        ]

    def test_plain_lyrics_are_preserved_when_direct_lrclib_has_no_match(self, monkeypatch):
        monkeypatch.setattr(
            "pipeline._search_syncedlyrics",
            lambda _query, **_kwargs: (
                "First plain lyric\nSecond plain lyric",
                "Genius",
            ),
        )
        monkeypatch.setattr("pipeline._fetch_lrclib_lyrics", lambda *_args: None)

        result = fetch_synced_lyrics("Track", "Artist", 200, enabled_providers=["lrclib", "extra"])

        assert result is not None
        assert result.format == "plain"
        assert result.source == "extra"
        assert result.provider == "Genius"
        assert result.text == "First plain lyric\nSecond plain lyric"

    def test_plain_lyrics_are_not_sent_to_lrc_parser(self, monkeypatch):
        monkeypatch.setattr(
            "pipeline.parse_lrc",
            lambda _text: pytest.fail("Plain lyrics must not be parsed as LRC"),
        )

        lines = _lyrics_result_lines(
            LyricsSearchResult(
                "First plain lyric\nSecond plain lyric",
                "plain",
                "Genius",
                "syncedlyrics",
            )
        )

        assert lines == [
            {"text": "First plain lyric"},
            {"text": "Second plain lyric"},
        ]

    def test_plain_lyrics_get_even_timestamps_from_audio_duration(self, monkeypatch):
        monkeypatch.setattr("pipeline.read_audio_duration", lambda _path: 180.0)
        result = LyricsSearchResult(
            "First plain lyric\n\nSecond plain lyric\nThird plain lyric",
            "plain",
            "Genius",
            "syncedlyrics",
        )

        lines, source, lyrics_format = prepare_lyrics_output(result, "track.mp3")

        assert lines == [
            {"time": 0.0, "text": "First plain lyric"},
            {"time": 60.0, "text": "Second plain lyric"},
            {"time": 120.0, "text": "Third plain lyric"},
        ]
        assert source == "syncedlyrics"
        assert lyrics_format == "estimated"

    def test_plain_lyrics_use_file_duration_not_identified_track_duration(self, monkeypatch):
        audio_file_duration = 241.75
        monkeypatch.setattr(
            "pipeline.read_audio_duration",
            lambda audio_path: audio_file_duration if audio_path == "track.mp3" else None,
        )
        result = LyricsSearchResult(
            "Line one\nLine two\nLine three",
            "plain",
            "Genius",
            "syncedlyrics",
        )

        lines, source, _lyrics_format = prepare_lyrics_output(result, "track.mp3")

        assert [line["time"] for line in lines] == [0.0, 80.58, 161.17]
        assert lines[-1]["time"] < audio_file_duration
        assert source == "syncedlyrics"

    def test_plain_lyrics_remain_available_when_audio_duration_is_unavailable(self, monkeypatch):
        monkeypatch.setattr("pipeline.read_audio_duration", lambda _path: None)
        result = LyricsSearchResult(
            "Line one\nLine two",
            "plain",
            "Genius",
            "syncedlyrics",
        )

        lines, source, lyrics_format = prepare_lyrics_output(result, "track.mp3")

        assert lines == [{"text": "Line one"}, {"text": "Line two"}]
        assert source == "syncedlyrics"
        assert lyrics_format == "plain"

    def test_audio_duration_falls_back_to_ffprobe(self, monkeypatch):
        import tinytag
        from types import SimpleNamespace

        monkeypatch.setattr(
            tinytag.TinyTag,
            "get",
            lambda _path: SimpleNamespace(duration=None),
        )
        monkeypatch.setattr("pipeline.shutil.which", lambda _name: "ffprobe")
        monkeypatch.setattr(
            "pipeline.subprocess.run",
            lambda *_args, **_kwargs: SimpleNamespace(
                returncode=0,
                stdout="241.75\n",
                stderr="",
            ),
        )

        assert read_audio_duration("track.mp3") == 241.75

    def test_direct_lrclib_synced_result_takes_precedence_over_plain_fallback(self, monkeypatch):
        monkeypatch.setattr(
            "pipeline._search_syncedlyrics",
            lambda _query, **_kwargs: ("Plain lyrics", "Genius"),
        )
        monkeypatch.setattr(
            "pipeline._fetch_lrclib_lyrics",
            lambda *_args: "[00:01.00]Timed lyrics",
        )

        result = fetch_synced_lyrics("Track", "Artist", 200, enabled_providers=["lrclib", "extra"])

        assert result is not None
        assert result.format == "synced"
        assert result.source == "lrclib"
        assert result.provider == "LRCLIB (direct)"
        assert result.text == "[00:01.00]Timed lyrics"

    def test_lrclib_rate_limit_returns_control_to_fallback(self, monkeypatch):
        events = []
        monkeypatch.setattr(
            "pipeline.requests.get",
            lambda *_args, **_kwargs: type("Response", (), {"status_code": 429})(),
        )
        monkeypatch.setattr(
            "pipeline.emit_event",
            lambda event_type, **kwargs: events.append((event_type, kwargs)),
        )

        assert pipeline._fetch_lrclib_lyrics("Unknown Track", None, None) is None
        assert any(
            event_type == "progress" and data.get("stage") == "warning"
            for event_type, data in events
        )


class TestProviderOrder:
    def test_registry_defaults_and_lrclib_user_agent(self):
        assert pipeline.enabled_provider_ids() == [
            "embedded", "sidecar", "lrclib", "whisper"
        ]
        assert next(provider for provider in LYRICS_PROVIDERS if provider["id"] == "extra")[
            "enabled_by_default"
        ] is False
        assert build_user_agent("Lyrics Sync", "2.3.4") == (
            "Lyrics Sync/2.3.4 (TODO: Replace with the public project URL)"
        )

    def test_embedded_and_sidecar_readers(self, monkeypatch, tmp_path):
        audio_path = tmp_path / "embedded.mp3"
        audio_path.write_bytes(b"audio")
        monkeypatch.setattr(
            "pipeline._mutagen_lyrics_text",
            lambda _path: "[00:01.00]embedded test lyric",
        )
        embedded = read_embedded_lyrics(str(audio_path))
        assert embedded is not None
        assert embedded.source == "embedded"
        assert embedded.format == "synced"

        audio_path = tmp_path / "sidecar.mp3"
        audio_path.write_bytes(b"audio")
        (tmp_path / "sidecar.lrc").write_text(
            "[00:02.00]sidecar test lyric\n", encoding="utf-8"
        )
        sidecar = read_sidecar_lyrics(str(audio_path))
        assert sidecar is not None
        assert sidecar.source == "sidecar"
        assert sidecar.provider == "Sidecar .lrc"

    def test_three_song_provider_trace(self, monkeypatch, tmp_path):
        song_paths = {}
        for name in ("embedded-song", "sidecar-song", "transcribed-song"):
            path = tmp_path / f"{name}.mp3"
            path.write_bytes(f"synthetic audio {name}".encode("utf-8"))
            song_paths[name] = str(path)
        (tmp_path / "sidecar-song.lrc").write_text(
            "[00:02.00]sidecar test lyric\n", encoding="utf-8"
        )

        lyric_tags = {
            song_paths["embedded-song"]: "[00:01.00]embedded test lyric",
            song_paths["sidecar-song"]: None,
            song_paths["transcribed-song"]: None,
        }
        monkeypatch.setattr(
            "pipeline._mutagen_lyrics_text",
            lambda path: lyric_tags[path],
        )
        monkeypatch.setattr(
            "pipeline.extract_audio_tags",
            lambda path: {
                "title": os.path.splitext(os.path.basename(path))[0],
                "artist": "Test Artist",
                "duration": 12,
            },
        )
        monkeypatch.setattr("pipeline._fetch_lrclib_lyrics", lambda *_args: None)
        monkeypatch.setattr(
            "pipeline.check_tool_availability",
            lambda: {"ffmpeg": True, "fpcalc": False},
        )
        monkeypatch.setattr("pipeline.identify_song_acoustid", lambda *_args: None)
        monkeypatch.setattr("pipeline.separate_vocals", lambda audio, _workdir: audio)
        monkeypatch.setattr(
            "pipeline.transcribe",
            lambda _audio, model_size, model_dir: [{"time": 0.0, "text": model_size}],
        )

        traces = {}
        for name, audio_path in song_paths.items():
            events = []
            monkeypatch.setattr(
                "pipeline.emit_event",
                lambda event_type, _events=events, **kwargs: _events.append((event_type, kwargs)),
            )
            monkeypatch.setattr(
                sys,
                "argv",
                [
                    "pipeline.py",
                    audio_path,
                    "--cache-dir",
                    str(tmp_path / "user-data-cache"),
                ],
            )
            pipeline.main()
            traces[name] = [
                data["provider"]
                for event_type, data in events
                if event_type == "progress" and data.get("stage") == "provider"
            ]

        assert traces == {
            "embedded-song": ["embedded"],
            "sidecar-song": ["embedded", "sidecar"],
            "transcribed-song": ["embedded", "sidecar", "lrclib", "whisper"],
        }

    def test_filename_is_used_for_lrclib_after_tags_do_not_match(
        self, monkeypatch, tmp_path, capsys
    ):
        audio_path = tmp_path / "Artist - Filename Title.mp3"
        audio_path.write_bytes(b"synthetic audio")
        searched = []
        result = LyricsSearchResult(
            "[00:01.00]Lyrics from filename search",
            "synced",
            "LRCLIB (direct)",
            "lrclib",
        )
        monkeypatch.setattr("pipeline._mutagen_lyrics_text", lambda _path: None)
        monkeypatch.setattr("pipeline.extract_audio_tags", lambda _path: None)
        monkeypatch.setattr(
            "pipeline.check_tool_availability",
            lambda: {"ffmpeg": False, "fpcalc": False},
        )
        monkeypatch.setattr("pipeline.identify_song_acoustid", lambda *_args: None)
        monkeypatch.setattr("pipeline.read_audio_duration", lambda _path: 10)

        def find_by_title(title, artist, duration, providers):
            searched.append((title, artist, duration, providers))
            return result if title == "Artist - Filename Title" else None

        monkeypatch.setattr("pipeline.fetch_synced_lyrics", find_by_title)
        monkeypatch.setattr(
            sys,
            "argv",
            [
                "pipeline.py",
                str(audio_path),
                "--cache-dir",
                str(tmp_path / "cache"),
                "--enabled-providers",
                "embedded",
                "sidecar",
                "lrclib",
            ],
        )

        pipeline.main()

        assert searched == [
            ("Artist - Filename Title", None, 10, ["embedded", "sidecar", "lrclib"])
        ]
        result_data = json.loads(capsys.readouterr().out.splitlines()[-1])
        assert result_data["title"] == "Artist - Filename Title"
        assert result_data["lines"] == [
            {"time": 1.0, "text": "Lyrics from filename search"}
        ]
