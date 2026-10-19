'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { previewFolder, previewZip } = require('./local-import.cjs');
const JSZip = require('./vendor/jszip.js');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'local-import-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }));
  return directory;
}
function cleanup(t, result) { t.after(() => fs.rm(result.tempDir, { recursive: true, force: true })); }
async function write(root, name, text = '') {
  const target = path.join(root, name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, text);
  return target;
}
async function sparse(root, name, size) {
  const target = await write(root, name);
  await fs.truncate(target, size);
}
async function link(t, target, alias, type) {
  try { await fs.symlink(target, alias, type); return true; }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('Symbolic links are unavailable on this system.'); return false; }
    throw error;
  }
}

test('folder snapshot preserves root and nested basenames, descriptions, case variants and full structure', async t => {
  const root = await fixture(t);
  const source = path.join(root, 'selected-name');
  await write(source, 'sKiLl.Md', '---\nname: different-name\ndescription: >\n  Root description\n  continued\n---\n# root');
  await write(source, 'nested/child/SKILL.md', '---\nname: ignored\ndescription: "Nested description"\n---\n');
  await write(source, 'nested/child/assets/example.txt', 'asset');
  await write(source, 'readme.txt', 'readme');
  await write(source, '.GIT/SKILL.md', 'ignored');
  await write(source, 'node_modules/package/SKILL.md', 'ignored');
  const result = await previewFolder(source);
  cleanup(t, result);
  assert.match(path.basename(result.tempDir), /^ai_skills_preview_/);
  assert.equal(result.cloneDir, path.join(result.tempDir, 'repo'));
  assert.equal(result.gitUrl, '');
  assert.equal(result.sourceType, 'local');
  assert.deepEqual(result.local, { kind: 'folder', originalPath: source });
  assert.deepEqual(result.skills, [
    { name: 'selected-name', path: '.', description: 'Root description continued' },
    { name: 'child', path: 'nested/child', description: 'Nested description' }
  ]);
  assert.equal(await fs.readFile(path.join(result.cloneDir, 'readme.txt'), 'utf8'), 'readme');
  assert.equal(await fs.readFile(path.join(source, 'readme.txt'), 'utf8'), 'readme');
  await fs.rm(source, { recursive: true });
  assert.equal(await fs.readFile(path.join(result.cloneDir, 'nested/child/assets/example.txt'), 'utf8'), 'asset');
  await assert.rejects(fs.stat(path.join(result.cloneDir, '.GIT')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(result.cloneDir, 'node_modules')), { code: 'ENOENT' });
});

test('no-skills and failed snapshots clean up only their own temporary directories', async t => {
  const root = await fixture(t);
  await write(root, 'README.md', 'keep');
  const mkdtemp = fs.mkdtemp.bind(fs);
  const created = [];
  t.mock.method(fs, 'mkdtemp', async prefix => { const result = await mkdtemp(prefix); created.push(result); return result; });
  await assert.rejects(previewFolder(root), { code: 'NO_SKILLS' });
  assert.equal(created.length, 1);
  await assert.rejects(fs.stat(created[0]), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(root, 'README.md'), 'utf8'), 'keep');
});

test('rejects invalid selection types and non-ZIP extensions', async t => {
  const root = await fixture(t);
  const file = await write(root, 'SKILL.md', '# skill');
  await assert.rejects(previewFolder(file), { code: 'UNSAFE_LOCAL_PATH' });
  await assert.rejects(previewFolder(''), { code: 'INVALID_LOCAL_PATH' });
  await assert.rejects(previewZip(file), { code: 'INVALID_LOCAL_FILE' });
  await assert.rejects(previewZip(root + '.zip'), { code: 'ENOENT' });
});

test('rejects selected directory links and descendant directory links', async t => {
  const root = await fixture(t);
  const source = path.join(root, 'source');
  await write(source, 'SKILL.md', '# skill');
  const alias = path.join(root, 'alias');
  if (!await link(t, source, alias, 'junction')) return;
  await assert.rejects(previewFolder(alias), { code: 'UNSAFE_LOCAL_PATH' });
  await fs.symlink(source, path.join(source, 'cycle'), 'junction');
  await assert.rejects(previewFolder(source), { code: 'UNSAFE_LOCAL_PATH' });
});

test('allows ancestor directory aliases while preserving the selected folder name', async t => {
  const root = await fixture(t);
  const source = path.join(root, 'real');
  await write(source, 'chosen/SKILL.md', '# skill');
  const alias = path.join(root, 'alias');
  if (!await link(t, source, alias, 'junction')) return;
  const result = await previewFolder(path.join(alias, 'chosen'));
  cleanup(t, result);
  assert.equal(result.skills[0].name, 'chosen');
  assert.equal(result.local.originalPath, path.join(alias, 'chosen'));
});

test('rejects descendant file links and selected ZIP links', async t => {
  const root = await fixture(t);
  const file = await write(root, 'outside.zip', 'data');
  const source = path.join(root, 'source');
  await write(source, 'SKILL.md', '# skill');
  if (!await link(t, file, path.join(source, 'linked.zip'), 'file')) return;
  await assert.rejects(previewFolder(source), { code: 'UNSAFE_LOCAL_PATH' });
  await assert.rejects(previewZip(path.join(source, 'linked.zip')), { code: 'UNSAFE_LOCAL_PATH' });
});

test('enforces directory depth and accepts exactly twelve levels', async t => {
  const root = await fixture(t);
  const nested = Array(12).fill('d').join('/');
  await write(root, `${nested}/SKILL.md`, '# deepest');
  const result = await previewFolder(root);
  cleanup(t, result);
  assert.equal(result.skills[0].path, nested);
  await fs.mkdir(path.join(root, nested, 'too-deep'));
  await assert.rejects(previewFolder(root), { code: 'LOCAL_LIMIT' });
});

test('enforces individual, cumulative folder and ZIP file byte limits', async t => {
  const root = await fixture(t);
  await write(root, 'SKILL.md', '# skill');
  await sparse(root, 'large', 10 * 1024 * 1024 + 1);
  await assert.rejects(previewFolder(root), { code: 'LOCAL_LIMIT' });
  await fs.rm(path.join(root, 'large'));
  for (let i = 0; i < 10; i++) await sparse(root, `part-${i}`, 10 * 1024 * 1024);
  await assert.rejects(previewFolder(root), { code: 'LOCAL_LIMIT' });
  const zip = path.join(await fixture(t), 'large.zip');
  await sparse(path.dirname(zip), path.basename(zip), 50 * 1024 * 1024 + 1);
  await assert.rejects(previewZip(zip), { code: 'LOCAL_LIMIT' });
});

test('counts entries before copying beyond the 20000 entry boundary', async t => {
  const root = await fixture(t);
  const realLstat = fs.lstat.bind(fs);
  const realRead = fs.open.bind(fs);
  t.mock.method(fs, 'opendir', async () => ({
    async *[Symbol.asyncIterator]() { for (let i = 0; i < 20001; i++) yield { name: `entry-${i}` }; }
  }));
  t.mock.method(fs, 'realpath', async name => name);
  t.mock.method(fs, 'lstat', async name => path.basename(name).startsWith('entry-') ? { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true, size: 0, dev: 0, ino: 0 } : realLstat(name));
  t.mock.method(fs, 'open', async (name, ...args) => path.basename(name).startsWith('entry-') ? {
    stat: async () => ({ isFile: () => true, size: 0, dev: 0, ino: 0 }),
    read: async () => ({ bytesRead: 0 }), close: async () => {}
  } : realRead(name, ...args));
  let writes = 0;
  t.mock.method(fs, 'writeFile', async () => { writes++; });
  await assert.rejects(previewFolder(root), { code: 'LOCAL_LIMIT' });
  assert.equal(writes, 20000);
});

test('ZIP import delegates archive validation and restores basename-based local metadata', async t => {
  const root = await fixture(t);
  const file = await write(root, 'local-bundle.ZIP', 'zip content');
  const release = require('./release.cjs');
  const original = Object.getOwnPropertyDescriptor(release, 'prepareArchive');
  const calls = [];
  release.prepareArchive = async (buffer, options) => {
    calls.push({ buffer, options });
    return { tempDir: 'temp', cloneDir: 'repo', skills: [{ name: 'metadata-name', path: '.', description: 'root' }, { name: 'metadata-child', path: 'nested/child', description: 'child' }] };
  };
  t.after(() => { if (original) Object.defineProperty(release, 'prepareArchive', original); else delete release.prepareArchive; });
  const result = await previewZip(file);
  assert.equal(calls[0].buffer.toString(), 'zip content');
  assert.equal(calls[0].options.name, 'local-bundle');
  assert.deepEqual(result, { tempDir: 'temp', cloneDir: 'repo', skills: [{ name: 'local-bundle', path: '.', description: 'root' }, { name: 'child', path: 'nested/child', description: 'child' }], gitUrl: '', local: { kind: 'zip', originalPath: file }, sourceType: 'local' });
});

test('shared archive helper handles real local ZIP snapshots and rejects traversal', async t => {
  if (typeof require('./release.cjs').prepareArchive !== 'function') { t.skip('Waiting for shared release prepareArchive export.'); return; }
  const root = await fixture(t);
  const zip = new JSZip();
  zip.file('SKILL.md', '---\nname: metadata-name\n---\n# root');
  zip.file('nested/child/SKILL.md', '# nested');
  const file = await write(root, 'bundle.zip', await zip.generateAsync({ type: 'nodebuffer' }));
  const result = await previewZip(file);
  cleanup(t, result);
  assert.equal(result.skills.find(skill => skill.path === '.').name, 'bundle');
  assert.equal(result.skills.find(skill => skill.path === 'nested/child').name, 'child');
  await fs.rm(file);
  assert.equal(await fs.readFile(path.join(result.cloneDir, 'SKILL.md'), 'utf8'), '---\nname: metadata-name\n---\n# root');
  const unsafe = new JSZip();
  unsafe.file('../SKILL.md', '# escaped', { createFolders: false });
  await write(root, 'unsafe.zip', await unsafe.generateAsync({ type: 'nodebuffer' }));
  await assert.rejects(previewZip(path.join(root, 'unsafe.zip')), { code: 'UNSAFE_ARCHIVE' });
});
