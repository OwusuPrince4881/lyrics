const { app, BrowserWindow } = require('electron');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
require('../main.js');

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

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

    const minimumSize = window.getMinimumSize();
    await window.webContents.executeJavaScript(`(() => {
      document.body.classList.add('has-track');
      document.getElementById('track-info').hidden = false;
      document.getElementById('lyrics-panel').hidden = false;
      document.getElementById('progress-card').hidden = false;
      document.getElementById('status').hidden = false;
      localStorage.removeItem('lyrics-sync-offset:compact-layout-test');
      loadSyncOffset('compact-layout-test');
      renderLyrics(Array.from({ length: 24 }, (_, index) => ({
        time: index,
        text: 'Compact layout lyric line ' + index
      })));
      updateActiveLine(7.5);
    })()`);
    await window.webContents.executeJavaScript(`new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    )`);
    const debuggerApi = window.webContents.debugger;
    debuggerApi.attach('1.3');
    await debuggerApi.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 600,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false
    });
    await wait(500);

    const sizeResults = [];
    for (const [width, height] of [[320, 240], [430, 340], [480, 580], [900, 700]]) {
      await debuggerApi.sendCommand('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false
      });
      await window.webContents.executeJavaScript(`new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      )`);
      await wait(500);
      await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const targetCompact = ${width <= 380 || height <= 520};
        const deadline = performance.now() + 2000;
        const rows = Array.from(document.querySelectorAll('.compact-row'));
        const check = () => {
          const settled = rows.every((row) => {
            const style = getComputedStyle(row);
            const bounds = row.getBoundingClientRect();
            return targetCompact
              ? style.visibility === 'hidden' && Number(style.opacity) === 0 && bounds.height === 0
              : style.visibility === 'visible' && Number(style.opacity) === 1 && bounds.height > 0;
          });
          if (settled) {
            resolve();
          } else if (performance.now() >= deadline) {
            reject(new Error('Compact layout transition did not settle'));
          } else {
            requestAnimationFrame(check);
          }
        };
        check();
      })`);
      await wait(120);
      sizeResults.push(await window.webContents.executeJavaScript(`(() => {
        const visible = (element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        };
        const bounds = (element) => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
        };
        const compact = matchMedia('(max-height: 520px), (max-width: 380px)').matches;
        const shell = document.querySelector('.shell');
        const panel = document.getElementById('lyrics-panel');
        const activeLine = document.querySelector('#lyrics-list .active');
        const panelRect = panel.getBoundingClientRect();
        const lineRect = activeLine.getBoundingClientRect();
        const activeLinePosition = (lineRect.top + lineRect.height / 2 - panelRect.top) / panel.clientHeight;
        const playerRect = bounds(document.getElementById('player-bar'));
        const shellRect = bounds(shell);
        const syncToggle = document.getElementById('sync-toggle-btn');
        syncToggle.focus();
        const syncControlsExpandOnFocus = visible(document.getElementById('sync-back-btn'));
        syncToggle.blur();
        return {
          viewport: { width: innerWidth, height: innerHeight },
          compact,
          visible: {
            title: visible(document.querySelector('.header')),
            subtitle: visible(document.querySelector('.app-subtitle')),
            dropBanner: visible(document.getElementById('drop-zone')),
            trackInfo: visible(document.getElementById('track-info')),
            progressCard: visible(document.getElementById('progress-card')),
            status: visible(document.getElementById('status')),
            lyrics: visible(panel),
            player: visible(document.getElementById('player-bar')),
            play: visible(document.getElementById('player-play-btn')),
            seek: visible(document.getElementById('player-seek')),
            currentTime: visible(document.getElementById('player-current-time')),
            duration: visible(document.getElementById('player-duration')),
            volume: visible(document.querySelector('.volume-control')),
            syncIcon: visible(document.getElementById('sync-toggle-btn')),
            syncButtons: visible(document.getElementById('sync-back-btn')),
            syncControlsExpandOnFocus
          },
          collapsedRows: Array.from(document.querySelectorAll('.compact-row'), (row) => ({
            height: row.getBoundingClientRect().height,
            visibility: getComputedStyle(row).visibility,
            opacity: getComputedStyle(row).opacity,
            gridRows: getComputedStyle(row).gridTemplateRows,
            transition: getComputedStyle(row).transition
          })),
          lyricsOverflow: getComputedStyle(panel).overflowY,
          shellOverflow: getComputedStyle(shell).overflow,
          panel: {
            clientHeight: panel.clientHeight,
            scrollTop: panel.scrollTop,
            scrollHeight: panel.scrollHeight,
            activeLineTop: lineRect.top,
            panelTop: panelRect.top,
            activeLineHeight: lineRect.height
          },
          lyricFontSize: getComputedStyle(activeLine).fontSize,
          seekWidth: bounds(document.getElementById('player-seek')).width,
          activeLinePosition,
          playerContained: playerRect.left >= shellRect.left &&
            playerRect.right <= shellRect.right &&
            playerRect.bottom <= shellRect.bottom
        };
      })()`));
    }

    const dropCheck = await window.webContents.executeJavaScript(`(() => {
      const fileTransfer = new DataTransfer();
      fileTransfer.items.add(new File(['audio'], 'compact-drop.mp3', { type: 'audio/mpeg' }));
      const dragEnter = new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: fileTransfer });
      document.body.dispatchEvent(dragEnter);
      const overlayVisible = getComputedStyle(document.getElementById('drop-overlay')).visibility === 'visible';
      const prevented = dragEnter.defaultPrevented;
      const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() });
      document.body.dispatchEvent(drop);
      return {
        overlayVisible,
        dragPrevented: prevented,
        dropPrevented: drop.defaultPrevented,
        cleared: !document.body.classList.contains('file-dragging')
      };
    })()`);

    await debuggerApi.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 307,
      height: 203,
      deviceScaleFactor: 1,
      mobile: false
    });
    await window.webContents.executeJavaScript(`new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    )`);
    await wait(500);
    const minimumClientCheck = await window.webContents.executeJavaScript(`(() => {
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      };
      const shellRect = document.querySelector('.shell').getBoundingClientRect();
      const playerRect = document.getElementById('player-bar').getBoundingClientRect();
      const panel = document.getElementById('lyrics-panel');
      const panelRect = panel.getBoundingClientRect();
      const lineRect = document.querySelector('#lyrics-list .active').getBoundingClientRect();
      return {
        viewport: { width: innerWidth, height: innerHeight },
        collapsed: Array.from(document.querySelectorAll('.compact-row')).every((row) =>
          row.getBoundingClientRect().height === 0 && getComputedStyle(row).visibility === 'hidden'
        ),
        progress: visible(document.getElementById('progress-card')),
        status: visible(document.getElementById('status')),
        lyrics: visible(panel),
        seekWidth: document.getElementById('player-seek').getBoundingClientRect().width,
        playerContained: playerRect.left >= shellRect.left &&
          playerRect.right <= shellRect.right &&
          playerRect.bottom <= shellRect.bottom,
        activeLinePosition: (lineRect.top + lineRect.height / 2 - panelRect.top) / panel.clientHeight
      };
    })()`);
    const compactSyncCheck = await window.webContents.executeJavaScript(`(() => {
      const toggle = document.getElementById('sync-toggle-btn');
      toggle.focus();
      const expandedOnFocus = getComputedStyle(document.getElementById('sync-forward-btn')).display !== 'none';
      document.getElementById('sync-forward-btn').click();
      const shiftedLater = syncOffsetSeconds;
      document.getElementById('sync-back-btn').click();
      const shiftedBack = syncOffsetSeconds;
      document.getElementById('sync-reset-btn').click();
      toggle.blur();
      return { expandedOnFocus, shiftedLater, shiftedBack, reset: syncOffsetSeconds };
    })()`);
    await debuggerApi.sendCommand('Emulation.clearDeviceMetricsOverride');
    debuggerApi.detach();

    const expected = sizeResults.map((result, index) => {
      const compactExpected = index < 2;
      const visibility = result.visible;
      return result.compact === compactExpected &&
        visibility.title !== compactExpected &&
        visibility.subtitle !== compactExpected &&
        visibility.dropBanner !== compactExpected &&
        visibility.trackInfo !== compactExpected &&
        visibility.progressCard &&
        visibility.status &&
        visibility.lyrics &&
        visibility.player &&
        visibility.play &&
        visibility.seek &&
        visibility.currentTime &&
        visibility.duration &&
        visibility.volume !== compactExpected &&
        visibility.syncIcon === compactExpected &&
        visibility.syncButtons !== compactExpected &&
        visibility.syncControlsExpandOnFocus &&
        result.lyricsOverflow === 'auto' &&
        result.shellOverflow === 'hidden' &&
        result.playerContained &&
        result.seekWidth >= 80 &&
        Math.abs(result.activeLinePosition - 0.35) < 0.1;
    });

    console.log(JSON.stringify({
      minimumSize,
      sizes: sizeResults,
      minimumClientCheck,
      compactSyncCheck,
      dropCheck,
      expected
    }, null, 2));

    app.exit(
      minimumSize[0] === 320 &&
      minimumSize[1] === 240 &&
      minimumClientCheck.viewport.width === 307 &&
      minimumClientCheck.viewport.height === 203 &&
      minimumClientCheck.collapsed &&
      minimumClientCheck.progress &&
      minimumClientCheck.status &&
      minimumClientCheck.lyrics &&
      minimumClientCheck.seekWidth >= 80 &&
      minimumClientCheck.playerContained &&
      Math.abs(minimumClientCheck.activeLinePosition - 0.35) < 0.1 &&
      compactSyncCheck.expandedOnFocus &&
      compactSyncCheck.shiftedLater === 0.1 &&
      compactSyncCheck.shiftedBack === 0 &&
      compactSyncCheck.reset === 0 &&
      expected.every(Boolean) &&
      dropCheck.overlayVisible &&
      dropCheck.dragPrevented &&
      dropCheck.dropPrevented &&
      dropCheck.cleared
        ? 0
        : 1
    );
  } catch (error) {
    console.error(error.stack || error.message || String(error));
    app.exit(1);
  }
});
