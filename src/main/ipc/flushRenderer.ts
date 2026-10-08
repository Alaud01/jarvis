import { ipcMain, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';

export async function flushRenderer(webContents: WebContents | undefined): Promise<void> {
  if (!webContents || webContents.isDestroyed()) return;
  await new Promise<void>((resolve, reject) => {
    const requestId = randomUUID();
    const cleanup = () => {
      clearTimeout(timer);
      ipcMain.removeListener('store:flushed', listener);
    };
    const listener = (event: Electron.IpcMainEvent, id: string, error?: string) => {
      if (event.sender !== webContents || id !== requestId) return;
      cleanup();
      if (error) reject(new Error(error));
      else resolve();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for pending conversation saves.'));
    }, 10_000);
    ipcMain.on('store:flushed', listener);
    try {
      webContents.send('store:flush', requestId);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
