const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const crypto = require('crypto');
const https = require('https');
const packageMetadata = require('./package.json');

const DEFAULT_SETTINGS = Object.freeze({
  extraOnlineSourcesEnabled: false,
  acoustidApiKey: ''
});
const RESOURCE_BIN = path.join(process.resourcesPath, 'bin');
const DEFAULT_BACKEND = path.join(process.resourcesPath, 'backend', 'lyrics-pipeline.exe');
const AI_PACK_DIR = path.join(app.getPath('userData'), 'ai-pack');
const AI_BACKEND = path.join(AI_PACK_DIR, 'worker', 'lyrics-ai-worker', 'lyrics-ai-worker.exe');
const APP_CONFIG_PATH = path.join(process.resourcesPath, 'app-config.json');
const PACKAGED_WINDOWS = app.isPackaged && process.platform === 'win32';

function readBuildConfig() {
  if (!app.isPackaged) return {};
  try {
    return JSON.parse(fs.readFileSync(APP_CONFIG_PATH, 'utf8'));
  } catch (error) {
    console.error(`Could not read packaged app configuration: ${error.message}`);
    return {};
  }
}

const buildConfig = readBuildConfig();

function settingsFilePath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readAppSettings() {
  const filePath = settingsFilePath();
  if (!fs.existsSync(filePath)) return { ...DEFAULT_SETTINGS };
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return {
    extraOnlineSourcesEnabled: parsed.extraOnlineSourcesEnabled === true,
    acoustidApiKey: typeof parsed.acoustidApiKey === 'string' ? parsed.acoustidApiKey : ''
  };
}

function writeAppSettings(settings) {
  if (!settings ||
      typeof settings.extraOnlineSourcesEnabled !== 'boolean' ||
      typeof settings.acoustidApiKey !== 'string') {
    throw new TypeError('Invalid app settings.');
  }
  const filePath = settingsFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

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
  if (PACKAGED_WINDOWS) {
    const sep = process.platform === 'win32' ? ';' : ':';
    process.env.PATH = `${RESOURCE_BIN}${sep}${process.env.PATH || ''}`;
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
const PIPELINE_SCRIPT = app.isPackaged
  ? path.join(process.resourcesPath, 'backend', 'pipeline.py')
  : path.join(__dirname, 'backend', 'pipeline.py');


let mainWindow = null;
let activeProcess = null;
let activeProcessRequestId = null;
let aiPackInstallPromise = null;

function isAiPackInstalled() {
  return fs.existsSync(AI_BACKEND);
}

function downloadHttpsFile(url, destination, onProgress, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error('AI pack download exceeded the redirect limit.'));
      return;
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch (error) {
      reject(new Error(`Invalid AI pack URL: ${error.message}`));
      return;
    }
    if (parsedUrl.protocol !== 'https:') {
      reject(new Error('AI pack downloads must use HTTPS.'));
      return;
    }

    const request = https.get(parsedUrl, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        const redirectedUrl = new URL(response.headers.location, parsedUrl).toString();
        downloadHttpsFile(redirectedUrl, destination, onProgress, redirectCount + 1)
          .then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`AI pack download failed with HTTP ${response.statusCode}.`));
        return;
      }

      const totalBytes = Number(response.headers['content-length']) || 0;
      let downloadedBytes = 0;
      const output = fs.createWriteStream(destination, { flags: 'wx' });
      response.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        onProgress({ downloadedBytes, totalBytes });
      });
      response.on('error', reject);
      output.on('error', reject);
      output.on('finish', () => resolve());
      response.pipe(output);
    });
    request.setTimeout(30000, () => request.destroy(new Error('AI pack download timed out.')));
    request.on('error', reject);
  });
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('error', reject);
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

function extractAiPack(archivePath, destinationDir) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(process.resourcesPath, 'scripts', 'extract-ai-pack.ps1');
    const powershellPath = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    );
    const child = spawn(powershellPath, [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      '-ArchivePath', archivePath,
      '-DestinationPath', destinationDir
    ]);
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `AI pack extraction failed with exit code ${code}.`));
    });
  });
}

async function installAiPack(sender) {
  if (!PACKAGED_WINDOWS) {
    throw new Error('The AI transcription pack is currently available only for packaged Windows builds.');
  }
  if (isAiPackInstalled()) return { alreadyInstalled: true };
  if (aiPackInstallPromise) return aiPackInstallPromise;

  const { aiPackUrl, aiPackSha256 } = buildConfig;
  if (typeof aiPackUrl !== 'string' ||
      !aiPackUrl.startsWith('https://') ||
      typeof aiPackSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(aiPackSha256)) {
    throw new Error('The AI transcription pack is not configured for this release.');
  }

  aiPackInstallPromise = (async () => {
    const userDataDir = app.getPath('userData');
    const installId = crypto.randomUUID();
    const archivePath = path.join(userDataDir, `ai-pack-${installId}.zip`);
    const stagingDir = path.join(userDataDir, `ai-pack-staging-${installId}`);
    const sendProgress = (data) => {
      if (!sender.isDestroyed()) sender.send('ai-pack-progress', data);
    };

    try {
      fs.mkdirSync(userDataDir, { recursive: true });
      sendProgress({ stage: 'download', downloadedBytes: 0, totalBytes: 0 });
      await downloadHttpsFile(aiPackUrl, archivePath, (data) => {
        sendProgress({ stage: 'download', ...data });
      });

      const digest = await hashFile(archivePath);
      if (digest.toLowerCase() !== aiPackSha256.toLowerCase()) {
        throw new Error('AI pack checksum verification failed; the downloaded file was rejected.');
      }

      sendProgress({ stage: 'extract', downloadedBytes: 0, totalBytes: 0 });
      fs.rmSync(stagingDir, { recursive: true, force: true });
      await extractAiPack(archivePath, stagingDir);
      const stagedWorker = path.join(
        stagingDir,
        'worker',
        'lyrics-ai-worker',
        'lyrics-ai-worker.exe'
      );
      if (!fs.existsSync(stagedWorker)) {
        throw new Error('The downloaded AI pack is missing its transcription worker.');
      }
      fs.rmSync(AI_PACK_DIR, { recursive: true, force: true });
      fs.renameSync(stagingDir, AI_PACK_DIR);
      sendProgress({ stage: 'complete', downloadedBytes: 0, totalBytes: 0 });
      return { alreadyInstalled: false };
    } finally {
      fs.rmSync(archivePath, { force: true });
      fs.rmSync(stagingDir, { recursive: true, force: true });
      aiPackInstallPromise = null;
    }
  })();

  return aiPackInstallPromise;
}

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

async function runPipeline(audioPath, requestId) {
  const settings = readAppSettings();
  const enabledProviders = ['embedded', 'sidecar', 'lrclib'];
  if (settings.extraOnlineSourcesEnabled) enabledProviders.push('extra');
  const aiPackInstalled = PACKAGED_WINDOWS && fs.existsSync(AI_BACKEND);
  if (aiPackInstalled) enabledProviders.push('whisper');
  const executable = PACKAGED_WINDOWS
    ? (aiPackInstalled ? AI_BACKEND : DEFAULT_BACKEND)
    : PYTHON_BIN;
  const args = PACKAGED_WINDOWS
    ? [audioPath]
    : [PIPELINE_SCRIPT, audioPath];
  const userDataDir = app.getPath('userData');
  const cacheDir = path.join(userDataDir, 'lyrics-cache');
  const modelDir = path.join(userDataDir, 'ai-models');
  args.push(
    '--model', process.env.WHISPER_MODEL || 'small',
    '--enabled-providers', ...enabledProviders,
    '--cache-dir', cacheDir,
    '--app-name', packageMetadata.name,
    '--app-version', packageMetadata.version,
    '--model-dir', modelDir
  );

  return new Promise((resolve, reject) => {
    killActiveProcess();

    const proc = spawn(executable, args, {
      env: {
        ...process.env,
        ACOUSTID_API_KEY: settings.acoustidApiKey || buildConfig.acoustidApiKey || '',
        LYRICS_CACHE_DIR: cacheDir,
        LYRICS_MODEL_DIR: modelDir,
        HF_HOME: modelDir,
        TORCH_HOME: path.join(modelDir, 'torch'),
        XDG_CACHE_HOME: modelDir,
        DEMUX_EXECUTABLE: aiPackInstalled
          ? AI_BACKEND
          : '',
        PATH: PACKAGED_WINDOWS
          ? `${RESOURCE_BIN}${path.delimiter}${process.env.PATH || ''}`
          : process.env.PATH
      }
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

ipcMain.handle('get-settings', () => {
  try {
    return { ok: true, data: readAppSettings() };
  } catch (error) {
    return { ok: false, error: `Could not read settings: ${error.message}` };
  }
});

ipcMain.handle('save-settings', (_event, settings) => {
  try {
    const current = readAppSettings();
    writeAppSettings({
      extraOnlineSourcesEnabled: settings.extraOnlineSourcesEnabled,
      acoustidApiKey: settings.acoustidApiKey === undefined
        ? current.acoustidApiKey
        : settings.acoustidApiKey
    });
    return { ok: true, data: readAppSettings() };
  } catch (error) {
    return { ok: false, error: `Could not save settings: ${error.message}` };
  }
});

ipcMain.handle('get-ai-pack-status', () => ({
  installed: isAiPackInstalled(),
  available: PACKAGED_WINDOWS &&
    typeof buildConfig.aiPackUrl === 'string' &&
    buildConfig.aiPackUrl.startsWith('https://') &&
    typeof buildConfig.aiPackSha256 === 'string' &&
    /^[a-f0-9]{64}$/i.test(buildConfig.aiPackSha256)
}));

ipcMain.handle('install-ai-pack', async (event) => {
  try {
    const result = await installAiPack(event.sender);
    return { ok: true, data: result };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
});

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
