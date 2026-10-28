const settingsToggle = document.getElementById('settings-toggle');
const settingsPanel = document.getElementById('settings-panel');
const settingsClose = document.getElementById('settings-close');
const extraSourcesToggle = document.getElementById('extra-sources-toggle');
const acoustidApiKeyInput = document.getElementById('acoustid-api-key');
const saveAcoustidApiKey = document.getElementById('save-acoustid-key');
const installAiPackButton = document.getElementById('install-ai-pack');
const aiPackProgress = document.getElementById('ai-pack-progress');
const aiPackStatus = document.getElementById('ai-pack-status');
const aiPackDialog = document.getElementById('ai-pack-confirm');
const aiPackDialogCancel = document.getElementById('ai-pack-cancel');
const aiPackDialogDownload = document.getElementById('ai-pack-confirm-download');
const confirmationDialog = document.getElementById('extra-sources-confirm');
const confirmationCancel = document.getElementById('extra-sources-cancel');
const confirmationEnable = document.getElementById('extra-sources-confirm-enable');
const aboutScreen = document.getElementById('about-screen');
const aboutOpen = document.getElementById('about-open');
const aboutBack = document.getElementById('about-back');

let extraSourcesEnabled = false;
let acoustidApiKey = '';
let aiPackAvailable = false;

function showSettingsError(message) {
  const status = document.getElementById('status');
  document.getElementById('status-text').textContent = message;
  status.hidden = !message;
}

function setSettingsPanelOpen(open) {
  settingsPanel.hidden = !open;
  settingsToggle.setAttribute('aria-expanded', String(open));
}

function askToEnableExtraSources() {
  return new Promise((resolve) => {
    const handleCancel = (event) => {
      event.preventDefault();
      finish(false);
    };
    const finish = (accepted) => {
      confirmationDialog.close();
      confirmationEnable.removeEventListener('click', accept);
      confirmationCancel.removeEventListener('click', cancel);
      confirmationDialog.removeEventListener('cancel', handleCancel);
      resolve(accepted);
    };
    const accept = () => finish(true);
    const cancel = () => finish(false);
    confirmationEnable.addEventListener('click', accept, { once: true });
    confirmationCancel.addEventListener('click', cancel, { once: true });
    confirmationDialog.addEventListener('cancel', handleCancel);
    confirmationDialog.showModal();
  });
}

async function saveExtraSourcesSetting(enabled) {
  const response = await window.lyricsApp.saveSettings({
    extraOnlineSourcesEnabled: enabled
  });
  if (!response.ok) throw new Error(response.error || 'Could not save settings.');
  extraSourcesEnabled = response.data.extraOnlineSourcesEnabled;
  extraSourcesToggle.checked = extraSourcesEnabled;
}

settingsToggle.addEventListener('click', () => {
  setSettingsPanelOpen(settingsPanel.hidden);
});

settingsClose.addEventListener('click', () => setSettingsPanelOpen(false));

saveAcoustidApiKey.addEventListener('click', async () => {
  try {
    const response = await window.lyricsApp.saveSettings({
      extraOnlineSourcesEnabled: extraSourcesEnabled,
      acoustidApiKey: acoustidApiKeyInput.value.trim()
    });
    if (!response.ok) throw new Error(response.error || 'Could not save settings.');
    acoustidApiKey = response.data.acoustidApiKey;
    acoustidApiKeyInput.value = acoustidApiKey;
    showSettingsError('');
  } catch (error) {
    showSettingsError(`Could not save AcoustID key: ${error.message || error}`);
  }
});

async function installAiPackFromSettings() {
  installAiPackButton.disabled = true;
  aiPackProgress.hidden = false;
  aiPackProgress.removeAttribute('value');
  aiPackStatus.textContent = 'Preparing AI transcription pack download…';
  try {
    const response = await window.lyricsApp.installAiPack();
    if (!response.ok) throw new Error(response.error || 'Could not install the AI pack.');
    aiPackStatus.textContent = 'AI pack installed. Drop the audio file again to transcribe it.';
    aiPackProgress.value = 100;
    installAiPackButton.textContent = 'AI pack installed';
  } catch (error) {
    aiPackStatus.textContent = `AI pack installation failed: ${error.message || error}`;
  } finally {
    installAiPackButton.disabled = !aiPackAvailable || aiPackStatus.textContent.startsWith('AI pack installed');
  }
}

installAiPackButton.addEventListener('click', installAiPackFromSettings);

window.confirmAiPackDownload = () => new Promise((resolve) => {
  const finish = (accepted) => {
    aiPackDialog.close();
    aiPackDialogCancel.removeEventListener('click', cancel);
    aiPackDialogDownload.removeEventListener('click', accept);
    aiPackDialog.removeEventListener('cancel', onCancel);
    resolve(accepted);
  };
  const cancel = () => finish(false);
  const accept = () => finish(true);
  const onCancel = (event) => {
    event.preventDefault();
    finish(false);
  };
  aiPackDialogCancel.addEventListener('click', cancel);
  aiPackDialogDownload.addEventListener('click', accept);
  aiPackDialog.addEventListener('cancel', onCancel);
  aiPackDialog.showModal();
});

window.lyricsApp.onAiPackProgress((event) => {
  if (event.stage === 'download') {
    if (event.totalBytes > 0) {
      aiPackProgress.max = event.totalBytes;
      aiPackProgress.value = event.downloadedBytes;
      const downloaded = (event.downloadedBytes / 1024 / 1024).toFixed(1);
      const total = (event.totalBytes / 1024 / 1024).toFixed(1);
      aiPackStatus.textContent = `Downloading AI pack: ${downloaded} / ${total} MB`;
    } else {
      aiPackProgress.removeAttribute('value');
      aiPackStatus.textContent = `Downloading AI pack: ${(event.downloadedBytes / 1024 / 1024).toFixed(1)} MB`;
    }
  } else if (event.stage === 'extract') {
    aiPackProgress.removeAttribute('value');
    aiPackStatus.textContent = 'Verifying and unpacking AI transcription pack…';
  } else if (event.stage === 'complete') {
    aiPackProgress.value = 100;
    installAiPackButton.textContent = 'AI pack installed';
    installAiPackButton.disabled = true;
  }
});

extraSourcesToggle.addEventListener('change', async () => {
  if (extraSourcesToggle.checked && !extraSourcesEnabled) {
    const accepted = await askToEnableExtraSources();
    if (!accepted) {
      extraSourcesToggle.checked = false;
      return;
    }
  }

  try {
    await saveExtraSourcesSetting(extraSourcesToggle.checked);
    showSettingsError('');
  } catch (error) {
    extraSourcesToggle.checked = extraSourcesEnabled;
    showSettingsError(`Could not save settings: ${error.message || error}`);
  }
});

aboutOpen.addEventListener('click', () => {
  setSettingsPanelOpen(false);
  aboutScreen.hidden = false;
});

aboutBack.addEventListener('click', () => {
  aboutScreen.hidden = true;
  setSettingsPanelOpen(true);
});

window.lyricsApp.getSettings().then((response) => {
  if (!response.ok) throw new Error(response.error || 'Could not load settings.');
  extraSourcesEnabled = response.data.extraOnlineSourcesEnabled;
  extraSourcesToggle.checked = extraSourcesEnabled;
  acoustidApiKey = response.data.acoustidApiKey;
  acoustidApiKeyInput.value = acoustidApiKey;
}).catch((error) => {
  showSettingsError(`Could not load settings: ${error.message || error}`);
});

window.lyricsApp.getAiPackStatus().then((status) => {
  if (status.installed) {
    aiPackStatus.textContent = 'AI transcription pack is installed.';
    installAiPackButton.disabled = true;
    installAiPackButton.textContent = 'AI pack installed';
  } else if (!status.available) {
    aiPackAvailable = false;
    aiPackStatus.textContent = 'AI transcription pack is not available in this build.';
    installAiPackButton.disabled = true;
  } else {
    aiPackAvailable = true;
    aiPackStatus.textContent = 'Download the optional pack to enable local AI transcription.';
  }
}).catch((error) => {
  aiPackStatus.textContent = `Could not check AI pack status: ${error.message || error}`;
  installAiPackButton.disabled = true;
});
