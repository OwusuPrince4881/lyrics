const { app, BrowserWindow } = require('electron');
const path = require('path');

app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.webContents.on('did-finish-load', () => {
    console.log('ELECTRON_LAUNCH_SUCCESS: index.html loaded cleanly.');
    setTimeout(() => {
      app.quit();
    }, 500);
  });

  win.webContents.on('did-fail-load', (_event, _code, desc) => {
    console.error('ELECTRON_LAUNCH_FAILED:', desc);
    app.exit(1);
  });
});
