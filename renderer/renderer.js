const dropZone = document.getElementById('drop-zone');
const dropOverlay = document.getElementById('drop-overlay');
const progressCard = document.getElementById('progress-card');
const progressStage = document.getElementById('progress-stage');
const progressMessage = document.getElementById('progress-message');
const progressBarFill = document.getElementById('progress-bar-fill');
const cancelBtn = document.getElementById('cancel-btn');

const statusEl = document.getElementById('status');
const statusText = document.getElementById('status-text');

const trackInfo = document.getElementById('track-info');
const trackTitle = document.getElementById('track-title');
const trackArtist = document.getElementById('track-artist');
const trackBadge = document.getElementById('track-badge');

const emptyState = document.getElementById('empty-state');
const lyricsPanel = document.getElementById('lyrics-panel');
const lyricsList = document.getElementById('lyrics-list');
const resumeScrollBtn = document.getElementById('resume-scroll-btn');

const syncBackBtn = document.getElementById('sync-back-btn');
const syncForwardBtn = document.getElementById('sync-forward-btn');
const syncResetBtn = document.getElementById('sync-reset-btn');
const syncOffsetValue = document.getElementById('sync-offset-value');

const audioPlayer = document.getElementById('audio-player');

const SYNC_EARLY_HIGHLIGHT_SECONDS = 0.15;
const SYNC_OFFSET_STEP_SECONDS = 0.1;
const SYNC_OFFSET_STORAGE_PREFIX = 'lyrics-sync-offset:';

let lyricLines = [];
let activeIndex = -1;
let isUserScrolling = false;
let userScrollTimeout = null;
let isProcessing = false;
let processingRequestId = 0;
let activeProcessingRequestId = 0;
let resultHandledRequestId = 0;
let terminalErrorRequestId = 0;
let activeAudioPath = '';
let activeFileName = '';
let syncOffsetSeconds = 0;
let activeTrackKey = '';
let playbackFrameId = null;
let resizeScrollTimeout = null;
let fileDragDepth = 0;

const SUPPORTED_EXTENSIONS = ['.mp3', '.wav', '.flac', '.m4a', '.ogg', '.aac', '.opus', '.wma'];

const STAGE_LABELS = {
  init: 'Analyzing audio…',
  fingerprint: 'Identifying song…',
  tags: 'Identifying song…',
  lrclib: 'Looking up synced lyrics…',
  lyrics: 'Looking up lyrics…',
  demucs: 'Separating vocals…',
  whisper: 'Transcribing…',
  cache: 'Loading cached lyrics…',
  warning: 'Notice',
};

function formatTimestamp(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function isSupportedAudio(filename) {
  if (!filename) return false;
  const lower = filename.toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function showStatus(message) {
  statusEl.hidden = !message;
  statusText.textContent = message || '';
}

function setProcessingState(processing, stageText = 'Analyzing audio…', messageText = 'Analyzing audio...') {
  isProcessing = processing;
  progressCard.hidden = !processing;
  dropZone.style.pointerEvents = processing ? 'none' : 'auto';
  dropZone.style.opacity = processing ? '0.6' : '1';

  if (processing) {
    progressBarFill.classList.add('indeterminate');
    progressBarFill.style.width = '';
    progressStage.textContent = stageText;
    progressMessage.textContent = messageText;
  }
}

function stopPlaybackSync() {
  if (playbackFrameId !== null) {
    cancelAnimationFrame(playbackFrameId);
    playbackFrameId = null;
  }
}

function updateActiveLine(currentTime) {
  const targetTime = currentTime + SYNC_EARLY_HIGHLIGHT_SECONDS - syncOffsetSeconds;
  let low = 0;
  let high = lyricLines.length;

  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (lyricLines[middle].baseTime <= targetTime) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  const next = low - 1;
  if (next === activeIndex) return;

  for (let i = 0; i < lyricLines.length; i += 1) {
    const item = lyricLines[i];
    if (i < next) {
      item.el.classList.add('played');
      item.el.classList.remove('active');
    } else if (i === next) {
      item.el.classList.remove('played');
      item.el.classList.toggle('active', Boolean(item.text));
    } else {
      item.el.classList.remove('played', 'active');
    }
  }

  if (next >= 0 && !isUserScrolling && lyricLines[next].text) {
    scrollActiveLine(lyricLines[next].el);
  }

  activeIndex = next;
}

function playbackSyncFrame() {
  if (audioPlayer.paused || audioPlayer.ended) {
    playbackFrameId = null;
    return;
  }

  updateActiveLine(audioPlayer.currentTime);
  playbackFrameId = requestAnimationFrame(playbackSyncFrame);
}

function startPlaybackSync() {
  if (playbackFrameId === null && !audioPlayer.paused && !audioPlayer.ended) {
    playbackFrameId = requestAnimationFrame(playbackSyncFrame);
  }
}

function renderLyrics(lines, { synced = true } = {}) {
  lyricsList.replaceChildren();
  lyricLines = [];
  activeIndex = -1;
  lyricsList.classList.toggle('unsynced', !synced);

  if (!Array.isArray(lines) || lines.length === 0) {
    lyricsPanel.hidden = true;
    emptyState.hidden = false;
    return;
  }

  emptyState.hidden = true;
  const displayLines = synced
    ? [...lines].sort((first, second) => first.time - second.time)
    : lines;
  const elements = displayLines.map((line, index) => {
    const li = document.createElement('li');
    const text = typeof line.text === 'string' ? line.text : '';
    li.textContent = text || '···';

    if (!text && synced) {
      li.classList.add('gap-line');
    } else if (synced) {
      li.title = `Seek to ${formatTimestamp(Math.max(0, line.time + syncOffsetSeconds))}`;
    }

    if (synced) {
      li.addEventListener('click', () => {
        audioPlayer.currentTime = Math.max(0, line.time + syncOffsetSeconds);
        audioPlayer.play().catch((error) => {
          showStatus(`Audio playback failed: ${error.message || error}`);
        });
        updateActiveLine(audioPlayer.currentTime);
        resumeAutoScroll();
      });
    }

    lyricsList.appendChild(li);
    return { baseTime: line.time, text, el: li, index };
  });
  if (synced) lyricLines = elements;

  isUserScrolling = false;
  resumeScrollBtn.hidden = true;
  lyricsPanel.hidden = false;
  if (synced) updateActiveLine(audioPlayer.currentTime);
}

function resetForNewFile() {
  stopPlaybackSync();
  clearTimeout(userScrollTimeout);
  userScrollTimeout = null;
  isProcessing = false;
  isUserScrolling = false;
  showStatus('');
  emptyState.hidden = true;
  progressCard.hidden = true;
  trackInfo.hidden = true;
  lyricsPanel.hidden = true;
  resumeScrollBtn.hidden = true;
  lyricsList.replaceChildren();
  lyricLines = [];
  activeIndex = -1;
  activeAudioPath = '';
  activeTrackKey = '';
  syncOffsetSeconds = 0;
  syncOffsetValue.textContent = '0 ms';
  document.body.classList.remove('has-track');
  dropZone.style.pointerEvents = 'auto';
  dropZone.style.opacity = '1';
  audioPlayer.pause();
  audioPlayer.removeAttribute('src');
  audioPlayer.disabled = true;
  audioPlayer.load();
}

function loadSyncOffset(trackKey) {
  activeTrackKey = trackKey;
  const stored = Number(localStorage.getItem(`${SYNC_OFFSET_STORAGE_PREFIX}${trackKey}`));
  syncOffsetSeconds = Number.isFinite(stored) ? stored : 0;
  updateSyncOffsetDisplay();
}

function updateSyncOffsetDisplay() {
  const milliseconds = Math.round(syncOffsetSeconds * 1000);
  syncOffsetValue.textContent = `${milliseconds > 0 ? '+' : ''}${milliseconds} ms`;

  for (const line of lyricLines) {
    line.el.title = `Seek to ${formatTimestamp(Math.max(0, line.baseTime + syncOffsetSeconds))}`;
  }
  updateActiveLine(audioPlayer.currentTime);
}

function adjustSyncOffset(deltaSeconds) {
  if (!activeTrackKey) return;
  syncOffsetSeconds = Math.round((syncOffsetSeconds + deltaSeconds) * 1000) / 1000;
  localStorage.setItem(`${SYNC_OFFSET_STORAGE_PREFIX}${activeTrackKey}`, String(syncOffsetSeconds));
  updateSyncOffsetDisplay();
}

async function finishSuccessfulResult(result, fileName, filePath, requestId) {
  if (requestId !== activeProcessingRequestId || resultHandledRequestId === requestId) return;
  resultHandledRequestId = requestId;
  setProcessingState(false);
  showStatus('');
  document.body.classList.add('has-track');

  trackTitle.textContent = result.title || fileName;
  trackArtist.textContent = result.artist || 'Unknown Artist';
  const sourceLabels = {
    embedded: 'Embedded lyrics',
    sidecar: 'Sidecar lyrics',
    lrclib: 'LRCLIB lyrics',
    extra: 'Extra source',
  };
  if (result.format === 'estimated' || result.source === 'plain_estimated') {
    const origin = sourceLabels[result.source];
    trackBadge.textContent = `Estimated timing${origin ? ` · ${origin}` : ''}`;
    trackBadge.className = 'badge estimated';
  } else if (result.source === 'embedded' || result.source === 'sidecar' || result.source === 'lrclib') {
    trackBadge.textContent = sourceLabels[result.source];
    trackBadge.className = 'badge matched';
  } else if (result.source === 'extra') {
    trackBadge.textContent = `Extra source${result.provider ? ` · ${result.provider}` : ''}`;
    trackBadge.className = 'badge matched';
  } else if (result.format === 'plain' || result.source === 'plain') {
    trackBadge.textContent = `Lyrics (not synced${result.provider ? ` · ${result.provider}` : ''})`;
    trackBadge.className = 'badge transcribed';
  } else if (result.source === 'whisper') {
    trackBadge.textContent = 'Transcribed (may be imperfect)';
    trackBadge.className = 'badge transcribed';
  } else if (result.source === 'syncedlyrics') {
    trackBadge.textContent = `Extra source${result.provider ? ` · ${result.provider}` : ''}`;
    trackBadge.className = 'badge matched';
  } else {
    trackBadge.textContent = 'Transcribed (may be imperfect)';
    trackBadge.className = 'badge transcribed';
  }
  trackInfo.hidden = false;

  loadSyncOffset(filePath);
  const lines = Array.isArray(result.lines) ? result.lines : [];
  emptyState.hidden = lines.length !== 0;
  renderLyrics(lines, { synced: result.format !== 'plain' && result.source !== 'plain' });

  try {
    const mediaUrl = await window.lyricsApp.toFileUrl(filePath);
    if (requestId !== activeProcessingRequestId) return;
    audioPlayer.src = mediaUrl;
    audioPlayer.disabled = false;
    audioPlayer.play().catch((error) => {
      showStatus(`Lyrics are ready, but audio playback failed: ${error.message || error}`);
    });
  } catch (error) {
    if (requestId === activeProcessingRequestId) {
      showStatus(`Lyrics are ready, but the audio file URL could not be created: ${error.message || error}`);
    }
  }
}

function finishTerminalError(requestId, message) {
  if (requestId !== activeProcessingRequestId ||
      resultHandledRequestId === requestId ||
      terminalErrorRequestId === requestId) return;

  terminalErrorRequestId = requestId;
  setProcessingState(false);
  lyricsPanel.hidden = true;
  emptyState.hidden = false;
  showStatus(message || 'Audio processing failed.');
}

window.lyricsApp.onProgress((event) => {
  if (event.requestId !== activeProcessingRequestId) return;

  if (event.type === 'result') {
    void finishSuccessfulResult(event, activeFileName, activeAudioPath, event.requestId);
    return;
  }
  if (event.type === 'error') {
    if (event.error === 'no_lyrics_detected') return;
    finishTerminalError(event.requestId, event.message || event.detail || event.error);
    return;
  }
  if (!isProcessing || resultHandledRequestId === event.requestId) return;

  const stageKey = (event.stage || '').toLowerCase();
  progressStage.textContent = STAGE_LABELS[stageKey] || 'Processing…';
  if (event.message) {
    progressMessage.textContent = event.message;
  }
  if (stageKey === 'warning') {
    showStatus(event.message || 'Audio processing reported a warning.');
  }
});

window.lyricsApp.onAiPackProgress((event) => {
  if (!isProcessing) return;
  progressBarFill.classList.remove('indeterminate');
  if (event.stage === 'download') {
    progressStage.textContent = 'Downloading AI pack…';
    const downloaded = (event.downloadedBytes / 1024 / 1024).toFixed(1);
    if (event.totalBytes > 0) {
      progressBarFill.style.width = `${Math.min(100, event.downloadedBytes / event.totalBytes * 100)}%`;
      progressMessage.textContent = `${downloaded} / ${(event.totalBytes / 1024 / 1024).toFixed(1)} MB`;
    } else {
      progressBarFill.style.width = '40%';
      progressMessage.textContent = `${downloaded} MB downloaded`;
    }
  } else if (event.stage === 'extract') {
    progressStage.textContent = 'Verifying AI pack…';
    progressMessage.textContent = 'Checking the SHA-256 checksum and unpacking files…';
    progressBarFill.style.width = '100%';
  } else if (event.stage === 'complete') {
    progressStage.textContent = 'Starting transcription…';
    progressMessage.textContent = 'AI pack installed. Retrying this audio file…';
    progressBarFill.style.width = '100%';
  }
});

function resumeAutoScroll() {
  isUserScrolling = false;
  resumeScrollBtn.hidden = true;
  if (activeIndex >= 0 && lyricLines[activeIndex]) {
    scrollActiveLine(lyricLines[activeIndex].el);
  }
}

function scrollActiveLine(lineElement, behavior) {
  const panelBounds = lyricsPanel.getBoundingClientRect();
  const lineTop = lineElement.getBoundingClientRect().top - panelBounds.top + lyricsPanel.scrollTop;
  lyricsPanel.scrollTo({
    top: lineTop - lyricsPanel.clientHeight * 0.35 + lineElement.offsetHeight * 0.5,
    behavior: behavior || (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth')
  });
}

function repositionActiveLine() {
  if (activeIndex >= 0 && lyricLines[activeIndex]) {
    scrollActiveLine(lyricLines[activeIndex].el, 'auto');
  }
}

function scheduleActiveLineReposition(delay = 120) {
  clearTimeout(resizeScrollTimeout);
  resizeScrollTimeout = setTimeout(repositionActiveLine, delay);
}

window.addEventListener('resize', () => scheduleActiveLineReposition(380));
window.visualViewport?.addEventListener('resize', () => scheduleActiveLineReposition(380));
document.querySelectorAll('.compact-row').forEach((row) => {
  row.addEventListener('transitionend', (event) => {
    if (event.propertyName === 'grid-template-rows') scheduleActiveLineReposition();
  });
});

function pauseAutoScrollTemporarily() {
  if (lyricLines.length === 0) return;
  isUserScrolling = true;
  resumeScrollBtn.hidden = false;
  clearTimeout(userScrollTimeout);
  userScrollTimeout = setTimeout(resumeAutoScroll, 4000);
}

lyricsPanel.addEventListener('wheel', pauseAutoScrollTemporarily, { passive: true });
lyricsPanel.addEventListener('touchmove', pauseAutoScrollTemporarily, { passive: true });
resumeScrollBtn.addEventListener('click', () => {
  clearTimeout(userScrollTimeout);
  resumeAutoScroll();
});

syncBackBtn.addEventListener('click', () => adjustSyncOffset(-SYNC_OFFSET_STEP_SECONDS));
syncForwardBtn.addEventListener('click', () => adjustSyncOffset(SYNC_OFFSET_STEP_SECONDS));
syncResetBtn.addEventListener('click', () => {
  if (!activeTrackKey) return;
  syncOffsetSeconds = 0;
  localStorage.setItem(`${SYNC_OFFSET_STORAGE_PREFIX}${activeTrackKey}`, '0');
  updateSyncOffsetDisplay();
});

async function handleAudioFile(file) {
  if (isProcessing) return;

  resetForNewFile();
  const requestId = ++processingRequestId;
  activeProcessingRequestId = requestId;
  resultHandledRequestId = 0;
  terminalErrorRequestId = 0;

  if (!isSupportedAudio(file.name)) {
    showStatus(`Unsupported audio file. Supported formats: ${SUPPORTED_EXTENSIONS.join(', ')}`);
    return;
  }

  const filePath = window.lyricsApp.getPathForFile(file);
  if (!filePath) {
    showStatus('Could not read file path. Please drop the file directly from Explorer or Finder.');
    return;
  }

  activeAudioPath = filePath;
  activeFileName = file.name;
  setProcessingState(true, 'Analyzing audio…', `Loading ${file.name}...`);

  try {
    let response = await window.lyricsApp.processAudio(filePath, requestId);
    if (requestId !== activeProcessingRequestId || resultHandledRequestId === requestId) return;
    if (response.code === 'no_lyrics_detected') {
      const packStatus = await window.lyricsApp.getAiPackStatus();
      const confirmed = packStatus.available &&
        !packStatus.installed &&
        typeof window.confirmAiPackDownload === 'function' &&
        await window.confirmAiPackDownload();
      if (confirmed) {
        response = await window.lyricsApp.installAiPack();
        if (response.ok) {
          setProcessingState(true, 'Starting transcription…', `Retrying ${file.name} with local AI...`);
          response = await window.lyricsApp.processAudio(filePath, requestId);
        }
      } else if (packStatus.available && !packStatus.installed) {
        response.error = 'No lyrics found. You can install the optional AI transcription pack later from Settings.';
      } else if (!packStatus.installed) {
        response.error = 'No lyrics found. Local AI transcription is not available in this release.';
      }
    }
    if (requestId !== activeProcessingRequestId || resultHandledRequestId === requestId) return;
    if (response.ok) {
      await finishSuccessfulResult(response.data, file.name, filePath, requestId);
    } else {
      finishTerminalError(requestId, response.error || response.detail);
    }
  } catch (error) {
    finishTerminalError(requestId, `Could not sync lyrics: ${error.message || error}`);
  }
}

cancelBtn.addEventListener('click', async () => {
  if (!isProcessing) return;
  const cancelledRequestId = activeProcessingRequestId;
  const invalidatedRequestId = ++processingRequestId;
  activeProcessingRequestId = invalidatedRequestId;
  setProcessingState(false);
  try {
    await window.lyricsApp.cancelPipeline(cancelledRequestId);
    if (invalidatedRequestId === activeProcessingRequestId) {
      showStatus('Processing cancelled.');
    }
  } catch (error) {
    if (invalidatedRequestId === activeProcessingRequestId) {
      showStatus(`Could not cancel processing: ${error.message || error}`);
    }
  }
});

function dragContainsFiles(event) {
  return Boolean(event.dataTransfer &&
    (Array.from(event.dataTransfer.types || []).includes('Files') || event.dataTransfer.files.length > 0));
}

function clearFileDragState() {
  fileDragDepth = 0;
  document.body.classList.remove('file-dragging');
  dropOverlay.setAttribute('aria-hidden', 'true');
}

document.addEventListener('dragenter', (event) => {
  event.preventDefault();
  if (!dragContainsFiles(event)) return;
  fileDragDepth += 1;
  if (!isProcessing) {
    document.body.classList.add('file-dragging');
    dropOverlay.setAttribute('aria-hidden', 'false');
  }
});

document.addEventListener('dragover', (event) => {
  event.preventDefault();
  if (event.dataTransfer && dragContainsFiles(event)) {
    event.dataTransfer.dropEffect = 'copy';
    if (!isProcessing) {
      document.body.classList.add('file-dragging');
      dropOverlay.setAttribute('aria-hidden', 'false');
    }
  }
});

document.addEventListener('dragleave', (event) => {
  event.preventDefault();
  if (!dragContainsFiles(event)) return;
  fileDragDepth = Math.max(0, fileDragDepth - 1);
  if (fileDragDepth === 0) clearFileDragState();
});

document.addEventListener('drop', (event) => {
  event.preventDefault();
  const file = event.dataTransfer && event.dataTransfer.files[0];
  clearFileDragState();
  if (!isProcessing && file) void handleAudioFile(file);
});

audioPlayer.addEventListener('play', startPlaybackSync);
audioPlayer.addEventListener('pause', stopPlaybackSync);
audioPlayer.addEventListener('ended', () => {
  stopPlaybackSync();
  updateActiveLine(audioPlayer.currentTime);
});
audioPlayer.addEventListener('seeked', () => {
  updateActiveLine(audioPlayer.currentTime);
  if (!isUserScrolling) resumeAutoScroll();
});
audioPlayer.addEventListener('error', () => {
  if (audioPlayer.disabled || !audioPlayer.currentSrc) return;
  showStatus('Error loading audio stream. The file may be corrupt or DRM-protected.');
});
