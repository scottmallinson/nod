import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';
import { buildDesktopUI } from './build-ui.mjs';
import { copyBundleSource as copy } from './engine-dependencies.mjs';
import { compatibleVersion, hardenElectron, run, sourceRevision } from './release-tools.mjs';

const electronVersion = '43.8.10';
const minimumSystemVersion = '12.0';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const desktop = join(root, 'desktop');
const output = join(root, 'dist', 'desktop-macos12');
const stage = join(root, 'dist', 'desktop-macos12-staging');
const engine = join(stage, 'engine');
const appSource = join(stage, 'app');
const stageOnly = process.argv.includes('--stage-only');
if (!stageOnly && process.platform !== 'darwin')
  throw new Error('The macOS 12 client builds on a Mac. Use a Mac with macOS 14 or later.');

const configuration = JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8'));
await rm(stage, { recursive: true, force: true });
await rm(output, { recursive: true, force: true });
await mkdir(join(engine, 'src/shared'), { recursive: true });
await mkdir(join(engine, 'dist/web'), { recursive: true });
await mkdir(appSource, { recursive: true });
for (const file of ['app-pages.json', 'posthog-host.json'])
  await copy(join(root, 'src/shared', file), join(engine, 'src/shared', file));
await copy(join(root, 'public/nod-logo.png'), join(engine, 'dist/web/nod-logo.png'));
for (const file of ['LICENSE', 'NOTICE']) await copy(join(root, file), join(engine, file));
for (const path of ['main', 'preload']) await copy(join(desktop, path), join(appSource, path));
await buildDesktopUI(join(appSource, 'ui'));
configuration.nodBuild = {
  client: true,
  source: await sourceRevision(),
  builtAt: new Date().toISOString(),
  modified: Boolean(await run('/usr/bin/git', ['-C', root, 'status', '--porcelain'])),
};
delete configuration.devDependencies;
delete configuration.scripts;
await writeFile(join(appSource, 'package.json'), JSON.stringify(configuration, null, 2));
if (stageOnly) {
  console.log(`Client staged: ${stage}`);
  process.exit(0);
}

const iconset = join(stage, 'nod.iconset');
await mkdir(iconset, { recursive: true });
for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
  const filename = size === 1024 ? 'icon_512x512@2x.png' : `icon_${size}x${size}.png`;
  await run('/usr/bin/sips', [
    '-z',
    String(size),
    String(size),
    join(desktop, 'assets', 'nod-macos.png'),
    '--out',
    join(iconset, filename),
  ]);
}
const icon = join(stage, 'nod.icns');
await run('/usr/bin/iconutil', ['--convert', 'icns', '--output', icon, iconset]);
const [bundle] = await packager({
  dir: appSource,
  out: output,
  name: configuration.productName,
  executableName: 'nod',
  appBundleId: 'dev.nod.desktop',
  appVersion: configuration.version,
  appCopyright: 'Copyright © 2026 n8n GmbH',
  electronVersion,
  platform: 'darwin',
  arch: 'x64',
  asar: false,
  prune: false,
  overwrite: true,
  icon,
  protocols: [{ name: 'nod', schemes: ['nod'] }],
  extendInfo: {
    LSMinimumSystemVersion: minimumSystemVersion,
    NSMicrophoneUsageDescription: 'Nod uses your microphone when you record a voice message.',
  },
});
const application = join(bundle, `${configuration.productName}.app`);
await run('/usr/libexec/PlistBuddy', [
  '-c',
  `Set :CFBundleDisplayName ${configuration.productName}`,
  join(application, 'Contents/Info.plist'),
]);
await rename(engine, join(application, 'Contents/Resources/engine'));
const licenses = join(application, 'Contents/Resources/licenses');
await mkdir(licenses, { recursive: true });
for (const name of ['LICENSE', 'LICENSES.chromium.html'])
  await copy(join(bundle, name), join(licenses, name));

const framework = join(
  application,
  'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework',
);
const build = await run('/usr/bin/vtool', ['-show-build', framework]);
const versions = [...build.matchAll(/\bminos (\d+\.\d+(?:\.\d+)?)\b/g)].map((match) => match[1]);
if (!versions.length || versions.some((value) => !compatibleVersion(value, minimumSystemVersion)))
  throw new Error(`Electron ${electronVersion} needs a newer macOS than ${minimumSystemVersion}.`);
if (
  !(await run('/usr/bin/lipo', ['-archs', join(application, 'Contents/MacOS/nod')])).includes(
    'x86_64',
  )
)
  throw new Error('The client is not an Intel build.');

await hardenElectron(application);
await run(
  '/usr/bin/codesign',
  ['--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements', application],
  { timeout: 10 * 60_000 },
);
await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', application]);

const disk = join(stage, 'disk');
await mkdir(disk, { recursive: true });
await run('/bin/cp', ['-cR', application, join(disk, basename(application))]);
await run('/bin/ln', ['-s', '/Applications', join(disk, 'Applications')]);
const diskImage = join(output, 'nod-macos12-x64.dmg');
await run(
  '/usr/bin/hdiutil',
  [
    'create',
    '-volname',
    configuration.productName,
    '-srcfolder',
    disk,
    '-ov',
    '-format',
    'UDZO',
    diskImage,
  ],
  { timeout: 15 * 60_000 },
);
await run('/usr/bin/hdiutil', ['verify', diskImage], { timeout: 10 * 60_000 });
console.log(`Disk image: ${diskImage}`);
console.log('Ad-hoc signed for Intel Macs on macOS 12 or later. Not notarized.');
