const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

// Augment PATH on macOS/Linux so spawned processes can find system tools (ffmpeg, fpcalc)
function setupEnvironment() {
  if (process.platform === 'darwin') {
    const extraPaths = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
    const current = process.env.PATH ? process.env.PATH.split(':') : [];
    extraPaths.forEach((p) => {
      if (!current.includes(p)) current.unshift(p);
    });
    process.env.PATH = current.join(':');
  }

  // If packaged, add bundled resources/bin to PATH
  if (app.isPackaged) {
    const resourceBin = path.join(process.resourcesPath, 'bin');
    const sep = process.platform === 'win32' ? ';' : ':';
    process.env.PATH = `${resourceBin}${sep}${process.env.PATH}`;
  }
}

setupEnvironment();

const venvPython = path.join(
  __dirname,
  '.venv',
  process.platform === 'win32' ? 'Scripts' : 'bin',
  process.platform === 'win32' ? 'python.exe' : 'python'
);
const PATH_PYTHON_BIN = process.platform === 'win32' ? 'python' : 'python3';
const PYTHON_BIN = !app.isPackaged && fs.existsSync(venvPython)
  ? venvPython
  : PATH_PYTHON_BIN;
// In dev: backend/pipeline.py lives next to main.js.
// When packaged by electron-builder: it is an extraResource at <app>/resources/backend/.
const PIPELINE_SCRIPT = app.isPackaged
  ? path.join(process.resourcesPath, 'backend', 'pipeline.py')
  : path.join(__dirname, 'backend', 'pipeline.py');


let mainWindow = null;
let activeProcess = null;
let activeProcessRequestId = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 760,
    minWidth: 320,
    minHeight: 240,
    backgroundColor: '#0b0d17',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    killActiveProcess();
    mainWindow = null;
  });
}

function killActiveProcess(requestId) {
  if (requestId !== undefined && activeProcessRequestId !== requestId) return;
  if (activeProcess) {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', activeProcess.pid.toString(), '/f', '/t']);
      } else {
        activeProcess.kill('SIGTERM');
      }
    } catch (_) {}
    activeProcess = null;
    activeProcessRequestId = null;
  }
}

function runPipeline(audioPath, requestId) {
  return new Promise((resolve, reject) => {
    killActiveProcess();

    const modelSize = process.env.WHISPER_MODEL || 'small';
    const proc = spawn(PYTHON_BIN, [PIPELINE_SCRIPT, audioPath, '--model', modelSize], {
      env: { ...process.env }
    });
    activeProcess = proc;
    activeProcessRequestId = requestId;

    function forwardPipelineEvent(event) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pipeline-progress', { ...event, requestId });
      }
    }

    let buffer = '';
    let pipelineResult = null;
    let pipelineError = null;

    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep partial line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('__LYRICS_EVENT__ ')) {
          try {
            const event = JSON.parse(trimmed.slice('__LYRICS_EVENT__ '.length));
            if (event.type === 'progress') {
              forwardPipelineEvent(event);
            } else if (event.type === 'result') {
              pipelineResult = event;
              forwardPipelineEvent(event);
            } else if (event.type === 'error') {
              pipelineError = new Error(event.detail || event.error);
              pipelineError.code = event.error;
              pipelineError.detail = event.detail;
              forwardPipelineEvent(event);
            }
          } catch (_) {}
        } else if (trimmed.startsWith('{')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed.error) {
              pipelineError = new Error(parsed.detail || parsed.error);
              pipelineError.code = parsed.error;
              pipelineError.detail = parsed.detail;
            } else if (parsed.lines) {
              pipelineResult = parsed;
            }
          } catch (_) {}
        }
      }
    });

    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      try {
        const parsed = JSON.parse(text.trim());
        if (parsed.error) {
          pipelineError = new Error(parsed.detail || parsed.error);
          pipelineError.code = parsed.error;
          pipelineError.detail = parsed.detail;
        }
      } catch (_) {}
    });

    proc.on('close', (code) => {
      if (activeProcess === proc) {
        activeProcess = null;
        activeProcessRequestId = null;
      }
      if (pipelineResult) {
        resolve(pipelineResult);
      } else if (pipelineError) {
        reject(pipelineError);
      } else if (code !== 0) {
        reject(new Error(stderr.trim() || `Pipeline failed with exit code ${code}`));
      } else {
        reject(new Error('Pipeline ended without returning lyrics.'));
      }
    });

    proc.on('error', (err) => {
      if (activeProcess === proc) {
        activeProcess = null;
        activeProcessRequestId = null;
      }
      reject(err);
    });
  });
}

// IPC Handlers
ipcMain.handle('audio-file-url', (_event, audioPath) => pathToFileURL(audioPath).href);

ipcMain.handle('process-audio', async (_event, audioPath, requestId) => {
  try {
    const result = await runPipeline(audioPath, requestId);
    return { ok: true, data: result };
  } catch (err) {
    return { ok: false, error: err.message, code: err.code, detail: err.detail };
  }
});

ipcMain.handle('cancel-pipeline', async (_event, requestId) => {
  killActiveProcess(requestId);
  return { ok: true };
});

app.whenReady().then(() => {
  createWindow();
});

app.on('before-quit', () => {
  killActiveProcess();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
