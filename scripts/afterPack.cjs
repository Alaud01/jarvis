/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');

const ARCH_NAMES = {
  0: 'ia32',
  1: 'x64',
  2: 'armv7l',
  3: 'arm64',
  4: 'universal',
};

const TARGETS = {
  'darwin:x64': ['@openai/codex-darwin-x64', 'x86_64-apple-darwin'],
  'darwin:arm64': ['@openai/codex-darwin-arm64', 'aarch64-apple-darwin'],
  'linux:x64': ['@openai/codex-linux-x64', 'x86_64-unknown-linux-musl'],
  'linux:arm64': ['@openai/codex-linux-arm64', 'aarch64-unknown-linux-musl'],
  'win32:x64': ['@openai/codex-win32-x64', 'x86_64-pc-windows-msvc'],
  'win32:arm64': ['@openai/codex-win32-arm64', 'aarch64-pc-windows-msvc'],
};

module.exports = async function afterPack(context) {
  const platform = context.electronPlatformName;
  const arch = typeof context.arch === 'number' ? ARCH_NAMES[context.arch] : context.arch;
  const target = TARGETS[`${platform}:${arch}`];
  if (!target) {
    throw new Error(`No bundled Codex runtime is configured for ${platform} (${arch}).`);
  }

  const [platformPackage, targetTriple] = target;
  const codexPackageJsonPath = require.resolve('@openai/codex/package.json');
  const requireFromCodex = createRequire(codexPackageJsonPath);
  const platformPackageJsonPath = requireFromCodex.resolve(`${platformPackage}/package.json`);
  const executableName = platform === 'win32' ? 'codex.exe' : 'codex';
  const source = path.join(
    path.dirname(platformPackageJsonPath),
    'vendor',
    targetTriple,
    'bin',
    executableName,
  );
  const productFilename = context.packager.appInfo.productFilename;
  const resourcesDirectory = platform === 'darwin'
    ? path.join(context.appOutDir, `${productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  const destinationDirectory = path.join(resourcesDirectory, 'codex', 'bin');
  const destination = path.join(destinationDirectory, executableName);

  fs.mkdirSync(destinationDirectory, { recursive: true, mode: 0o755 });
  fs.copyFileSync(source, destination);
  if (platform !== 'win32') fs.chmodSync(destination, 0o755);
};
