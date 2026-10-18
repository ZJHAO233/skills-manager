'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
(async () => {
  if (process.versions.electron) throw new Error('Use system Node');
  const asar = await import('@electron/asar');
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'joel-skills-pack-'));
  try {
    const source = path.join(__dirname, 'plugin');
    for (const name of ['assets', 'favicon.svg', 'icons.svg', 'index.html', 'logo.png', 'plugin.json', 'preload.js', 'download.cjs', 'download-controls.js', 'download-controls.css', 'release.cjs', 'docs.cjs', 'install.cjs', 'vendor']) await fs.cp(path.join(source, name), path.join(stage, name), { recursive: true });
    const archive = path.join(os.tmpdir(), 'joel-skills-' + Date.now() + '.asar');
    try {
      await asar.createPackage(stage, archive);
      const content = await fs.readFile(archive);
      await fs.writeFile(path.join(__dirname, 'skills-manager-1.2.0.zpx'), zlib.gzipSync(content));
      const config = JSON.parse(asar.extractFile(archive, 'plugin.json').toString());
      for (const f of ['preload.js','download.cjs','download-controls.js']) asar.extractFile(archive, f);
      console.log('Verified', config.name, config.version, config.author);
    } finally { asar.uncache(archive); await fs.rm(archive, { force: true }); }
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
