const { app, BrowserWindow } = require('electron');

const audioPath = process.argv[2];
if (!audioPath) {
  console.error('Usage: electron tests/verify_play_button.js <audio-file>');
  app.exit(2);
}

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require('../main.js');

app.whenReady().then(async () => {
  const window = BrowserWindow.getAllWindows()[0];
  if (!window) {
    console.error('The application window was not created.');
    app.exit(1);
    return;
  }

  try {
    if (window.webContents.isLoadingMainFrame()) {
      await new Promise((resolve, reject) => {
        window.webContents.once('did-finish-load', resolve);
        window.webContents.once('did-fail-load', (_event, _code, description) => reject(new Error(description)));
      });
    }

    const debuggerApi = window.webContents.debugger;
    debuggerApi.attach('1.3');
    const plainLyricsDisplay = await window.webContents.executeJavaScript(`(() => {
      renderLyrics([
        { text: 'A plain lyric line' },
        { text: 'Another plain lyric line' }
      ], { synced: false });
      const items = Array.from(document.querySelectorAll('#lyrics-list li'));
      return {
        visible: !document.getElementById('lyrics-panel').hidden,
        text: items.map((item) => item.textContent),
        hasNoSeekTitles: items.every((item) => !item.title),
        listIsUnsynced: document.getElementById('lyrics-list').classList.contains('unsynced'),
        noPlaybackLineState: lyricLines.length === 0 && activeIndex === -1
      };
    })()`);
    const state = await window.webContents.executeJavaScript(`(async () => {
      const audio = document.getElementById('audio-player');
      const button = document.getElementById('player-play-btn');
      const seek = document.getElementById('player-seek');
      const playIcon = button.querySelector('.play-icon');
      const pauseIcon = button.querySelector('.pause-icon');
      const mediaUrl = await window.lyricsApp.toFileUrl(${JSON.stringify(audioPath)});
      const metadata = new Promise((resolve, reject) => {
        audio.addEventListener('loadedmetadata', resolve, { once: true });
        audio.addEventListener('error', () => reject(new Error('Audio metadata did not load')), { once: true });
      });
      audio.disabled = false;
      audio.src = mediaUrl;
      audio.load();
      await metadata;

      const progressState = () => {
        const playBounds = button.getBoundingClientRect();
        const currentTimeLabels = document.querySelectorAll('#player-current-time');
        const durationLabels = document.querySelectorAll('#player-duration');
        const timeLabels = Array.from(document.querySelectorAll('.player-time'));
        const overlapsPlayButton = timeLabels.some((label) => {
          const bounds = label.getBoundingClientRect();
          return bounds.left < playBounds.right &&
            bounds.right > playBounds.left &&
            bounds.top < playBounds.bottom &&
            bounds.bottom > playBounds.top;
        });
        return {
          progressPercent: Number.parseFloat(seek.style.getPropertyValue('--range-progress')),
          currentTimeLabelCount: currentTimeLabels.length,
          durationLabelCount: durationLabels.length,
          timeLabelCount: timeLabels.length,
          timeLabelOverlapsPlayButton: overlapsPlayButton
        };
      };

      const snapshot = () => {
        const buttonRect = button.getBoundingClientRect();
        const iconRect = button.querySelector('.playback-icon').getBoundingClientRect();
        const clippingAncestors = [];
        for (let element = button.parentElement; element; element = element.parentElement) {
          if (getComputedStyle(element).overflowX === 'hidden' ||
              getComputedStyle(element).overflowY === 'hidden') {
            const ancestorRect = element.getBoundingClientRect();
            if (buttonRect.left < ancestorRect.left ||
                buttonRect.right > ancestorRect.right ||
                buttonRect.top < ancestorRect.top ||
                buttonRect.bottom > ancestorRect.bottom) {
              clippingAncestors.push({
                ancestor: element.id || element.className || element.tagName,
                bounds: {
                  left: ancestorRect.left,
                  right: ancestorRect.right,
                  top: ancestorRect.top,
                  bottom: ancestorRect.bottom
                }
              });
            }
          }
        }
        return {
          paused: audio.paused,
          ended: audio.ended,
          currentTime: audio.currentTime,
          isPlayingClass: button.classList.contains('is-playing'),
          ariaLabel: button.getAttribute('aria-label'),
          title: button.title,
          playIconVisible: !playIcon.hidden,
          pauseIconVisible: !pauseIcon.hidden,
          button: { width: buttonRect.width, height: buttonRect.height },
          buttonBounds: {
            left: buttonRect.left,
            right: buttonRect.right,
            top: buttonRect.top,
            bottom: buttonRect.bottom
          },
          icon: { width: iconRect.width, height: iconRect.height },
          iconCentered: Math.abs((buttonRect.left + buttonRect.width / 2) -
            (iconRect.left + iconRect.width / 2)) < 0.5 &&
            Math.abs((buttonRect.top + buttonRect.height / 2) -
              (iconRect.top + iconRect.height / 2)) < 0.5,
          playerOutsideCollapseRows: !button.closest('.compact-row'),
          clippingAncestors
        };
      };

      const initial = { ...snapshot(), ...progressState() };
      seek.value = '50';
      seek.dispatchEvent(new Event('input', { bubbles: true }));
      const pausedAfterSeek = { ...snapshot(), ...progressState() };

      const started = new Promise((resolve) => audio.addEventListener('play', resolve, { once: true }));
      button.click();
      await started;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const playback = { ...snapshot(), ...progressState() };

      await new Promise((resolve) => setTimeout(resolve, 350));
      const beforeResizeTime = audio.currentTime;
      const playbackProgress = { ...snapshot(), ...progressState() };
      return { initial, pausedAfterSeek, playback, playbackProgress, beforeResizeTime, duration: audio.duration };
    })()`);

    const resizeMeasurements = [];
    for (const [width, height] of [[320, 240], [380, 700], [430, 700], [900, 700]]) {
      await debuggerApi.sendCommand('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false
      });
      await new Promise((resolve) => setTimeout(resolve, 120));
      resizeMeasurements.push(await window.webContents.executeJavaScript(`(() => {
        const button = document.getElementById('player-play-btn');
        const icon = button.querySelector('.playback-icon');
        const buttonRect = button.getBoundingClientRect();
        const iconRect = icon.getBoundingClientRect();
        const currentTimeLabel = document.getElementById('player-current-time');
        const currentTimeBounds = currentTimeLabel.getBoundingClientRect();
        return {
          viewport: { width: innerWidth, height: innerHeight },
          paused: audioPlayer.paused,
          isPlayingClass: button.classList.contains('is-playing'),
          ariaLabel: button.getAttribute('aria-label'),
          buttonSize: { width: buttonRect.width, height: buttonRect.height },
          iconSize: { width: iconRect.width, height: iconRect.height },
          iconCentered: Math.abs(buttonRect.left + buttonRect.width / 2 -
            iconRect.left - iconRect.width / 2) < 0.5 &&
            Math.abs(buttonRect.top + buttonRect.height / 2 -
              iconRect.top - iconRect.height / 2) < 0.5,
          outsideCollapseRows: !button.closest('.compact-row'),
          currentTimeLabelCount: document.querySelectorAll('#player-current-time').length,
          durationLabelCount: document.querySelectorAll('#player-duration').length,
          timeLabelOverlapsPlayButton: currentTimeBounds.left < buttonRect.right &&
            currentTimeBounds.right > buttonRect.left &&
            currentTimeBounds.top < buttonRect.bottom &&
            currentTimeBounds.bottom > buttonRect.top
        };
      })()`));
    }

    const pausedState = await window.webContents.executeJavaScript(`(async () => {
      const audio = document.getElementById('audio-player');
      const button = document.getElementById('player-play-btn');
      if (audio.ended) audio.currentTime = 0;
      if (audio.paused) await audio.play();
      const pausedEvent = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Audio did not pause from the play button')), 3000);
        audio.addEventListener('pause', () => {
          clearTimeout(timeout);
          resolve();
        }, { once: true });
      });
      button.click();
      await pausedEvent;
      return {
        paused: audio.paused,
        ended: audio.ended,
        isPlayingClass: button.classList.contains('is-playing'),
        ariaLabel: button.getAttribute('aria-label'),
        title: button.title,
        playIconVisible: !button.querySelector('.play-icon').hidden,
        pauseIconVisible: !button.querySelector('.pause-icon').hidden
      };
    })()`);

    const endedState = await window.webContents.executeJavaScript(`(() => {
      const audio = document.getElementById('audio-player');
      const button = document.getElementById('player-play-btn');
      audio.pause();
      Object.defineProperty(audio, 'ended', {
        configurable: true,
        get: () => true
      });
      audio.dispatchEvent(new Event('ended'));
      const state = {
        paused: audio.paused,
        ended: audio.ended,
        endedEventDispatched: true,
        isPlayingClass: button.classList.contains('is-playing'),
        ariaLabel: button.getAttribute('aria-label'),
        title: button.title,
        playIconVisible: !button.querySelector('.play-icon').hidden,
        pauseIconVisible: !button.querySelector('.pause-icon').hidden
      };
      delete audio.ended;
      audio.dispatchEvent(new Event('pause'));
      return state;
    })()`);
    const estimatedLyricsState = await window.webContents.executeJavaScript(`(async () => {
      const audio = document.getElementById('audio-player');
      const trackPath = ${JSON.stringify(audioPath)};
      localStorage.setItem('lyrics-sync-offset:' + trackPath, '0.25');
      activeProcessingRequestId = 9003;
      resultHandledRequestId = 0;
      const metadata = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Estimated-lyrics audio metadata did not load')), 3000);
        audio.addEventListener('loadedmetadata', () => {
          clearTimeout(timeout);
          resolve();
        }, { once: true });
      });
      const finished = finishSuccessfulResult({
        source: 'plain_estimated',
        format: 'estimated',
        provider: 'Genius',
        title: 'Estimated timing test',
        artist: 'Test artist',
        lines: [
          { time: 0, text: 'First line' },
          { time: 1.25, text: 'Second line' }
        ]
      }, 'estimated.mp3', trackPath, 9003);
      await Promise.all([metadata, finished]);
      audio.pause();
      const badge = document.getElementById('track-badge');
      const secondLine = document.querySelectorAll('#lyrics-list li')[1];
      secondLine.click();
      const result = {
        badgeText: badge.textContent,
        badgeClass: badge.className,
        sourceLineCount: document.querySelectorAll('#lyrics-list li').length,
        hasEstimatedTimestamp: secondLine.title === 'Seek to 0:01',
        currentTimeAfterClick: audio.currentTime,
        syncOffsetSeconds,
        lineIsActive: secondLine.classList.contains('active')
      };
      audio.pause();
      return result;
    })()`);

    await debuggerApi.sendCommand('Emulation.clearDeviceMetricsOverride');
    debuggerApi.detach();

    const stablePlayback = resizeMeasurements.every((item) =>
      !item.paused &&
      item.isPlayingClass &&
      item.ariaLabel === 'Pause' &&
      item.buttonSize.width === 38 &&
      item.buttonSize.height === 38 &&
      item.iconSize.width === 16 &&
      item.iconSize.height === 16 &&
      item.iconCentered &&
      item.outsideCollapseRows &&
      item.currentTimeLabelCount === 1 &&
      item.durationLabelCount === 1 &&
      !item.timeLabelOverlapsPlayButton
    );
    const expectedPlaybackProgress = state.playbackProgress.currentTime / state.duration * 100;
    const progressDisplayPassed = state.initial.currentTime === 0 &&
      state.initial.progressPercent === 0 &&
      state.initial.currentTimeLabelCount === 1 &&
      state.initial.durationLabelCount === 1 &&
      state.initial.timeLabelCount === 2 &&
      !state.initial.timeLabelOverlapsPlayButton &&
      Math.abs(state.pausedAfterSeek.progressPercent - 50) < 0.2 &&
      !state.playbackProgress.paused &&
      Math.abs(state.playbackProgress.progressPercent - expectedPlaybackProgress) < 1.5;
    const passed =
      state.initial.paused &&
      !state.initial.isPlayingClass &&
      state.initial.ariaLabel === 'Play' &&
      state.initial.playIconVisible &&
      !state.initial.pauseIconVisible &&
      state.initial.button.width === 38 &&
      state.initial.button.height === 38 &&
      state.initial.icon.width === 16 &&
      state.initial.icon.height === 16 &&
      state.initial.iconCentered &&
      state.initial.playerOutsideCollapseRows &&
      state.initial.clippingAncestors.length === 0 &&
      plainLyricsDisplay.visible &&
      plainLyricsDisplay.text.join('|') === 'A plain lyric line|Another plain lyric line' &&
      plainLyricsDisplay.hasNoSeekTitles &&
      plainLyricsDisplay.listIsUnsynced &&
      plainLyricsDisplay.noPlaybackLineState &&
      state.pausedAfterSeek.paused &&
      !state.pausedAfterSeek.isPlayingClass &&
      state.pausedAfterSeek.ariaLabel === 'Play' &&
      state.pausedAfterSeek.playIconVisible &&
      state.playback.isPlayingClass &&
      state.playback.ariaLabel === 'Pause' &&
      !state.playback.playIconVisible &&
      state.playback.pauseIconVisible &&
      stablePlayback &&
      progressDisplayPassed &&
      pausedState.paused &&
      !pausedState.isPlayingClass &&
      pausedState.ariaLabel === 'Play' &&
      pausedState.title === 'Play' &&
      pausedState.playIconVisible &&
      !pausedState.pauseIconVisible &&
      endedState.ended &&
      endedState.endedEventDispatched &&
      endedState.paused &&
      !endedState.isPlayingClass &&
      endedState.ariaLabel === 'Play' &&
      endedState.title === 'Play' &&
      endedState.playIconVisible &&
      !endedState.pauseIconVisible &&
      estimatedLyricsState.badgeText === 'Estimated timing' &&
      estimatedLyricsState.badgeClass.includes('estimated') &&
      estimatedLyricsState.sourceLineCount === 2 &&
      estimatedLyricsState.hasEstimatedTimestamp &&
      Math.abs(estimatedLyricsState.currentTimeAfterClick - 1.5) < 0.1 &&
      estimatedLyricsState.syncOffsetSeconds === 0.25 &&
      estimatedLyricsState.lineIsActive;

    console.log(JSON.stringify({
      audioDuration: state.duration,
      plainLyricsDisplay,
      initial: state.initial,
      pausedAfterSeek: state.pausedAfterSeek,
      playback: state.playback,
      playbackProgress: state.playbackProgress,
      playbackAdvancedBeforeResize: state.beforeResizeTime > 0,
      resizeMeasurements,
      progressDisplayPassed,
      estimatedLyricsState,
      pausedState,
      endedState,
      passed
    }, null, 2));
    app.exit(passed ? 0 : 1);
  } catch (error) {
    console.error(error.stack || error.message || String(error));
    app.exit(1);
  }
});
