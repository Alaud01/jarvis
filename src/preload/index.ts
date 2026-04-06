import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('assistant', {
  getModels: () => ipcRenderer.invoke('get-models'),
  sendMessage: (model: string, messages: { role: string; content: string }[]) => 
    ipcRenderer.invoke('send-message', model, messages),
  sendMessageStream: (model: string, messages: { role: string; content: string }[]) =>
    ipcRenderer.invoke('send-message-stream', model, messages),
  stopStream: () => ipcRenderer.invoke('stop-stream'),
  onChunk: (callback: (chunk: string) => void) => {
    const listener = (_event: any, chunk: string) => callback(chunk);
    ipcRenderer.on('ollama-chunk', listener);
    return () => ipcRenderer.removeListener('ollama-chunk', listener);
  },
  onDone: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('ollama-done', listener);
    return () => ipcRenderer.removeListener('ollama-done', listener);
  },
  onError: (callback: (error: string) => void) => {
    const listener = (_event: any, error: string) => callback(error);
    ipcRenderer.on('ollama-error', listener);
    return () => ipcRenderer.removeListener('ollama-error', listener);
  },
});