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
| **Windows** | `Lyrics Sync Setup x.x.x.exe` (per-user NSIS installer; no Python or developer tools required) |
| **macOS** | `Lyrics Sync-x.x.x.dmg` (drag to Applications) |
| **Linux** | `Lyrics Sync-x.x.x.AppImage` (make executable, then run) |

Grab the latest release from the [Releases](../../releases) page.

---

### 2. Use the app

The Windows installer includes a frozen backend and the verified media tools;
end users do not need Python, ffmpeg, fpcalc, or developer tools. Embedded tags,
same-name sidecar files, AcoustID identification (when configured in the
release), LRCLIB lookup, and optional online sources are available in the
default install. Local AI transcription is an optional download shown in
Settings; its release must be configured with a hosted pack and pinned SHA-256.

> **Release status:** This source checkout does not yet include the verified
> Windows ffmpeg/fpcalc binaries or a published AI-pack URL. A release cannot
> be packaged until those release inputs are supplied and validated.

---

### 3. (Optional) AcoustID API key

For better fingerprint-based song identification, get a free key at
[acoustid.org/api-key](https://acoustid.org/api-key) and enter it under
**Settings**. A key supplied for the release is used unless the user provides
their own. Desktop app keys are extractable; rate limits and lookup failures
fall back to embedded metadata and filename-based lyric search.

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
       ├─ Embedded lyrics (ID3 USLT/SYLT, Vorbis/FLAC, MP4)
       ├─ Same-name .lrc, then .txt sidecar
       ├─ Direct lrclib.net API lookup
       ├─ Optional extra sources (Musixmatch, NetEase, Megalobiz, Genius)
       │    disabled by default; enable in Settings after confirmation
       └─ Optional AI pack: Demucs vocal separation → faster-whisper
```

When a matching lyric tag or sidecar is present, it is used before any online
lyric source. AcoustID/MusicBrainz identification supplies track metadata for
online lookup when needed. Synced lyrics remain timestamped and seekable. If
only plain lyrics are available, their lines are evenly spaced over the audio's
measured duration and labeled **Estimated timing**. If duration cannot be read,
plain lyrics remain visible without playback highlighting or seek behavior.

When a lookup finds no lyrics, the app offers the optional AI pack. It is
downloaded only after confirmation, over HTTPS, and checked against the release's
pinned SHA-256, and installed under the user's app-data directory. Whisper and
Demucs model caches also live there; the install directory is not used for
writable application data.

The optional extra online providers are third-party sources with their own
terms. Users are responsible for how they use them and for complying with
those terms. Processed results are cached only in the user's local app-data
folder; the application does not ship or pre-seed lyric caches.

Open **About & sources** from Settings for attribution details. Lyrics belong
to their respective owners; the app does not host lyrics.

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
- **Source badge** — distinguishes embedded, sidecar, LRCLIB, extra-source,
  estimated, and transcribed lyrics.
- **Cancel** any in-progress job without leaving orphan Python processes.
- **Optional AI pack** — can be installed from Settings when a release provides
  a verified pack. AI models are stored under the user's app-data directory.

---

## Developer Setup

```bash
# 1. Clone
git clone https://github.com/yourname/lyrics-sync-desktop
cd lyrics-sync-desktop

# 2. Node dependencies
npm install

# 3. Python dependencies for development and tests (virtualenv recommended)
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
from `PATH`. A packaged Windows build uses the frozen default backend; only
development setup requires Python.

### Build installers

```bash
npm run dist        # current platform
npm run build:backend
npm run build:ai-pack  # optional; produce the AI pack and its SHA-256
npm run dist:win       # Windows NSIS (requires verified media binaries)
npm run dist:mac    # macOS DMG + zip (must run on macOS; needs Apple ID for notarization)
npm run dist:linux  # Linux AppImage
```

For Windows packaging, place audited `ffmpeg.exe`, `ffprobe.exe`, and `fpcalc.exe` builds in
`resources/windows-x64/bin`. Set `LYRICS_ACOUSTID_API_KEY` if distributing an
app-level key. To enable the optional AI-pack download, host
`build/ai-pack/lyrics-ai-pack-win-x64.zip` at an HTTPS release URL and set
`LYRICS_AI_PACK_URL` and `LYRICS_AI_PACK_SHA256` to the asset URL and exact
SHA-256 before running `npm run dist:win`. Release signing credentials should
be supplied only through the release environment. Output lands in `dist/`.

The AI archive contains the frozen worker; faster-whisper and Demucs download
their model weights on first transcription into the user-data model directory.
The installer and pack are large; measure the actual release artifacts before
publishing any download-size estimate.

The AI-pack build writes a `.sha256` file next to the ZIP. To exercise the
download, checksum, and extraction flow during Windows development without
hosting the ZIP, set `LYRICS_AI_PACK_TEST_FILE` to that local ZIP path and run
`npm start`:

```powershell
$env:LYRICS_AI_PACK_TEST_FILE = (Resolve-Path .\build\ai-pack\lyrics-ai-pack-win-x64.zip).Path
npm start
```

The app uses the adjacent `.sha256` file as the expected checksum, copies the
archive through the same verification and extraction flow, and installs it
under the development user's app-data directory. This override is ignored by
packaged builds. When `LYRICS_AI_PACK_URL` is unset, the staged packaged
manifest contains a clearly marked TODO URL and no checksum, so the AI-pack
download remains unavailable until release configuration is supplied.

Automatic application updates are not configured. They can be added later with
signed versioned releases and a secure update feed; update-signing credentials
must remain in the release environment.

#### Clean Windows release checklist

- Test in a fresh Windows x64 VM or standard user profile without Python,
  ffmpeg, fpcalc, or developer tools installed.
- Install and launch the per-user NSIS installer; verify tags, sidecars, and
  LRCLIB lookup work with no console or Python dependency.
- Test AcoustID with the release key, a user key, a missing key, and a
  rate-limited/failed request; confirm lookup falls through to tags and
  filename-based LRCLIB search.
- Test the optional pack prompt, download progress, failed download, checksum
  rejection, successful installation, and transcription.
- Confirm settings, lyrics cache, and AI model files are written only under
  `app.getPath('userData')`, including when the app is installed read-only.
- Test offline operation, network recovery, update installation, and uninstall
  behavior; review signing status and SmartScreen behavior for the published
  installer.

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

- **Windows includes a frozen default backend.** Development still requires
  Python; macOS and Linux packaged builds currently use the system Python.
- **Whisper models are downloaded on first use** from Hugging Face and cached
  under the app's user-data directory. The `small` model is ~244 MB; `medium`
  is ~769 MB.
- **Demucs** requires several GB of free disk space for temporary stems during
  processing. The temp directory is cleaned up after each run.
- **macOS Gatekeeper** will block an unsigned `.dmg`. Right-click → Open to
  bypass, or sign/notarize the build (see above).
