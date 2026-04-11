import { execFile } from 'child_process';

export type FrontmostApp = {
  name: string;
  bundleId: string;
  pid: number | null;
};

export async function typeTextInActiveApp(text: string): Promise<void> {
  if (!text || text.trim().length === 0) return;

  const savedClipboard = await getClipboardContent();

  await setClipboardContent(text);

  await simulatePaste();

  if (savedClipboard !== null) {
    await new Promise(resolve => setTimeout(resolve, 200));
    await setClipboardContent(savedClipboard);
  }
}

function getClipboardContent(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('pbpaste', [], (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      resolve(stdout);
    });
  });
}

function setClipboardContent(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = execFile('pbcopy', [], (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
    proc.stdin?.write(text);
    proc.stdin?.end();
  });
}

function simulatePaste(): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = `
tell application "System Events"
  key code 9 using command down
end tell`;
    execFile('osascript', ['-e', script], (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function activateApp(bundleId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = `
tell application id "${bundleId}"
  activate
end tell`;
    execFile('osascript', ['-e', script], (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export async function getFrontmostApp(): Promise<FrontmostApp> {
  return new Promise((resolve, reject) => {
    const script = `
tell application "System Events"
  set frontProcess to first application process whose frontmost is true
  set frontApp to name of frontProcess
  set frontAppId to bundle identifier of frontProcess
  set frontAppPid to unix id of frontProcess
  return frontApp & "|" & frontAppId & "|" & (frontAppPid as text)
end tell`;
    execFile('osascript', ['-e', script], (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      const [name = '', bundleId = '', pidText = ''] = stdout.trim().split('|');
      const pid = Number.parseInt(pidText, 10);
      resolve({
        name,
        bundleId,
        pid: Number.isFinite(pid) ? pid : null,
      });
    });
  });
}