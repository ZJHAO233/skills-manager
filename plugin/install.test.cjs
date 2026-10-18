'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installFolder, installFolderAsync } = require('./install.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-install-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const base = path.join(root, 'skills');
  const destination = path.join(base, 'example');
  fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), 'new');
  fs.writeFileSync(path.join(source, 'nested', 'asset.txt'), 'asset');
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, 'local.txt'), 'user changes');
  return { root, source, base, destination };
}

test('never copies Git metadata or removes installed .git, preserves old copy in backup', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.source, '.git')); fs.writeFileSync(path.join(f.source, '.git', 'config'), 'source git');
  fs.mkdirSync(path.join(f.source, 'nested', '.git')); fs.writeFileSync(path.join(f.source, 'nested', '.git', 'index'), 'nested git');
  fs.mkdirSync(path.join(f.destination, '.git')); fs.writeFileSync(path.join(f.destination, '.git', 'index'), 'old git');
  const result = installFolder(f.source, f.base, 'example');
  assert.equal(fs.existsSync(path.join(result.destination, '.git')), false);
  assert.equal(fs.existsSync(path.join(result.destination, 'nested', '.git')), false);
  assert.equal(content(result.backupPath, '.git/index'), 'old git');
  assert.equal(content(result.destination, 'SKILL.md'), 'new');
});

function injected(overrides) { return { fs: { ...fs, ...overrides } }; }
function content(folder, name) { return fs.readFileSync(path.join(folder, name), 'utf8'); }
function noStage(base) { assert.equal(fs.readdirSync(base).some(name => name.startsWith('.skill-install-')), false); }

test('synchronous replacement retains the old directory and user modifications as backup', t => {
  const f = fixture(t);
  const result = installFolder(f.source, f.base, 'example');
  assert.equal(result.destination, f.destination);
  assert.equal(content(result.destination, 'SKILL.md'), 'new');
  assert.equal(content(result.destination, 'nested/asset.txt'), 'asset');
  assert.match(path.basename(result.backupPath), /^\.skill-backup-example-/);
  assert.equal(content(result.backupPath, 'local.txt'), 'user changes');
  noStage(f.base);
});

test('creates a missing base and publishes a new installation without backup', t => {
  const f = fixture(t);
  const base = path.join(f.root, 'missing', 'skills');
  assert.deepEqual(installFolder(f.source, base, 'new'), { destination: path.join(base, 'new') });
  assert.equal(content(path.join(base, 'new'), 'SKILL.md'), 'new');
});

test('honors a junction base and ancestor junction and returns the real destination', t => {
  const f = fixture(t);
  const link = path.join(f.root, 'linked-parent');
  fs.symlinkSync(f.base, link, 'junction');
  const result = installFolder(f.source, link, 'example');
  assert.equal(result.destination, path.join(fs.realpathSync(f.base), 'example'));
  assert.equal(content(result.backupPath, 'local.txt'), 'user changes');
  const nested = installFolder(f.source, path.join(link, 'nested-base'), 'other');
  assert.equal(nested.destination, path.join(fs.realpathSync(f.base), 'nested-base', 'other'));
});

test('rejects a destination junction without touching its target', t => {
  const f = fixture(t);
  const target = path.join(f.root, 'outside');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep'), 'safe');
  fs.symlinkSync(target, path.join(f.base, 'linked'), 'junction');
  assert.throws(() => installFolder(f.source, f.base, 'linked'), /符号链接或目录联接/);
  assert.equal(content(target, 'keep'), 'safe');
  assert.ok(fs.lstatSync(path.join(f.base, 'linked')).isSymbolicLink());
  noStage(f.base);
});

test('rejects source junctions recursively before any copy', t => {
  const f = fixture(t);
  fs.symlinkSync(f.destination, path.join(f.source, 'nested', 'link'), 'junction');
  assert.throws(() => installFolder(f.source, f.base, 'example', injected({ cpSync() { assert.fail('copy must not run'); } })), /源目录不能包含/);
  assert.equal(content(f.destination, 'local.txt'), 'user changes');
  noStage(f.base);
});

test('rejects a junction as the source root', t => {
  const f = fixture(t);
  const link = path.join(f.root, 'source-link');
  fs.symlinkSync(f.source, link, 'junction');
  assert.throws(() => installFolder(link, f.base, 'example'), /源目录不能包含/);
});

test('copy failure leaves the old destination untouched and cleans partial stage', t => {
  const f = fixture(t);
  assert.throws(() => installFolder(f.source, f.base, 'example', injected({
    cpSync(source, stage) {
      fs.writeFileSync(path.join(stage, 'partial'), 'partial');
      throw Object.assign(new Error('copy failure'), { code: 'ENOSPC' });
    },
    renameSync() { assert.fail('old directory must not move'); }
  })), { code: 'ENOSPC' });
  assert.equal(content(f.destination, 'local.txt'), 'user changes');
  assert.deepEqual(fs.readdirSync(f.base), ['example']);
});

for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
  test(`${code} moving old directory preserves it and reports actual and original paths`, t => {
    const f = fixture(t);
    const link = path.join(f.root, 'base-link');
    fs.symlinkSync(f.base, link, 'junction');
    assert.throws(() => installFolder(f.source, link, 'example', injected({
      renameSync() { throw Object.assign(new Error('locked'), { code }); }
    })), error => {
      assert.equal(error.code, code);
      assert.match(error.message, /目录被占用或无访问权限/);
      assert.ok(error.message.includes(f.destination));
      assert.ok(error.message.includes(path.join(link, 'example')));
      return true;
    });
    assert.equal(content(f.destination, 'local.txt'), 'user changes');
    assert.deepEqual(fs.readdirSync(f.base), ['example']);
  });
}

test('publish failure rolls back the backup', t => {
  const f = fixture(t);
  let calls = 0;
  assert.throws(() => installFolder(f.source, f.base, 'example', injected({
    renameSync(from, to) {
      if (++calls === 2) throw Object.assign(new Error('publish failed'), { code: 'EPERM' });
      return fs.renameSync(from, to);
    }
  })), { code: 'EPERM' });
  assert.equal(calls, 3);
  assert.equal(content(f.destination, 'local.txt'), 'user changes');
  assert.deepEqual(fs.readdirSync(f.base), ['example']);
});

test('failed rollback retains and reports the recoverable backup', t => {
  const f = fixture(t);
  let calls = 0;
  assert.throws(() => installFolder(f.source, f.base, 'example', injected({
    renameSync(from, to) {
      if (++calls > 1) throw Object.assign(new Error('locked'), { code: 'EBUSY' });
      return fs.renameSync(from, to);
    }
  })), error => {
    assert.match(error.message, /恢复失败/);
    assert.equal(content(error.backupPath, 'local.txt'), 'user changes');
    assert.equal(error.rollbackError.code, 'EBUSY');
    return true;
  });
  noStage(f.base);
});

test('rejects unsafe and reserved names and file destinations', t => {
  const f = fixture(t);
  for (const name of ['', '.', '..', '../escape', 'a/b', 'a\\b', 'C:drive', 'NUL', 'con.txt', 'COM1', 'LPT9.log', 'name.', 'name ', '.skill-install-any', '.skill-backup-any']) {
    assert.throws(() => installFolder(f.source, f.base, name), /安全的文件夹名称/);
  }
  fs.writeFileSync(path.join(f.base, 'file'), 'keep');
  assert.throws(() => installFolder(f.source, f.base, 'file'), /普通目录/);
  assert.equal(content(f.base, 'file'), 'keep');
});

test('rejects a base inside the source before staging', t => {
  const f = fixture(t);
  assert.throws(() => installFolder(f.source, f.source, 'example'), /不能位于源文件夹内/);
  noStage(f.source);
});

test('async installation reports completed copies and bytes, skips Git metadata and retains backup', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.source, '.git'));
  fs.writeFileSync(path.join(f.source, '.git', 'config'), 'excluded');
  fs.mkdirSync(path.join(f.source, 'nested', '.GIT'));
  fs.writeFileSync(path.join(f.source, 'nested', '.GIT', 'index'), 'excluded');
  fs.mkdirSync(path.join(f.source, 'empty'));
  fs.mkdirSync(path.join(f.destination, '.git'));
  fs.writeFileSync(path.join(f.destination, '.git', 'index'), 'old git');
  const progress = [];
  const result = await installFolderAsync(f.source, f.base, 'example', {
    onProgress(value) {
      progress.push(value);
      const stages = fs.readdirSync(f.base).filter(name => name.startsWith('.skill-install-'));
      assert.equal(stages.length, 1);
      const stage = path.join(f.base, stages[0]);
      const copied = ['SKILL.md', 'nested/asset.txt'].filter(name => fs.existsSync(path.join(stage, name)));
      assert.equal(copied.length, value.current);
      assert.equal(copied.reduce((sum, name) => sum + fs.statSync(path.join(stage, name)).size, 0), value.bytes);
      if (progress.length > 1) assert.ok(value.bytes >= progress[progress.length - 2].bytes);
    }
  });
  assert.deepEqual(progress, [
    { stage: 'install', current: 0, total: 2, bytes: 0, totalBytes: 8 },
    { stage: 'install', current: 1, total: 2, bytes: progress[1].bytes, totalBytes: 8 },
    { stage: 'install', current: 2, total: 2, bytes: 8, totalBytes: 8 }
  ]);
  assert.equal(content(result.destination, 'nested/asset.txt'), 'asset');
  assert.ok(fs.statSync(path.join(result.destination, 'empty')).isDirectory());
  assert.equal(fs.existsSync(path.join(result.destination, '.git')), false);
  assert.equal(fs.existsSync(path.join(result.destination, 'nested', '.GIT')), false);
  assert.equal(content(result.backupPath, 'local.txt'), 'user changes');
  assert.equal(content(result.backupPath, '.git/index'), 'old git');
  noStage(f.base);
});

test('async installation creates missing bases and handles an empty source', async t => {
  const f = fixture(t);
  const source = path.join(f.root, 'empty');
  fs.mkdirSync(source);
  const base = path.join(f.root, 'missing', 'skills');
  const progress = [];
  assert.deepEqual(await installFolderAsync(source, base, 'new', { onProgress: value => progress.push(value) }), {
    destination: path.join(base, 'new')
  });
  assert.deepEqual(progress, [{ stage: 'install', current: 0, total: 0, bytes: 0, totalBytes: 0 }]);
  noStage(base);
});

test('async installation honors base junctions and existing Windows casing', async t => {
  const f = fixture(t);
  const link = path.join(f.root, 'linked-base');
  fs.symlinkSync(f.base, link, 'junction');
  const name = process.platform === 'win32' ? 'EXAMPLE' : 'example';
  const result = await installFolderAsync(f.source, link, name);
  assert.equal(result.destination, path.join(fs.realpathSync(f.base), 'example'));
  assert.equal(content(result.backupPath, 'local.txt'), 'user changes');
});

test('async installation rejects unsafe names, nested bases and source or destination junctions', async t => {
  const f = fixture(t);
  for (const name of ['', '..', '../escape', 'NUL', 'name.', '.skill-install-any', '.skill-backup-any']) {
    await assert.rejects(installFolderAsync(f.source, f.base, name), /安全的文件夹名称/);
  }
  await assert.rejects(installFolderAsync(f.source, f.source, 'example'), /不能位于源文件夹内/);
  const link = path.join(f.base, 'linked');
  fs.symlinkSync(f.destination, link, 'junction');
  await assert.rejects(installFolderAsync(f.source, f.base, 'linked'), /普通目录/);
  const sourceLink = path.join(f.root, 'source-link');
  fs.symlinkSync(f.source, sourceLink, 'junction');
  await assert.rejects(installFolderAsync(sourceLink, f.base, 'example'), /源目录不能包含/);
  fs.symlinkSync(f.destination, path.join(f.source, 'nested', 'link'), 'junction');
  await assert.rejects(installFolderAsync(f.source, f.base, 'example'), /源目录不能包含/);
  assert.equal(content(f.destination, 'local.txt'), 'user changes');
  noStage(f.base);
});

test('async progress failure preserves the old destination and cleans staging', async t => {
  const f = fixture(t);
  await assert.rejects(installFolderAsync(f.source, f.base, 'example', {
    onProgress({ current }) { if (current === 1) throw new Error('progress failed'); }
  }), /progress failed/);
  assert.equal(content(f.destination, 'local.txt'), 'user changes');
  assert.deepEqual(fs.readdirSync(f.base), ['example']);
});

test('async publish failure rolls back the old directory using real filesystem operations', async t => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep'), 'safe');
  let changed = false;
  await assert.rejects(installFolderAsync(f.source, f.base, 'example', {
    onProgress({ current, total }) {
      if (current !== total) return;
      const stage = fs.readdirSync(f.base).find(name => name.startsWith('.skill-install-'));
      fs.renameSync(path.join(f.base, stage), path.join(outside, 'staged'));
      changed = true;
    }
  }), { code: 'ENOENT' });
  assert.ok(changed);
  assert.equal(content(f.destination, 'local.txt'), 'user changes');
  assert.equal(content(outside, 'keep'), 'safe');
  assert.deepEqual(fs.readdirSync(f.base), ['example']);
});

test('matches existing destination casing on Windows', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  fs.renameSync(f.destination, path.join(f.base, 'Example'));
  const result = installFolder(f.source, f.base, 'EXAMPLE');
  assert.equal(path.basename(result.destination), 'Example');
  assert.equal(content(result.backupPath, 'local.txt'), 'user changes');
});
