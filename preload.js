const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('lyricsApp', {
  // Turn a dropped web File into an absolute path
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // Run the backend pipeline
  processAudio: (audioPath, requestId) => ipcRenderer.invoke('process-audio', audioPath, requestId),

  // Cancel an ongoing pipeline run
  cancelPipeline: (requestId) => ipcRenderer.invoke('cancel-pipeline', requestId),

  // Subscribe to real-time pipeline progress updates
  onProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('pipeline-progress', handler);
    return () => ipcRenderer.removeListener('pipeline-progress', handler);
  },

  toFileUrl: (audioPath) => ipcRenderer.invoke('audio-file-url', audioPath)
});
