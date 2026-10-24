const audio = document.getElementById('audio-player');
const playButton = document.getElementById('player-play-btn');
const playIcon = playButton.querySelector('.play-icon');
const pauseIcon = playButton.querySelector('.pause-icon');
const currentTimeLabel = document.getElementById('player-current-time');
const durationLabel = document.getElementById('player-duration');
const seekControl = document.getElementById('player-seek');
const volumeControl = document.getElementById('player-volume');
const muteButton = document.getElementById('player-mute-btn');
const volumeIcons = {
  high: muteButton.querySelector('.volume-icon-high'),
  low: muteButton.querySelector('.volume-icon-low'),
  muted: muteButton.querySelector('.volume-icon-muted')
};
const VOLUME_STORAGE_KEY = 'lyrics-player-volume';
const LAST_NONZERO_VOLUME_STORAGE_KEY = 'lyrics-player-last-volume';
let lastNonZeroVolume = 1;

function readSavedVolume() {
  const storedVolume = localStorage.getItem(VOLUME_STORAGE_KEY);
  if (storedVolume === null) return 1;
  const saved = Number(storedVolume);
  if (!Number.isFinite(saved) || saved < 0 || saved > 1) return 1;
  return saved;
}

function readLastNonZeroVolume() {
  const saved = Number(localStorage.getItem(LAST_NONZERO_VOLUME_STORAGE_KEY));
  return Number.isFinite(saved) && saved > 0 && saved <= 1 ? saved : 1;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const minutes = Math.floor(seconds / 60);
  const wholeSeconds = Math.floor(seconds % 60);
  return `${minutes}:${wholeSeconds.toString().padStart(2, '0')}`;
}

function updatePlaybackDisplay() {
  const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
  const currentTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
  currentTimeLabel.textContent = formatTime(currentTime);
  durationLabel.textContent = formatTime(duration);

  const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
  seekControl.value = String(progress);
  seekControl.style.setProperty('--range-progress', `${progress}%`);
  updateVolumeDisplay();
  updatePlayButton();
}

function updateVolumeDisplay() {
  const level = audio.muted ? 0 : audio.volume;
  volumeControl.value = String(level);
  volumeControl.style.setProperty('--range-progress', `${level * 100}%`);

  const icon = audio.muted || level === 0 ? 'muted' : level <= 0.5 ? 'low' : 'high';
  for (const [name, element] of Object.entries(volumeIcons)) {
    element.hidden = name !== icon;
  }
  muteButton.setAttribute('aria-label', icon === 'muted' ? 'Unmute' : 'Mute');
  muteButton.title = icon === 'muted' ? 'Unmute' : 'Mute';
}

function setVolume(value, { persist = true } = {}) {
  const level = Math.max(0, Math.min(1, Number(value)));
  audio.volume = level;
  audio.muted = level === 0;
  if (level > 0) {
    lastNonZeroVolume = level;
    localStorage.setItem(LAST_NONZERO_VOLUME_STORAGE_KEY, String(level));
  }
  if (persist) localStorage.setItem(VOLUME_STORAGE_KEY, String(level));
  updateVolumeDisplay();
}

function updatePlayButton() {
  const isPlaying = !audio.paused && !audio.ended;
  playIcon.hidden = isPlaying;
  pauseIcon.hidden = !isPlaying;
  playButton.classList.toggle('is-playing', isPlaying);
  playButton.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
  playButton.title = isPlaying ? 'Pause' : 'Play';
}

playButton.addEventListener('click', () => {
  if (audio.paused) {
    audio.play().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      showStatus(`Audio playback failed: ${message}`);
    });
  } else {
    audio.pause();
  }
});

audio.addEventListener('play', updatePlayButton);
audio.addEventListener('pause', updatePlayButton);
audio.addEventListener('ended', updatePlayButton);
audio.addEventListener('loadedmetadata', () => {
  playButton.disabled = false;
  updatePlaybackDisplay();
});
audio.addEventListener('durationchange', updatePlaybackDisplay);
audio.addEventListener('timeupdate', updatePlaybackDisplay);
audio.addEventListener('seeked', updatePlaybackDisplay);
audio.addEventListener('volumechange', updateVolumeDisplay);
audio.addEventListener('emptied', () => {
  playButton.disabled = audio.disabled;
  muteButton.disabled = audio.disabled;
  volumeControl.disabled = audio.disabled;
  updatePlaybackDisplay();
  updatePlayButton();
});

seekControl.addEventListener('input', () => {
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
  audio.currentTime = (Number(seekControl.value) / 100) * audio.duration;
  seekControl.style.setProperty('--range-progress', `${seekControl.value}%`);
  updatePlayButton();
});

audio.addEventListener('seeking', updatePlayButton);

volumeControl.addEventListener('input', () => {
  setVolume(volumeControl.value);
});

muteButton.addEventListener('click', () => {
  if (audio.muted || audio.volume === 0) {
    setVolume(lastNonZeroVolume || 1);
  } else {
    lastNonZeroVolume = audio.volume;
    setVolume(0);
  }
});

audio.addEventListener('loadedmetadata', () => {
  playButton.disabled = false;
  muteButton.disabled = false;
  volumeControl.disabled = false;
});

playButton.disabled = audio.disabled;
muteButton.disabled = audio.disabled;
volumeControl.disabled = audio.disabled;
lastNonZeroVolume = readLastNonZeroVolume();
setVolume(readSavedVolume(), { persist: false });

let latestPointerTarget = null;
let pointerFrameId = null;

document.querySelectorAll('.glass').forEach((surface) => {
  surface.addEventListener('pointermove', (event) => {
    latestPointerTarget = { surface, x: event.clientX, y: event.clientY };
    if (pointerFrameId !== null) return;

    pointerFrameId = requestAnimationFrame(() => {
      pointerFrameId = null;
      if (!latestPointerTarget) return;
      const { surface: target, x, y } = latestPointerTarget;
      const bounds = target.getBoundingClientRect();
      target.style.setProperty('--mx', `${x - bounds.left}px`);
      target.style.setProperty('--my', `${y - bounds.top}px`);
    });
  }, { passive: true });
});

updatePlaybackDisplay();
updatePlayButton();
