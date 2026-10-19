'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createAssociations } = require('./association.cjs');

async function fixture(t, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-association-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const localPath = path.join(dir, 'installed-name');
  await fs.mkdir(localPath);
  await fs.writeFile(path.join(localPath, 'SKILL.md'), 'original skill');
  const state = { skills: [{ localPath, name: 'local', description: 'keep' }], registry: [], previews: [], cleaned: [], invalidations: 0 };
  const options = {
    getSkills: async () => state.skills,
    previewRepo: async repo => { state.previews.push(repo); return { tempDir: 'mock-clone', skills: [{ name: 'remote', path: 'skills/remote' }, { name: 'root', path: '.' }] }; },
    loadRegistry: async () => structuredClone(state.registry),
    saveRegistry: async registry => { state.registry = registry; },
    invalidate: () => { state.invalidations++; },
    cleanup: async dir => { state.cleaned.push(dir); },
    ...overrides
  };
  return { dir, localPath, state, api: createAssociations(options), options, metadata: () => fs.readFile(path.join(localPath, 'metadata.json'), 'utf8') };
}

test('preview caches only issued candidates, normalizes repository, and cleans clone', async t => {
  const f = await fixture(t);
  const preview = await f.api.preview(f.localPath, 'owner/repo.git');
  assert.match(preview.token, /^[a-f0-9-]{36}$/);
  assert.deepEqual(f.state.previews, ['https://github.com/owner/repo']);
  assert.deepEqual(f.state.cleaned, ['mock-clone']);
  preview.skills[0].path = 'unissued';
  await assert.rejects(f.api.commit(preview.token, 'unissued'), /Unknown selected/);
  await assert.rejects(f.api.commit(preview.token, '../outside'), /Unknown selected/);
  await assert.rejects(f.api.commit('unknown', '.'), /token/);
  await f.api.commit(preview.token, 'skills/remote');
  await assert.rejects(f.api.commit(preview.token, '.'), /token/);
});

test('persists scanned skill without changing installed files or folder name', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.localPath, 'metadata.json'), JSON.stringify({ name: 'keep-name', custom: 3, release: { tag: 'old' } }));
  const p = await f.api.preview(f.localPath, 'https://github.com/owner/repo/');
  const entry = await f.api.commit(p.token, '.');
  assert.equal(entry.localPath, f.localPath);
  assert.match(entry.id, /^[a-f0-9-]{36}$/);
  assert.equal(entry.description, 'keep');
  assert.equal(entry.sourceUrl, 'https://github.com/owner/repo');
  assert.equal(entry.sourcePath, '.');
  assert.equal(entry.release, null);
  assert.equal(entry.associationPending, true);
  const metadata = JSON.parse(await f.metadata());
  assert.equal(metadata.name, 'keep-name');
  assert.equal(metadata.custom, 3);
  assert.equal(metadata.source_url, entry.sourceUrl);
  assert.equal(metadata.type, 'git');
  assert.equal(metadata.release, null);
  assert.equal(metadata.source_path, '.');
  assert.ok(Number.isFinite(Date.parse(metadata.associated_at)));
  assert.equal(await fs.readFile(path.join(f.localPath, 'SKILL.md'), 'utf8'), 'original skill');
  assert.equal(f.state.invalidations, 1);
  assert.deepEqual((await fs.readdir(f.localPath)).sort(), ['SKILL.md', 'metadata.json']);
});

test('updates existing registry entry while preserving unrelated fields and entries', async t => {
  const f = await fixture(t);
  f.state.registry = [{ localPath: 'other', id: 'other', untouched: 7 }, { localPath: f.localPath, id: 'existing', custom: 42 }];
  const p = await f.api.preview(f.localPath, 'owner/repo');
  await f.api.commit(p.token, 'skills/remote');
  assert.deepEqual(f.state.registry[0], { localPath: 'other', id: 'other', untouched: 7 });
  assert.equal(f.state.registry[1].id, 'existing');
  assert.equal(f.state.registry[1].custom, 42);
});

test('rejects non-root GitHub addresses before invoking preview', async t => {
  const f = await fixture(t);
  for (const repo of ['http://github.com/a/b', 'https://user@github.com/a/b', 'https://github.com/a/b?x', 'https://github.com/a/b#x', 'https://github.com/a/b/tree/main', 'https://github.com.evil/a/b', 'https://github.com:443/a/b', 'a/../b', 'a/b\\c', 'a/.', 'a/..', '', null]) {
    await assert.rejects(f.api.preview(f.localPath, repo), /Invalid GitHub/);
  }
  assert.deepEqual(f.state.previews, []);
});

test('rejects unknown skills at preview and removed or changed identity at commit', async t => {
  const f = await fixture(t);
  await assert.rejects(f.api.preview(f.dir, 'owner/repo'), /Unknown skill/);
  await assert.rejects(f.api.preview('relative', 'owner/repo'), /Unknown skill/);
  const p = await f.api.preview(f.localPath, 'owner/repo');
  f.state.skills = [];
  await assert.rejects(f.api.commit(p.token, '.'), /Unknown skill/);
  f.state.skills = [{ localPath: f.localPath, id: 'old' }];
  const second = await f.api.preview(f.localPath, 'owner/repo');
  f.state.skills[0].id = 'new';
  await assert.rejects(f.api.commit(second.token, '.'), /identity changed/);
});

test('tokens expire after ten minutes', async t => {
  const f = await fixture(t);
  const p = await f.api.preview(f.localPath, 'owner/repo');
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 600001);
  await assert.rejects(f.api.commit(p.token, '.'), /expired/);
});

for (const phase of ['preview', 'commit']) test('rejects root directory replacement during ' + phase, async t => {
  const f = await fixture(t);
  const replace = async () => { await fs.rename(f.localPath, path.join(f.dir, 'old')); await fs.mkdir(f.localPath); };
  if (phase === 'preview') {
    f.options.previewRepo = async () => { await replace(); return { tempDir: 'clone', skills: [{ path: '.' }] }; };
    await assert.rejects(createAssociations(f.options).preview(f.localPath, 'owner/repo'), /root changed/);
    assert.deepEqual(f.state.cleaned, ['clone']);
  } else {
    const p = await f.api.preview(f.localPath, 'owner/repo');
    await replace();
    await assert.rejects(f.api.commit(p.token, '.'), /root changed/);
  }
});

test('allows existing junction mapping but rejects retargeting after preview', async t => {
  const f = await fixture(t);
  const link = path.join(f.dir, 'mapped');
  await fs.symlink(f.localPath, link, 'junction');
  f.state.skills = [{ localPath: link }];
  const p = await f.api.preview(link, 'owner/repo');
  await f.api.commit(p.token, '.');
  const second = await f.api.preview(link, 'owner/repo');
  const other = path.join(f.dir, 'other'); await fs.mkdir(other);
  await fs.unlink(link); await fs.symlink(other, link, 'junction');
  await assert.rejects(f.api.commit(second.token, '.'), /root changed/);
});

for (const existing of [false, true]) test('restores metadata after registry failure, existing=' + existing, async t => {
  const f = await fixture(t, { saveRegistry: async () => { throw new Error('registry failed'); } });
  const original = '{ "custom": "unchanged" }\n';
  if (existing) await fs.writeFile(path.join(f.localPath, 'metadata.json'), original);
  const p = await f.api.preview(f.localPath, 'owner/repo');
  await assert.rejects(f.api.commit(p.token, '.'), /registry failed/);
  if (existing) assert.equal(await f.metadata(), original);
  else await assert.rejects(f.metadata(), { code: 'ENOENT' });
  assert.equal(f.state.invalidations, 0);
  assert.equal((await fs.readdir(f.localPath)).some(name => name.endsWith('.tmp')), false);
});

test('cleanup failures neither mask discovery errors nor invalidate a successful token', async t => {
  const f = await fixture(t, { cleanup: async () => { throw new Error('cleanup failed'); } });
  const p = await f.api.preview(f.localPath, 'owner/repo');
  await f.api.commit(p.token, '.');
  const broken = createAssociations({ ...f.options, previewRepo: async () => ({ tempDir: 'clone', skills: [{ path: '../unsafe' }] }) });
  await assert.rejects(broken.preview(f.localPath, 'owner/repo'), /Invalid repository skill path/);
});

for (const kind of ['oversized', 'directory', 'invalid-json', 'array', 'symlink']) test('rejects unsafe metadata: ' + kind, async t => {
  const f = await fixture(t);
  const file = path.join(f.localPath, 'metadata.json');
  if (kind === 'oversized') await fs.writeFile(file, Buffer.alloc(1048577));
  if (kind === 'directory') await fs.mkdir(file);
  if (kind === 'invalid-json') await fs.writeFile(file, '{');
  if (kind === 'array') await fs.writeFile(file, '[]');
  if (kind === 'symlink') {
    const outside = path.join(f.dir, 'outside'); await fs.writeFile(outside, '{}');
    try { await fs.symlink(outside, file, 'file'); }
    catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('File symlink permission unavailable'); return; } throw error; }
  }
  const p = await f.api.preview(f.localPath, 'owner/repo');
  await assert.rejects(f.api.commit(p.token, '.'));
  assert.deepEqual(f.state.registry, []);
});

test('rejects substituted metadata handle before reading outside bytes', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.localPath, 'metadata.json'), '{}');
  const outside = path.join(f.dir, 'outside'); await fs.writeFile(outside, '{}');
  const open = fs.open;
  t.mock.method(fs, 'open', async () => {
    const handle = await open(outside, 'r');
    return { stat: () => handle.stat(), read: () => assert.fail('Outside metadata must not be read'), close: () => handle.close() };
  });
  const p = await f.api.preview(f.localPath, 'owner/repo');
  await assert.rejects(f.api.commit(p.token, '.'), /Metadata changed/);
  assert.deepEqual(f.state.registry, []);
});

test('atomic rename failure preserves original metadata and removes temporary file', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.localPath, 'metadata.json'), '{"original":true}');
  t.mock.method(fs, 'rename', async () => { throw new Error('rename failed'); });
  const p = await f.api.preview(f.localPath, 'owner/repo');
  await assert.rejects(f.api.commit(p.token, '.'), /rename failed/);
  assert.equal(await f.metadata(), '{"original":true}');
  assert.equal((await fs.readdir(f.localPath)).some(name => name.endsWith('.tmp')), false);
  assert.deepEqual(f.state.registry, []);
});

test('a failed commit does not block later queued commits', async t => {
  let saves = 0;
  const f = await fixture(t, { saveRegistry: async () => { if (++saves === 1) throw new Error('first failed'); } });
  const a = await f.api.preview(f.localPath, 'owner/repo');
  const b = await f.api.preview(f.localPath, 'owner/another');
  const results = await Promise.allSettled([f.api.commit(a.token, '.'), f.api.commit(b.token, '.')]);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'fulfilled');
  assert.equal(JSON.parse(await f.metadata()).source_url, 'https://github.com/owner/another');
});

test('serializes concurrent commits so both registry updates survive', async t => {
  const f = await fixture(t);
  const second = path.join(f.dir, 'second'); await fs.mkdir(second);
  f.state.skills.push({ localPath: second });
  let active = 0;
  f.options.saveRegistry = async registry => {
    assert.equal(active++, 0);
    await new Promise(resolve => setTimeout(resolve, 10));
    f.state.registry = registry; active--;
  };
  const api = createAssociations(f.options);
  const a = await api.preview(f.localPath, 'owner/repo');
  const b = await api.preview(second, 'owner/another');
  await Promise.all([api.commit(a.token, '.'), api.commit(b.token, 'skills/remote')]);
  assert.equal(f.state.registry.length, 2);
  assert.deepEqual(f.state.registry.map(item => item.localPath), [f.localPath, second]);
});
