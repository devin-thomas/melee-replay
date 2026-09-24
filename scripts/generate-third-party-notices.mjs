import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const noticesDir = join(root, 'third-party');
const licensesDir = join(noticesDir, 'licenses');
const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const seen = new Set();
const packages = [];

function resolveDependency(fromDir, name, optional = false) {
  for (let current = fromDir; ; current = dirname(current)) {
    const candidate = join(current, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) return candidate;
    if (current === dirname(current)) {
      if (optional) return null;
      throw new Error(`Missing production dependency: ${name}`);
    }
  }
}

function visit(packagePath) {
  const packageDir = dirname(packagePath);
  if (seen.has(packageDir)) return;
  seen.add(packageDir);
  const metadata = JSON.parse(readFileSync(packagePath, 'utf8'));
  packages.push({ packageDir, metadata });
  for (const name of Object.keys(metadata.dependencies ?? {})) {
    visit(resolveDependency(packageDir, name));
  }
  for (const name of Object.keys(metadata.optionalDependencies ?? {})) {
    const optionalPath = resolveDependency(packageDir, name, true);
    if (optionalPath) visit(optionalPath);
  }
}

for (const name of Object.keys(rootPackage.dependencies ?? {})) {
  visit(resolveDependency(root, name));
}

function licenseText(packageDir, metadata) {
  const filename = readdirSync(packageDir).find((name) => /^(LICENSE|LICENCE|COPYING)(\.|$)/i.test(name));
  if (filename) return readFileSync(join(packageDir, filename), 'utf8');
  const readme = readFileSync(join(packageDir, 'README.md'), 'utf8');
  if (metadata.name === 'enet') {
    const marker = '#### License';
    if (!readme.includes(marker)) throw new Error('enet README license notice missing');
    return readme.slice(readme.indexOf(marker)).trim() + '\n';
  }
  if (metadata.name === 'reconnect-core') {
    const marker = '## License';
    if (!readme.includes(marker)) throw new Error('reconnect-core README license notice missing');
    return readme.slice(readme.indexOf(marker)).trim() + '\n';
  }
  if (metadata.name === 'precond') {
    return `Copyright (c) 2012 Mathieu Turcotte\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\n` +
      `of this software and associated documentation files (the "Software"), to deal\n` +
      `in the Software without restriction, including without limitation the rights\n` +
      `to use, copy, modify, merge, publish, distribute, sublicense, and/or sell\n` +
      `copies of the Software, and to permit persons to whom the Software is\n` +
      `furnished to do so, subject to the following conditions:\n\n` +
      `The above copyright notice and this permission notice shall be included in\n` +
      `all copies or substantial portions of the Software.\n\n` +
      `THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\n` +
      `IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\n` +
      `FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\n` +
      `AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\n` +
      `LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\n` +
      `OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN\n` +
      `THE SOFTWARE.\n`;
  }
  throw new Error(`No license notice found for ${metadata.name}`);
}

if (!existsSync(join(noticesDir, 'GPL-3.0.txt'))) {
  throw new Error('third-party/GPL-3.0.txt is required for the LGPLv3 license bundle');
}
mkdirSync(licensesDir, { recursive: true });
packages.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
const slippi = packages.find(({ metadata }) => metadata.name === '@slippi/slippi-js');
if (!slippi) throw new Error('Slippi JS is missing from the production dependency tree');
if (slippi.metadata.license !== 'LGPL-3.0-or-later') {
  throw new Error(`Review Slippi JS notice for changed license: ${slippi.metadata.license}`);
}
const slippiNotice = `slippi-slippi-js-${slippi.metadata.version}.txt`;
const lines = [
  '# Third-party notices',
  '',
  `Melee Replay uses @slippi/slippi-js ${slippi.metadata.version}, licensed under LGPL-3.0-or-later. Its use and the library itself are covered by the GNU Lesser General Public License. The library license is in \`licenses/${slippiNotice}\`; the accompanying GNU GPL version 3 is in \`GPL-3.0.txt\`. Copyright belongs to the Slippi JS contributors.`,
  '',
  'The app loads Slippi JS as an external Node module. It is kept unpacked so you can replace it with a compatible modified version:',
  '',
  '1. Close Melee Replay.',
  '2. In the installed app folder, open `resources/app.asar.unpacked/node_modules/@slippi/slippi-js/`.',
  '3. Obtain or build a compatible version from <https://github.com/project-slippi/slippi-js>. Replace the files in that directory, preserving `package.json` and the `dist/node` entry points. Keep a copy of the original directory if you may want to restore it.',
  '4. Start Melee Replay again. The application loads the replacement from that directory without rebuilding the app.',
  '',
  'This app does not restrict reverse engineering for debugging changes to Slippi JS. The project source is at <https://github.com/devin-thomas/melee-replay>. Slippi JS source is at <https://github.com/project-slippi/slippi-js>. No Slippi Playback Dolphin binary is bundled.',
  '',
  'The packaged Electron runtime supplies its own `LICENSE` and `LICENSES.chromium.html` alongside the executable. The app also embeds the DM Sans and Space Grotesk fonts under OFL-1.1; their complete notices are listed below.',
  '',
  '## Production packages',
  '',
  '| Package | Version | License | Notice |',
  '| --- | --- | --- | --- |'
];
for (const { packageDir, metadata } of packages) {
  if (!metadata.license && metadata.name !== 'precond') throw new Error(`Missing license metadata for ${metadata.name}`);
  const safeName = metadata.name.replace(/[^a-z0-9.-]+/gi, '-').replace(/^-+/, '');
  const filename = `${safeName}-${metadata.version}.txt`;
  writeFileSync(join(licensesDir, filename), licenseText(packageDir, metadata));
  lines.push(`| ${metadata.name} | ${metadata.version} | ${metadata.license ?? 'MIT (source notice)'} | [${filename}](licenses/${filename}) |`);
}
lines.push('', 'Notices are generated from the installed production dependency tree. Run `node scripts/generate-third-party-notices.mjs` after changing dependencies and review the resulting files before distributing a build.', '');
writeFileSync(join(noticesDir, 'NOTICES.md'), lines.join('\n'));
console.log(`Wrote notices for ${packages.length} production packages.`);
