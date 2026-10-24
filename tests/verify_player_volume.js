const { app, BrowserWindow } = require('electron');

const audioPath = process.argv[2];
if (!audioPath) {
  console.error('Usage: electron tests/verify_player_volume.js <audio-file>');
  app.exit(2);
}

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require('../main.js');

function waitForMediaEvent(audio, eventName, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      audio.removeEventListener(eventName, onEvent);
      reject(new Error(`Timed out waiting for audio ${eventName}`));
    }, timeoutMs);
    function onEvent() {
      clearTimeout(timeout);
      resolve();
    }
    audio.addEventListener(eventName, onEvent, { once: true });
  });
}

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
        window.webContents.once('did-fail-load', (_event, _code, description) => {
          reject(new Error(description));
        });
      });
    }

    const audioState = await window.webContents.executeJavaScript(`(async () => {
      const audio = document.getElementById('audio-player');
      const mediaUrl = await window.lyricsApp.toFileUrl(${JSON.stringify(audioPath)});
      const loaded = new Promise((resolve, reject) => {
        audio.addEventListener('loadedmetadata', resolve, { once: true });
        audio.addEventListener('error', () => reject(new Error(
          audio.error ? 'Audio element error ' + audio.error.code : 'Audio failed to load'
        )), { once: true });
      });
      audio.disabled = false;
      audio.src = mediaUrl;
      audio.load();
      await loaded;
      renderLyrics([
        { time: 1, text: 'Player smoke test line one' },
        { time: 2, text: 'Player smoke test line two' },
        { time: 3, text: 'Player smoke test line three' }
      ]);
      document.body.classList.add('has-track');
      loadSyncOffset('player-volume-smoke-test');
      return {
        duration: audio.duration,
        readyState: audio.readyState,
        source: audio.currentSrc
      };
    })()`);

    const debuggerApi = window.webContents.debugger;
    debuggerApi.attach('1.3');
    const keyboardState = await window.webContents.executeJavaScript(`(() => {
      const range = document.getElementById('player-volume');
      const mute = document.getElementById('player-mute-btn');
      range.value = '0.34';
      range.dispatchEvent(new Event('input', { bubbles: true }));
      const initialVolume = audioPlayer.volume;
      const savedInitialVolume = Number(localStorage.getItem('lyrics-player-volume'));
      mute.click();
      const muted = audioPlayer.muted &&
        audioPlayer.volume === 0 &&
        mute.getAttribute('aria-label') === 'Unmute';
      const mutedIconVisible = !mute.querySelector('.volume-icon-muted').hidden;
      mute.click();
      const restoredVolume = audioPlayer.volume;
      const lowIconVisible = !mute.querySelector('.volume-icon-low').hidden;
      range.focus();
      return {
        initialVolume,
        savedInitialVolume,
        muted,
        mutedIconVisible,
        lowIconVisible,
        restoredVolume
      };
    })()`);
    await debuggerApi.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'ArrowDown',
      code: 'ArrowDown',
      windowsVirtualKeyCode: 40,
      nativeVirtualKeyCode: 40
    });
    await debuggerApi.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'ArrowDown',
      code: 'ArrowDown',
      windowsVirtualKeyCode: 40,
      nativeVirtualKeyCode: 40
    });
    const keyboardVolume = await window.webContents.executeJavaScript(`({
      volume: audioPlayer.volume,
      range: Number(document.getElementById('player-volume').value),
      saved: Number(localStorage.getItem('lyrics-player-volume'))
    })`);
    const layoutResults = [];
    for (const width of [320, 430, 480, 900]) {
      await debuggerApi.sendCommand('Emulation.setDeviceMetricsOverride', {
        width,
        height: 760,
        deviceScaleFactor: 1,
        mobile: false
      });
      layoutResults.push(await window.webContents.executeJavaScript(`(() => {
        const bounds = (element) => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width };
        };
        const player = document.getElementById('player-bar');
        const seek = document.getElementById('player-seek');
        const volume = document.getElementById('player-volume');
        const volumeControl = document.querySelector('.volume-control');
        const mute = document.getElementById('player-mute-btn');
        const sync = document.querySelector('.player-dock .sync-controls');
        const playerBounds = bounds(player);
        const seekBounds = bounds(seek);
        const volumeBounds = bounds(volume);
        const muteBounds = bounds(mute);
        const syncBounds = bounds(sync);
        mute.focus();
        const revealOpacity = getComputedStyle(volume).opacity;
        mute.blur();
        return {
          viewportWidth: innerWidth,
          player: playerBounds,
          seek: seekBounds,
          volume: volumeBounds,
          mute: muteBounds,
          sync: syncBounds,
          dockDirection: getComputedStyle(document.getElementById('player-dock')).flexDirection,
          volumeCollapsed: getComputedStyle(volume).position === 'absolute',
          volumeWidth: volumeBounds.width,
          volumeWidthToken: getComputedStyle(volume).width,
          volumeFill: getComputedStyle(volume).backgroundImage,
          volumeKnobOpacityOnFocus: getComputedStyle(volume, '::-webkit-slider-thumb').opacity,
          revealOpacity,
          noPillOverflow: player.scrollWidth <= player.clientWidth,
          seekAtLeast80px: seekBounds.width >= 80,
          seekInsidePill: seekBounds.left >= playerBounds.left && seekBounds.right <= playerBounds.right,
          volumeInsidePill: volumeBounds.left >= playerBounds.left && volumeBounds.right <= playerBounds.right,
          muteInsidePill: muteBounds.left >= playerBounds.left && muteBounds.right <= playerBounds.right,
          syncIsAbove: syncBounds.top < player.getBoundingClientRect().top
        };
      })()`));
    }

    await debuggerApi.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 900,
      height: 760,
      deviceScaleFactor: 1,
      mobile: false
    });
    const sliderBounds = await window.webContents.executeJavaScript(`(() => {
      const bounds = document.getElementById('player-volume').getBoundingClientRect();
      return { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height };
    })()`);
    const dragY = sliderBounds.top + sliderBounds.height / 2;
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: sliderBounds.left + sliderBounds.width * 0.2,
      y: dragY
    });
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: sliderBounds.left + sliderBounds.width * 0.2,
      y: dragY,
      button: 'left',
      buttons: 1,
      clickCount: 1
    });
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: sliderBounds.left + sliderBounds.width * 0.8,
      y: dragY,
      button: 'left',
      buttons: 1
    });
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: sliderBounds.left + sliderBounds.width * 0.8,
      y: dragY,
      button: 'left',
      clickCount: 1
    });
    const draggedVolume = await window.webContents.executeJavaScript(`({
      volume: audioPlayer.volume,
      range: Number(document.getElementById('player-volume').value),
      saved: Number(localStorage.getItem('lyrics-player-volume')),
      highIconVisible: !document.querySelector('.volume-icon-high').hidden
    })`);

    const syncState = await window.webContents.executeJavaScript(`(async () => {
      syncForwardBtn.click();
      const positive = syncOffsetSeconds;
      syncBackBtn.click();
      syncBackBtn.click();
      const negative = syncOffsetSeconds;
      syncResetBtn.click();
      updateActiveLine(0.86);
      const activeBeforeClick = lyricsList.children[0].classList.contains('active');
      const line = lyricsList.children[1];
      const play = new Promise((resolve) => audioPlayer.addEventListener('play', resolve, { once: true }));
      line.click();
      const seekTarget = audioPlayer.currentTime;
      await Promise.race([play, new Promise((_, reject) => setTimeout(() => reject(
        new Error('Clicking a lyric did not start playback')
      ), 5000))]);
      const clickedLineActive = line.classList.contains('active');
      audioPlayer.pause();
      return {
        positiveOffset: positive,
        negativeOffset: negative,
        resetOffset: syncOffsetSeconds,
        activeBeforeClick,
        clickSeekTarget: seekTarget,
        clickedLineActive
      };
    })()`);

    await debuggerApi.sendCommand('Emulation.clearDeviceMetricsOverride');
    debuggerApi.detach();
    await window.webContents.executeJavaScript(`(() => {
      document.getElementById('player-volume').value = '0.42';
      document.getElementById('player-volume').dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    const persistenceRestartState = await new Promise((resolve, reject) => {
      window.webContents.once('did-finish-load', async () => {
        try {
          resolve(await window.webContents.executeJavaScript(`({
            saved: Number(localStorage.getItem('lyrics-player-volume')),
            volume: audioPlayer.volume,
            range: Number(document.getElementById('player-volume').value)
          })`));
        } catch (error) {
          reject(error);
        }
      });
      window.webContents.reload();
    });
    console.log(JSON.stringify({ audio: audioState, player: keyboardState, keyboardVolume, persistenceRestart: persistenceRestartState, draggedVolume, layouts: layoutResults, sync: syncState }));

    const layoutPassed = layoutResults.length === 4 && layoutResults.every((layout) =>
      layout.noPillOverflow &&
      layout.seekAtLeast80px &&
      layout.seekInsidePill &&
      layout.volumeInsidePill &&
      layout.muteInsidePill &&
      layout.dockDirection === 'column' &&
      layout.syncIsAbove &&
      layout.volumeWidth >= 48 &&
      layout.volumeWidth <= 84 &&
      layout.volumeFill.startsWith('linear-gradient') &&
      (layout.viewportWidth !== 320 || layout.volumeCollapsed) &&
      (layout.viewportWidth !== 430 || !layout.volumeCollapsed) &&
      (layout.viewportWidth >= 380 || layout.revealOpacity === '1')
    );
    const volumePassed = Math.abs(keyboardState.initialVolume - 0.34) < 0.02 &&
      Math.abs(keyboardState.savedInitialVolume - keyboardState.initialVolume) < 0.01 &&
      keyboardState.muted &&
      keyboardState.mutedIconVisible &&
      keyboardState.lowIconVisible &&
      Math.abs(keyboardState.restoredVolume - keyboardState.initialVolume) < 0.01 &&
      keyboardVolume.volume < keyboardState.restoredVolume &&
      Math.abs(keyboardVolume.range - keyboardVolume.volume) < 0.02 &&
      Math.abs(keyboardVolume.saved - keyboardVolume.volume) < 0.02 &&
      Math.abs(persistenceRestartState.saved - 0.42) < 0.01 &&
      Math.abs(persistenceRestartState.volume - 0.42) < 0.01 &&
      Math.abs(persistenceRestartState.range - 0.42) < 0.01 &&
      draggedVolume.volume > 0.65 &&
      draggedVolume.highIconVisible &&
      Math.abs(draggedVolume.range - draggedVolume.volume) < 0.02 &&
      Math.abs(draggedVolume.saved - draggedVolume.volume) < 0.02;
    const syncPassed = syncState.positiveOffset === 0.1 &&
      syncState.negativeOffset === -0.1 &&
      syncState.resetOffset === 0 &&
      syncState.activeBeforeClick &&
      syncState.clickSeekTarget === 2 &&
      syncState.clickedLineActive;

    app.exit(audioState.duration > 0 && layoutPassed && volumePassed && syncPassed ? 0 : 1);
  } catch (error) {
    console.error(error.stack || error.message || String(error));
    app.exit(1);
  }
});
