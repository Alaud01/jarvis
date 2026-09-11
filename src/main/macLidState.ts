import { execFile } from 'node:child_process';

// Read the hardware lid switch on every attempt; a live MediaStream does not
// reflect the built-in microphone's hardware disconnect in clamshell mode.
export async function isMacLidClosed(): Promise<boolean> {
  if (process.platform !== 'darwin') return false;

  return new Promise(resolve => {
    execFile('/usr/sbin/ioreg', ['-r', '-k', 'AppleClamshellState', '-d', '4'],
      { timeout: 1500, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        if (error) {
          console.warn('[AudioRecorder] Could not read Mac lid state:', error.message);
          resolve(false);
          return;
        }
        resolve(/"AppleClamshellState"\s*=\s*Yes\b/.test(stdout));
      });
  });
}
