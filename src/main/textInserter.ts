import { execFile } from 'child_process';

export type WindowBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type FrontmostApp = {
  name: string;
  bundleId: string;
  pid: number | null;
  windowBounds: WindowBounds | null;
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
  set windowBounds to "||||"
  try
    set frontWindow to window 1 of frontProcess
    set windowPosition to position of frontWindow
    set windowSize to size of frontWindow
    set windowBounds to (item 1 of windowPosition as text) & "|" & (item 2 of windowPosition as text) & "|" & (item 1 of windowSize as text) & "|" & (item 2 of windowSize as text)
  end try
  return frontApp & "|" & frontAppId & "|" & (frontAppPid as text) & "|" & windowBounds
end tell`;
    execFile('osascript', ['-e', script], (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      const [name = '', bundleId = '', pidText = '', xText = '', yText = '', widthText = '', heightText = ''] = stdout.trim().split('|');
      const pid = Number.parseInt(pidText, 10);
      const x = Number.parseInt(xText, 10);
      const y = Number.parseInt(yText, 10);
      const width = Number.parseInt(widthText, 10);
      const height = Number.parseInt(heightText, 10);
      const hasWindowBounds = [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0;
      resolve({
        name,
        bundleId,
        pid: Number.isFinite(pid) ? pid : null,
        windowBounds: hasWindowBounds ? { x, y, width, height } : null,
      });
    });
  });
}
