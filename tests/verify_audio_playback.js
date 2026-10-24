const { app, BrowserWindow } = require('electron');

const audioPath = process.argv[2];
const pipelineAudioPath = process.argv[3] || audioPath;
if (!audioPath || !pipelineAudioPath) {
  console.error('Usage: electron tests/verify_audio_playback.js <audio-file> [pipeline-audio-file]');
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
        window.webContents.once('did-fail-load', (_event, _code, description) => {
          reject(new Error(description));
        });
      });
    }
    await window.webContents.executeJavaScript('activeProcessingRequestId = 9000; isProcessing = true');
    window.webContents.send('pipeline-progress', {
      type: 'progress',
      stage: 'warning',
      requestId: 9000,
      message: 'Renderer warning smoke test'
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const warningState = await window.webContents.executeJavaScript(`(() => {
      const status = document.getElementById('status');
      return {
        warningVisible: !status.hidden,
        warningText: document.getElementById('status-text').textContent,
        statusBackdropFilter: getComputedStyle(status).backdropFilter
      };
    })()`);
    const resetState = await window.webContents.executeJavaScript(`(() => {
      showStatus('old error');
      progressCard.hidden = false;
      emptyState.hidden = false;
      trackInfo.hidden = false;
      lyricsPanel.hidden = false;
      lyricsList.textContent = 'old lyrics';
      resetForNewFile();
      return {
        statusHidden: document.getElementById('status').hidden,
        progressHidden: progressCard.hidden,
        emptyHidden: emptyState.hidden,
        trackHidden: trackInfo.hidden,
        lyricsHidden: lyricsPanel.hidden,
        oldLyricsCleared: lyricsList.childNodes.length === 0,
        playerVisible: !document.getElementById('player-bar').hidden
      };
    })()`);
    await window.webContents.executeJavaScript(`(() => {
      const input = document.createElement('input');
      input.id = 'drop-smoke-file';
      input.type = 'file';
      input.hidden = true;
      document.body.appendChild(input);
    })()`);
    const debuggerApi = window.webContents.debugger;
    debuggerApi.attach('1.3');
    const { root } = await debuggerApi.sendCommand('DOM.getDocument');
    const { nodeId } = await debuggerApi.sendCommand('DOM.querySelector', {
      nodeId: root.nodeId,
      selector: '#drop-smoke-file'
    });
    await debuggerApi.sendCommand('DOM.setFileInputFiles', {
      nodeId,
      files: [pipelineAudioPath]
    });
    const droppedFileName = await window.webContents.executeJavaScript(`(() => {
      const input = document.getElementById('drop-smoke-file');
      const transfer = new DataTransfer();
      transfer.items.add(input.files[0]);
      dropZone.dispatchEvent(new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer
      }));
      return input.files[0].name;
    })()`);

    let dropCompletion = null;
    for (let attempt = 0; attempt < 1200; attempt += 1) {
      dropCompletion = await window.webContents.executeJavaScript(`(() => ({
        isProcessing,
        source: trackBadge.textContent,
        fileName: activeFileName,
        lineCount: lyricLines.length,
        nonEmptyLineCount: lyricLines.filter((line) => line.text.trim()).length,
        lyricsPanelVisible: !lyricsPanel.hidden,
        emptyStateVisible: !emptyState.hidden,
        errorHidden: statusEl.hidden,
        progressHidden: progressCard.hidden,
        resultEventHandled: resultHandledRequestId === activeProcessingRequestId,
        audioSource: audioPlayer.currentSrc
      }))()`);
      if (!dropCompletion.isProcessing && dropCompletion.resultEventHandled) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    debuggerApi.detach();
    const pipelineState = {
      ...dropCompletion,
      ok: droppedFileName === require('path').basename(pipelineAudioPath),
      droppedFileName
    };
    window.webContents.send('pipeline-progress', {
      type: 'error',
      requestId: 9001,
      message: 'stale terminal error'
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const staleEventState = await window.webContents.executeJavaScript(`({
      statusHidden: document.getElementById('status').hidden,
      emptyStateVisible: !emptyState.hidden,
      lyricsVisible: !lyricsPanel.hidden
    })`);
    const syncState = await window.webContents.executeJavaScript(`(async () => {
      if (audioPlayer.readyState < 1) {
        await new Promise((resolve, reject) => {
          audioPlayer.addEventListener('loadedmetadata', resolve, { once: true });
          audioPlayer.addEventListener('error', () => reject(new Error('Audio metadata did not load')), { once: true });
        });
      }
      loadSyncOffset(${JSON.stringify(pipelineAudioPath)});
      syncForwardBtn.click();
      const positiveOffset = localStorage.getItem(
        SYNC_OFFSET_STORAGE_PREFIX + ${JSON.stringify(pipelineAudioPath)}
      );
      syncBackBtn.click();
      syncBackBtn.click();
      const persistedOffset = localStorage.getItem(
        SYNC_OFFSET_STORAGE_PREFIX + ${JSON.stringify(pipelineAudioPath)}
      );
      loadSyncOffset(${JSON.stringify(pipelineAudioPath)});
      const restoredOffset = syncOffsetSeconds;
      syncResetBtn.click();
      renderLyrics(Array.from({ length: 24 }, (_, index) => ({
        time: index + 1,
        text: 'Sync test line ' + (index + 1)
      })));
      updateActiveLine(0.86);
      const earlyHighlight = lyricsList.children[0].classList.contains('active');
      updateActiveLine(1.86);
      const highlightAdvanced = lyricsList.children[1].classList.contains('active') &&
        lyricsList.children[0].classList.contains('played');
      updateActiveLine(8.86);
      const seekLine = lyricsList.children[3];
      audioPlayer.pause();
      const linePlaybackStarted = new Promise((resolve) => {
        audioPlayer.addEventListener('play', resolve, { once: true });
      });
      seekLine.click();
      const clickToSeekTime = audioPlayer.currentTime;
      const clickToSeekActive = seekLine.classList.contains('active');
      await linePlaybackStarted;
      audioPlayer.pause();
      scrollActiveLine(seekLine);
      await new Promise((resolve) => setTimeout(resolve, 1300));
      const panel = document.getElementById('lyrics-panel');
      const lineRect = seekLine.getBoundingClientRect();
      const lineTopRatio = (lineRect.top + lineRect.height * 0.5 - panel.getBoundingClientRect().top) /
        panel.clientHeight;
      const activeLine = lyricsList.querySelector('li.active');
      const activeLineRect = activeLine?.getBoundingClientRect();
      const activeLineTopRatio = activeLineRect
        ? (activeLineRect.top + activeLineRect.height * 0.5 - panel.getBoundingClientRect().top) / panel.clientHeight
        : null;
      return {
        positiveOffset,
        persistedOffset,
        restoredOffset,
        resetOffset: syncOffsetSeconds,
        earlyHighlight,
        highlightAdvanced,
        clickToSeekTime,
        clickToSeekActive,
        lineTopRatio,
        activeLineTopRatio
      };
    })()`);
    const playerControlState = await window.webContents.executeJavaScript(`(async () => {
      const audio = document.getElementById('audio-player');
      const mediaUrl = await window.lyricsApp.toFileUrl(${JSON.stringify(audioPath)});
      const metadataLoaded = new Promise((resolve, reject) => {
        audio.addEventListener('loadedmetadata', resolve, { once: true });
        audio.addEventListener('error', () => reject(new Error('Audio metadata did not load')), { once: true });
      });
      audio.src = mediaUrl;
      audio.load();
      await metadataLoaded;
      const seekControl = document.getElementById('player-seek');
      const volumeControl = document.getElementById('player-volume');
      const playButton = document.getElementById('player-play-btn');
      const muteButton = document.getElementById('player-mute-btn');
      const seeked = new Promise((resolve) => audio.addEventListener('seeked', resolve, { once: true }));
      seekControl.value = '50';
      seekControl.dispatchEvent(new Event('input', { bubbles: true }));
      await seeked;
      const seekRatio = audio.currentTime / audio.duration;
      volumeControl.value = '0.35';
      volumeControl.dispatchEvent(new Event('input', { bubbles: true }));
      const volumeLevel = audio.volume;
      muteButton.click();
      const muted = audio.muted && audio.volume === 0 &&
        muteButton.getAttribute('aria-label') === 'Unmute';
      muteButton.click();
      const restoredVolume = audio.volume;
      volumeControl.focus();
      const beforeArrowKey = audio.volume;
      const playing = new Promise((resolve) => audio.addEventListener('play', resolve, { once: true }));
      playButton.click();
      await playing;
      const playState = playButton.getAttribute('aria-label');
      const playbackFrameWasRunning = playbackFrameId !== null;
      const paused = new Promise((resolve) => audio.addEventListener('pause', resolve, { once: true }));
      playButton.click();
      await paused;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        seekRatio,
        volumeLevel,
        muted,
        restoredVolume,
        beforeArrowKey,
        playState,
        playbackFrameWasRunning,
        playbackFrameStopped: playbackFrameId === null,
        pausedAfterToggle: audio.paused,
        playButtonEnabled: !playButton.disabled,
        currentSrc: audio.currentSrc,
        duration: audio.duration,
        readyState: audio.readyState,
        audioError: audio.error ? audio.error.code : null,
        currentTimeText: document.getElementById('player-current-time').textContent,
        durationText: document.getElementById('player-duration').textContent
      };
    })()`);
    const layoutDebugger = window.webContents.debugger;
    layoutDebugger.attach('1.3');
    await layoutDebugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'ArrowDown',
      code: 'ArrowDown',
      windowsVirtualKeyCode: 40,
      nativeVirtualKeyCode: 40
    });
    await layoutDebugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'ArrowDown',
      code: 'ArrowDown',
      windowsVirtualKeyCode: 40,
      nativeVirtualKeyCode: 40
    });
    const keyboardVolume = await window.webContents.executeJavaScript('audio.volume');
    const keyboardSavedVolume = await window.webContents.executeJavaScript(
      'Number(localStorage.getItem("lyrics-player-volume"))'
    );
    await window.webContents.executeJavaScript(`(() => {
      const range = document.getElementById('player-volume');
      range.value = '0.35';
      range.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    const viewportLayouts = [];
    for (const width of [320, 430, 480, 900]) {
      await layoutDebugger.sendCommand('Emulation.setDeviceMetricsOverride', {
        width,
        height: 760,
        deviceScaleFactor: 1,
        mobile: false
      });
      viewportLayouts.push(await window.webContents.executeJavaScript(`(() => {
        const rect = (element) => {
          const bounds = element.getBoundingClientRect();
          return {
            left: bounds.left,
            right: bounds.right,
            width: bounds.width
          };
        };
        const player = document.getElementById('player-bar');
        const seek = document.getElementById('player-seek');
        const volume = document.getElementById('player-volume');
        const volumeControl = document.querySelector('.volume-control');
        const mute = document.getElementById('player-mute-btn');
        const sync = document.querySelector('.player-dock .sync-controls');
        const playerRect = rect(player);
        const seekRect = rect(seek);
        const volumeRect = rect(volume);
        const muteRect = rect(mute);
        const syncRect = rect(sync);
        mute.focus();
        const volumeOpacityOnFocus = getComputedStyle(volume).opacity;
        mute.blur();
        return {
          viewportWidth: innerWidth,
          player: playerRect,
          seek: seekRect,
          volume: volumeRect,
          mute: muteRect,
          sync: syncRect,
          dockDirection: getComputedStyle(document.getElementById('player-dock')).flexDirection,
          volumeOpacity: getComputedStyle(volume).opacity,
          volumeOpacityOnFocus,
          volumeThumbOpacityOnFocus: getComputedStyle(volume, '::-webkit-slider-thumb').opacity,
          volumeCollapsed: getComputedStyle(volume).position === 'absolute',
          volumeFilledTrack: getComputedStyle(volume).backgroundImage,
          pillHasNoHorizontalOverflow: player.scrollWidth <= player.clientWidth,
          seekAtLeast80px: seekRect.width >= 80,
          seekWithinPill: seekRect.left >= playerRect.left && seekRect.right <= playerRect.right,
          volumeWithinPill: volumeRect.left >= playerRect.left && volumeRect.right <= playerRect.right,
          muteWithinPill: muteRect.left >= playerRect.left && muteRect.right <= playerRect.right,
          syncStackedAbove: syncRect.top < playerRect.top
        };
      })()`));
    }
    const volumeBounds = await window.webContents.executeJavaScript(`(() => {
        const bounds = document.getElementById('player-volume').getBoundingClientRect();
        return { left: bounds.left, right: bounds.right, top: bounds.top, width: bounds.width, height: bounds.height };
    })()`);
    await layoutDebugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: volumeBounds.left + volumeBounds.width * 0.25,
        y: volumeBounds.top + volumeBounds.height / 2
    });
    await layoutDebugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: volumeBounds.left + volumeBounds.width * 0.25,
        y: volumeBounds.top + volumeBounds.height / 2,
        button: 'left',
        buttons: 1,
        clickCount: 1
    });
    await layoutDebugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: volumeBounds.left + volumeBounds.width * 0.8,
        y: volumeBounds.top + volumeBounds.height / 2,
        button: 'left',
        buttons: 1
    });
    await layoutDebugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: volumeBounds.left + volumeBounds.width * 0.8,
        y: volumeBounds.top + volumeBounds.height / 2,
        button: 'left',
        clickCount: 1
    });
    const draggedVolume = await window.webContents.executeJavaScript(`({
        volume: audioPlayer.volume,
        rangeValue: Number(document.getElementById('player-volume').value),
        savedValue: Number(localStorage.getItem('lyrics-player-volume'))
    })`);
    await layoutDebugger.sendCommand('Emulation.clearDeviceMetricsOverride');
    layoutDebugger.detach();
    await window.webContents.executeJavaScript(`(() => {
        const range = document.getElementById('player-volume');
        range.value = '0.35';
        range.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    const narrowVolumeHover = await window.webContents.executeJavaScript(`(() => {
        const volume = document.getElementById('player-volume');
        const mute = document.getElementById('player-mute-btn');
      mute.focus();
      const focusOpacity = getComputedStyle(volume).opacity;
      mute.blur();
      return { focusOpacity };
    })()`);
    const blurState = await window.webContents.executeJavaScript(`(() => {
      const list = document.createElement('ol');
      list.className = 'lyrics-list';
      list.style.position = 'fixed';
      list.style.left = '-10000px';
      for (let index = 0; index < 10; index += 1) {
        const line = document.createElement('li');
        line.textContent = 'Blur test line';
        if (index === 1) line.classList.add('active');
        list.appendChild(line);
      }
      document.body.appendChild(list);
      const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
      const nearbyBlur = getComputedStyle(list.children[2]).filter;
      const maximumBlur = getComputedStyle(list.children[7]).filter;
      const distantBlur = getComputedStyle(list.children[8]).filter;
      list.remove();
      return { reducedMotion, nearbyBlur, maximumBlur, distantBlur };
    })()`);
    const motionDebugger = window.webContents.debugger;
    motionDebugger.attach('1.3');
    await motionDebugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    });
    const reducedMotionState = await window.webContents.executeJavaScript(`(() => {
      const line = document.querySelector('.lyrics-list li');
      return {
        preferenceActive: matchMedia('(prefers-reduced-motion: reduce)').matches,
        lyricFilter: getComputedStyle(line).filter,
        lyricTransition: getComputedStyle(line).transitionProperty,
        lyricAnimation: getComputedStyle(line).animationName,
        blobAnimation: getComputedStyle(document.body, '::before').animationName,
        progressAnimation: getComputedStyle(document.getElementById('progress-card')).animationName
      };
    })()`);
    await motionDebugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }]
    });
    motionDebugger.detach();
    const rendererState = await window.webContents.executeJavaScript(`(async () => {
      const panel = document.getElementById('lyrics-panel');
      panel.hidden = false;
      const bodyOverflowY = getComputedStyle(document.body).overflowY;
      const panelOverflowY = getComputedStyle(panel).overflowY;
      const glassBlurSurfaceCount = Array.from(document.querySelectorAll('.glass'))
        .filter((surface) => getComputedStyle(surface).backdropFilter !== 'none').length;
      const player = document.getElementById('player-bar');
      const playerRect = player.getBoundingClientRect();
      player.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true,
        clientX: playerRect.left + playerRect.width * 0.7,
        clientY: playerRect.top + playerRect.height * 0.5
      }));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const playerBottom = player.getBoundingClientRect().bottom;
      const pageHeightBefore = document.scrollingElement.scrollHeight;
      panel.scrollTop = panel.scrollHeight;
      const panelScrollTop = panel.scrollTop;
      return {
        bodyOverflowY,
        panelOverflowY,
        glassBlurSurfaceCount,
        pageHeightBefore,
        pageClientHeight: document.scrollingElement.clientHeight,
        panelScrollTop,
        playerVisible: !player.hidden && playerBottom <= window.innerHeight,
        dropZoneCompact: document.body.classList.contains('has-track'),
        playerGlintX: player.style.getPropertyValue('--mx'),
        playerDropMinHeight: getComputedStyle(document.getElementById('drop-zone')).minHeight,
        lyricFontSize: getComputedStyle(document.querySelector('.lyrics-list li')).fontSize,
        lyricPanelBackground: getComputedStyle(panel).backgroundColor,
        lyricPanelBorderWidth: getComputedStyle(panel).borderWidth
      };
    })()`);
    const contrastState = await window.webContents.executeJavaScript(`(() => {
      const parseColor = (value) => {
        const values = value.match(/[\\d.]+/g).map(Number);
        return values.length === 4
          ? { rgb: values.slice(0, 3), alpha: values[3] }
          : { rgb: values.slice(0, 3), alpha: 1 };
      };
      const luminance = (rgb) => {
        const linear = rgb.map((channel) => {
          const value = channel / 255;
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        });
        return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
      };
      const contrast = (first, second) => {
        const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
        return (values[0] + 0.05) / (values[1] + 0.05);
      };
      const composite = (foreground, background, alpha) =>
        foreground.map((channel, index) => channel * alpha + background[index] * (1 - alpha));
      const rootStyle = getComputedStyle(document.documentElement);
      const bodyColor = parseColor(getComputedStyle(document.body).backgroundColor).rgb;
      const blobOpacity = Number(rootStyle.getPropertyValue('--blob-opacity'));
      const blobs = ['--blob-indigo', '--blob-magenta', '--blob-teal', '--blob-amber']
        .map((name) => parseColor(rootStyle.getPropertyValue(name)));
      const lineItems = Array.from(document.querySelectorAll('.lyrics-list li'));
      const currentActiveIndex = lineItems.findIndex((line) => line.classList.contains('active'));
      const farLine = lineItems[Math.min(lineItems.length - 1, currentActiveIndex + 7)];
      const lineColor = parseColor(getComputedStyle(farLine).color).rgb;
      const inactiveOpacity = Number(getComputedStyle(farLine).opacity);
      const nearOpacity = Number(rootStyle.getPropertyValue('--lyric-near-opacity'));
      const timeColor = parseColor(getComputedStyle(document.getElementById('player-current-time')).color).rgb;
      const hintColor = parseColor(getComputedStyle(document.querySelector('.drop-zone-hint')).color).rgb;
      let minimumLyricContrast = Infinity;
      let minimumNearLyricContrast = Infinity;
      let minimumTimeContrast = Infinity;
      let minimumHintContrast = Infinity;
      for (let mask = 0; mask < 16; mask += 1) {
        let background = bodyColor;
        blobs.forEach((blob, index) => {
          if (mask & (1 << index)) {
            background = composite(blob.rgb, background, blob.alpha * blobOpacity);
          }
        });
        minimumLyricContrast = Math.min(
          minimumLyricContrast,
          contrast(composite(lineColor, background, inactiveOpacity), background)
        );
        minimumNearLyricContrast = Math.min(
          minimumNearLyricContrast,
          contrast(composite(lineColor, background, nearOpacity), background)
        );
        minimumTimeContrast = Math.min(minimumTimeContrast, contrast(timeColor, background));
        minimumHintContrast = Math.min(minimumHintContrast, contrast(hintColor, background));
      }
      return {
        minimumLyricContrast,
        minimumNearLyricContrast,
        minimumTimeContrast,
        minimumHintContrast,
        inactiveOpacity,
        nearOpacity,
        blobOpacity
      };
    })()`);
    const terminalState = await window.webContents.executeJavaScript(`(() => {
      resetForNewFile();
      activeProcessingRequestId = 9002;
      resultHandledRequestId = 0;
      terminalErrorRequestId = 0;
      isProcessing = true;
      progressCard.hidden = false;
      showStatus('old warning');
      finishSuccessfulResult({source:'whisper', lines:[]}, 'empty.mp3', 'empty.mp3', 9002);
      const zeroLines = {
        emptyVisible: !emptyState.hidden,
        statusHidden: document.getElementById('status').hidden,
        progressHidden: progressCard.hidden
      };
      resetForNewFile();
      activeProcessingRequestId = 9003;
      resultHandledRequestId = 0;
      terminalErrorRequestId = 0;
      isProcessing = true;
      progressCard.hidden = false;
      finishTerminalError(9003, 'terminal failure');
      return {
        zeroLines,
        terminalErrorShowsEmpty: !emptyState.hidden,
        terminalErrorShowsBanner: !document.getElementById('status').hidden,
        terminalErrorHidesProgress: progressCard.hidden
      };
    })()`);
    console.log(JSON.stringify({ warning: warningState, reset: resetState, staleEvent: staleEventState, sync: syncState, playerControls: playerControlState, keyboardVolume, keyboardSavedVolume, draggedVolume, viewportLayouts, narrowVolumeHover, blur: blurState, reducedMotion: reducedMotionState, contrast: contrastState, renderer: rendererState, pipeline: pipelineState, terminal: terminalState }));
    const rendererPassed = warningState.warningVisible &&
      warningState.warningText === 'Renderer warning smoke test' &&
      warningState.statusBackdropFilter === 'none' &&
      resetState.statusHidden &&
      resetState.progressHidden &&
      resetState.emptyHidden &&
      resetState.trackHidden &&
      resetState.lyricsHidden &&
      resetState.oldLyricsCleared &&
      resetState.playerVisible &&
      staleEventState.statusHidden &&
      !staleEventState.emptyStateVisible &&
      staleEventState.lyricsVisible &&
      rendererState.bodyOverflowY === 'hidden' &&
      rendererState.panelOverflowY === 'auto' &&
      rendererState.glassBlurSurfaceCount <= 5 &&
      rendererState.pageHeightBefore === rendererState.pageClientHeight &&
      rendererState.panelScrollTop > 0 &&
      rendererState.playerVisible &&
      rendererState.dropZoneCompact &&
      rendererState.playerGlintX !== '' &&
      rendererState.playerDropMinHeight === '38px' &&
      Number.parseFloat(rendererState.lyricFontSize) >= 28 &&
      rendererState.lyricPanelBackground === 'rgba(0, 0, 0, 0)' &&
      rendererState.lyricPanelBorderWidth === '0px';
    const lyricsPassed = pipelineState.ok &&
      pipelineState.lineCount > 0 &&
      pipelineState.nonEmptyLineCount > 0 &&
      pipelineState.lyricsPanelVisible &&
      !pipelineState.emptyStateVisible &&
      pipelineState.errorHidden &&
      pipelineState.progressHidden &&
      pipelineState.resultEventHandled &&
      syncState.positiveOffset === '0.1' &&
      syncState.persistedOffset === '-0.1' &&
      syncState.restoredOffset === -0.1 &&
      syncState.resetOffset === 0 &&
      syncState.earlyHighlight &&
      syncState.highlightAdvanced &&
      syncState.clickToSeekActive &&
      syncState.clickToSeekTime >= 3.9 &&
      syncState.clickToSeekTime <= 4.2 &&
      syncState.activeLineTopRatio >= 0.3 &&
      syncState.activeLineTopRatio <= 0.4 &&
      (blurState.reducedMotion
        ? blurState.nearbyBlur === 'none' && blurState.maximumBlur === 'none'
        : blurState.nearbyBlur === 'blur(0.5px)' &&
          blurState.maximumBlur === 'blur(3px)' &&
          blurState.distantBlur === 'none') &&
      reducedMotionState.preferenceActive &&
      reducedMotionState.lyricFilter === 'none' &&
      reducedMotionState.lyricTransition === 'opacity' &&
      reducedMotionState.lyricAnimation === 'none' &&
      reducedMotionState.blobAnimation === 'none' &&
      reducedMotionState.progressAnimation === 'none' &&
      playerControlState.seekRatio >= 0.49 &&
      playerControlState.seekRatio <= 0.51 &&
      Math.abs(playerControlState.volumeLevel - 0.35) < 0.01 &&
      playerControlState.muted &&
      Math.abs(playerControlState.restoredVolume - playerControlState.volumeLevel) < 0.01 &&
      playerControlState.playState === 'Pause' &&
      playerControlState.pausedAfterToggle &&
      playerControlState.playButtonEnabled &&
      playerControlState.playbackFrameWasRunning &&
      playerControlState.playbackFrameStopped &&
      playerControlState.duration > 0 &&
      playerControlState.readyState >= 2 &&
      playerControlState.audioError === null &&
      playerControlState.currentSrc.includes('%20') &&
      playerControlState.currentSrc.includes('Bohemian%20Rhapsody') &&
      keyboardVolume < playerControlState.beforeArrowKey &&
      Math.abs(keyboardSavedVolume - keyboardVolume) < 0.01 &&
      draggedVolume.volume > 0.65 &&
      Math.abs(draggedVolume.volume - draggedVolume.rangeValue) < 0.02 &&
      Math.abs(draggedVolume.volume - draggedVolume.savedValue) < 0.02 &&
      narrowVolumeHover.focusOpacity === '1' &&
      viewportLayouts.length === 4 &&
      viewportLayouts.every((layout) =>
        layout.pillHasNoHorizontalOverflow &&
        layout.seekAtLeast80px &&
        layout.seekWithinPill &&
        layout.volumeWithinPill &&
        layout.muteWithinPill &&
        layout.dockDirection === 'column' &&
        layout.syncStackedAbove &&
        (layout.viewportWidth !== 320 || layout.volumeCollapsed) &&
        (layout.viewportWidth >= 380 || layout.volumeOpacityOnFocus === '1')
      ) &&
      contrastState.minimumLyricContrast >= 3 &&
      contrastState.minimumNearLyricContrast >= 3 &&
      contrastState.minimumTimeContrast >= 4.5 &&
      contrastState.minimumHintContrast >= 4.5 &&
      terminalState.zeroLines.emptyVisible &&
      terminalState.zeroLines.statusHidden &&
      terminalState.zeroLines.progressHidden &&
      terminalState.terminalErrorShowsEmpty &&
      terminalState.terminalErrorShowsBanner &&
      terminalState.terminalErrorHidesProgress;
    const audioPassed = playerControlState.playState === 'Pause' &&
      playerControlState.pausedAfterToggle &&
      playerControlState.playButtonEnabled;
    app.exit(rendererPassed && lyricsPassed && audioPassed ? 0 : 1);
  } catch (error) {
    console.error(error.stack || error.message || String(error));
    app.exit(1);
  }
});
