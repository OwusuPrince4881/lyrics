# Lyrics Sync

Drop an audio file onto the window. The app identifies the song and pulls
scroll-synced lyrics — or, if the track is unknown, separates the vocals and
transcribes them automatically. Either way you get a live lyrics view that
highlights the current line and follows playback.

---

## Install (End Users)

### 1. Download the installer

| Platform | File |
|---|---|
| **Windows** | `Lyrics Sync Setup x.x.x.exe` (one-click NSIS installer) or `Lyrics Sync x.x.x.exe` (portable, no install needed) |
| **macOS** | `Lyrics Sync-x.x.x.dmg` (drag to Applications) |
| **Linux** | `Lyrics Sync-x.x.x.AppImage` (make executable, then run) |

Grab the latest release from the [Releases](../../releases) page.

---

### 2. Install Python and system dependencies

> **Why?** The app ships its own Python script (`backend/pipeline.py`) but
> does **not** bundle a Python runtime or the large AI models. You need to
> install these once on your machine.

#### Python (3.9 or newer)

- **Windows**: [python.org/downloads](https://www.python.org/downloads/) — tick
  "Add Python to PATH" during setup.
- **macOS**: `brew install python` or the official installer.
- **Linux**: `sudo apt install python3 python3-pip` (Debian/Ubuntu) or your
  distro's equivalent.

Verify: open a terminal and run `python --version` (Windows) or
`python3 --version` (macOS/Linux).

#### Python packages

Open a terminal and run:

```bash
pip install requests pyacoustid faster-whisper demucs tinytag syncedlyrics
```

> On macOS/Linux use `pip3` if `pip` points to Python 2.

#### System tools

These must be on your system **PATH**:

| Tool | Purpose | Install |
|---|---|---|
| **ffmpeg** | Audio decoding for Demucs/Whisper | `brew install ffmpeg` · `sudo apt install ffmpeg` · [ffmpeg.org](https://ffmpeg.org/download.html) (Windows) |
| **fpcalc** | Audio fingerprinting (optional) | `brew install chromaprint` · `sudo apt install libchromaprint-tools` · [acoustid.org/chromaprint](https://acoustid.org/chromaprint) (Windows) |

`fpcalc` is **optional** — without it the app still reads embedded ID3/MP4 tags
to look up lyrics. Only `ffmpeg` is strictly required for the AI fallback path.

---

### 3. (Optional) AcoustID API key

For better fingerprint-based song identification, get a free key at
[acoustid.org/api-key](https://acoustid.org/api-key) and set it as an
environment variable before launching the app:

```bash
# macOS / Linux — add to ~/.zshrc or ~/.bashrc
export ACOUSTID_API_KEY=your_key_here

# Windows (PowerShell, persists for current session)
$env:ACOUSTID_API_KEY = "your_key_here"

# Windows (permanent, via System Settings → Environment Variables)
ACOUSTID_API_KEY = your_key_here
```

Without this key the app automatically falls back to reading embedded audio
tags, so song identification still works for files that have proper metadata.

---

### 4. Launch

Double-click **Lyrics Sync** from your Applications folder, Start Menu, or
desktop shortcut. Drag any audio file onto the window to begin.

Supported formats: MP3, WAV, FLAC, M4A, OGG, AAC, Opus, WMA.

---

## How lyrics are sourced

```
Audio file dropped
       │
       ├─ AcoustID fingerprint (if fpcalc + API key present)
       │         │ match found
       │         ▼
       ├─ Embedded tags (ID3 / Vorbis / MP4) — fallback
       │         │ title found
       │         ▼
       ├─ syncedlyrics providers → synced or plain lyrics
       │         ├─ synced lyrics → precise highlighting and seeking
       │         └─ plain lyrics → estimated timing from audio duration
       │         │ no match
       │         ▼
       ├─ direct lrclib.net fallback → synced .lrc lyrics
       │         │ no match
       │         ▼
       └─ Demucs vocal separation → faster-whisper transcription
                                                   ✅ "Transcribed (may be imperfect)"
```

Synced lyrics remain timestamped and seekable. If only plain lyrics are
available, their lines are evenly spaced over the audio's measured duration
and labeled **Estimated timing**. This approximate timing remains seekable and
supports sync-offset adjustment. If the file duration cannot be read, plain
lyrics remain visible without playback highlighting or seek behavior.

Previously processed files are cached locally so re-dropping the same file
is instant.

---

## Features

- **Click any lyric line** to jump playback to that timestamp.
- **Auto-scroll** keeps the current line centered. Manually scroll to read
  ahead — auto-scroll pauses and offers a **Resume** button.
- **Sync adjustment** shifts lyrics in 100 ms increments and saves the offset
  per audio file, so alternate recordings can be aligned manually.
- **Persistent player** stays visible at the bottom while the lyrics scroll
  independently above it.
- **Live progress** — the status card updates stage by stage: *Identifying
  song → Looking up lyrics → Separating vocals → Transcribing*.
- **Source badge** — identifies the lyrics provider and distinguishes matched,
  unsynced plain lyrics, and transcribed lyrics.
- **Cancel** any in-progress job without leaving orphan Python processes.
- **Whisper model size** — set the `WHISPER_MODEL` environment variable to
  `tiny`, `base`, `small` (default), `medium`, or `large` to trade speed
  for accuracy on the AI fallback path.

---

## Developer Setup

```bash
# 1. Clone
git clone https://github.com/yourname/lyrics-sync-desktop
cd lyrics-sync-desktop

# 2. Node dependencies
npm install

# 3. Python dependencies (virtualenv recommended)
python -m venv .venv
# Windows: .venv\Scripts\activate
# macOS/Linux: source .venv/bin/activate
python -m pip install -r backend/requirements.txt pytest

# 4. Run in dev mode
npm start          # or: npm run dev

# 5. Run all tests
npm test
```

In development, the app uses `.venv` when it exists; otherwise it uses Python
from `PATH`. Packaged builds use Python from `PATH` as described in the
end-user setup above.

### Build installers

```bash
npm run dist        # current platform
npm run dist:win    # Windows NSIS + portable (requires Wine on non-Windows)
npm run dist:mac    # macOS DMG + zip (must run on macOS; needs Apple ID for notarization)
npm run dist:linux  # Linux AppImage
```

Output lands in `dist/`.

#### macOS notarization

`electron-builder` supports notarization via the `@electron/notarize`
package. Add it to `devDependencies` and create `build/notarize.js`:

```js
const { notarize } = require('@electron/notarize');
exports.default = async (context) => {
  if (context.electronPlatformName !== 'darwin') return;
  await notarize({
    tool: 'notarytool',
    appPath: context.appOutDir + `/${context.packager.appInfo.productFilename}.app`,
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID,
  });
};
```

Then reference it in `package.json` under `"afterSign": "build/notarize.js"`.

#### Windows code signing

Set `WIN_CSC_LINK` (path to a `.pfx` certificate) and `WIN_CSC_KEY_PASSWORD`
before running `npm run dist:win`. Without a certificate the installer will
trigger a Windows SmartScreen warning on first run.

#### App icons

Place the following in `build/` before running a dist build:

| File | Size | Used for |
|---|---|---|
| `icon.icns` | macOS multi-resolution | DMG / macOS app |
| `icon.ico` | Windows multi-resolution | NSIS installer / taskbar |
| `icon.png` | 512×512 PNG | Linux AppImage |

---

## Known limitations

- **Python is not bundled.** A future release may vendor a minimal Python
  runtime (e.g. via `python-build-standalone`) to eliminate the manual
  install step.
- **Whisper models are downloaded on first use** from Hugging Face and cached
  in your home directory (`~/.cache/huggingface/`). The `small` model is
  ~244 MB; `medium` is ~769 MB.
- **Demucs** requires several GB of free disk space for temporary stems during
  processing. The temp directory is cleaned up after each run.
- **macOS Gatekeeper** will block an unsigned `.dmg`. Right-click → Open to
  bypass, or sign/notarize the build (see above).
