'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const JSZip = require('./vendor/jszip.js');
test('ZIP dependency works without a global setImmediate in preload', async () => {
  const vm = require('node:vm');
  const source = await fs.readFile(path.join(__dirname, 'vendor/jszip.js'), 'utf8');
  const context = { module: { exports: {} }, exports: {}, require, Buffer, process, Promise, setTimeout, clearTimeout, Uint8Array, ArrayBuffer, console };
  vm.runInNewContext(source, context);
  assert.equal(context.setImmediate, undefined);
  const Zip = context.module.exports;
  const archive = new Zip(); archive.file('SKILL.md', 'hello');
  const buffer = await archive.generateAsync({ type: 'nodebuffer' });
  const loaded = await Zip.loadAsync(buffer);
  assert.equal(await loaded.file('SKILL.md').async('string'), 'hello');
});
const { createReleaseClient, prepareArchive } = require('./release.cjs');
const REPO = 'https://github.com/example/skills';
const URL = 'https://github.com/example/skills/releases/download/v1/skills.zip';

async function archive(files, options = {}) {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content, { createFolders: false, ...options });
  return zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX', compression: 'DEFLATE' });
}
function zip64Archive(buffer, { sentinels = false, entrySentinels = false, signature = false } = {}) {
  const end = buffer.length - 22;
  const offset = buffer.readUInt32LE(end + 16);
  const count = buffer.readUInt16LE(end + 10);
  let directory = Buffer.from(buffer.subarray(offset, end));
  if (entrySentinels) {
    assert.equal(count, 1);
    const extraStart = 46 + directory.readUInt16LE(28);
    const extra = Buffer.alloc(28);
    extra.writeUInt16LE(1, 0);
    extra.writeUInt16LE(24, 2);
    extra.writeBigUInt64LE(BigInt(directory.readUInt32LE(24)), 4);
    extra.writeBigUInt64LE(BigInt(directory.readUInt32LE(20)), 12);
    extra.writeBigUInt64LE(BigInt(directory.readUInt32LE(42)), 20);
    directory.writeUInt32LE(0xffffffff, 24);
    directory.writeUInt32LE(0xffffffff, 20);
    directory.writeUInt32LE(0xffffffff, 42);
    directory.writeUInt16LE(directory.readUInt16LE(30) + extra.length, 30);
    directory = Buffer.concat([directory.subarray(0, extraStart), extra, directory.subarray(extraStart)]);
  }
  const digital = signature ? Buffer.from([0x50, 0x4b, 0x05, 0x05, 0x02, 0x00, 0x61, 0x62]) : Buffer.alloc(0);
  const footer = offset + directory.length + digital.length;
  const record = Buffer.alloc(56);
  record.writeUInt32LE(0x06064b50, 0);
  record.writeBigUInt64LE(44n, 4);
  record.writeUInt16LE(45, 12);
  record.writeUInt16LE(45, 14);
  record.writeBigUInt64LE(BigInt(count), 24);
  record.writeBigUInt64LE(BigInt(count), 32);
  record.writeBigUInt64LE(BigInt(directory.length), 40);
  record.writeBigUInt64LE(BigInt(offset), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(footer), 8);
  locator.writeUInt32LE(1, 16);
  const classic = Buffer.from(buffer.subarray(end));
  classic.writeUInt32LE(directory.length, 12);
  if (sentinels) {
    classic.writeUInt16LE(0xffff, 8);
    classic.writeUInt16LE(0xffff, 10);
    classic.writeUInt32LE(0xffffffff, 12);
    classic.writeUInt32LE(0xffffffff, 16);
  }
  return Buffer.concat([buffer.subarray(0, offset), directory, digital, record, locator, classic]);
}
function fixture(buffer, overrides = {}) {
  const asset = { id: 42, name: 'skills.zip', size: buffer.length, browser_download_url: URL, ...overrides };
  const calls = [];
  const records = [{ tag_name: 'v1', name: 'Version 1', assets: [asset] }];
  const client = createReleaseClient({
    requestJSON: async url => { calls.push(['json', url]); return records; },
    download: async (url, progress) => { calls.push(['download', url]); if (progress) progress({ type: 'info', text: 'download' }); return buffer; }
  });
  return { client, calls, records, asset };
}
async function preview(files, inspect, options) {
  const { client } = fixture(await archive(files, options));
  const result = await client.prepare(REPO, 42);
  try { await inspect(result); } finally { await fs.rm(result.tempDir, { recursive: true, force: true }); }
}

test('local archives retain discovery metadata, fallback names and preview shape without network', async t => {
  t.mock.method(require('node:https'), 'get', () => { throw new Error('Unexpected network request'); });
  for (const options of [undefined, { name: 'chosen-name' }]) {
    const events = [];
    const result = await prepareArchive(await archive({
      'bundle/SKILL.md': '# root',
      'bundle/nested/SKILL.md': '# nested',
      'bundle/named/SKILL.md': '---\nname: Metadata name\ndescription: Saved description\n---\n'
    }), { ...options, onProgress: event => { events.push(event); throw new Error('UI failed'); } });
    try {
      assert.deepEqual(Object.keys(result).sort(), ['tempDir', 'cloneDir', 'skills', 'gitUrl'].sort());
      assert.equal(result.gitUrl, '');
      assert.deepEqual(result.skills, [
        { name: options ? options.name : 'local-skill', description: '', path: '.' },
        { name: 'nested', description: '', path: 'nested' },
        { name: 'Metadata name', description: 'Saved description', path: 'named' }
      ]);
      assert.equal(await fs.readFile(path.join(result.cloneDir, 'SKILL.md'), 'utf8'), '# root');
      assert.equal(events.length, 3);
      assert.ok(events.every(event => event.stage === 'extract' && typeof event.text === 'string'));
    } finally { await fs.rm(result.tempDir, { recursive: true, force: true }); }
  }
});

test('local archives without skills reject and remove their temporary preview', async t => {
  const remove = fs.rm;
  const removed = [];
  t.mock.method(fs, 'rm', async (name, options) => {
    removed.push(name);
    return remove(name, options);
  });
  await assert.rejects(prepareArchive(await archive({ 'README.md': '# no skills' })), { code: 'NO_SKILLS' });
  assert.equal(removed.length, 1);
  await assert.rejects(fs.stat(removed[0]), { code: 'ENOENT' });
});

test('local archives share safety limits and accept an abort signal', async () => {
  await assert.rejects(prepareArchive(await archive({ '../SKILL.md': '# unsafe' })), { code: 'UNSAFE_ARCHIVE' });
  await assert.rejects(prepareArchive(Buffer.alloc(50 * 1024 * 1024 + 1)), { code: 'DOWNLOAD_TOO_LARGE' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(prepareArchive(await archive({ 'SKILL.md': '# skill' }), { signal: controller.signal }), { code: 'CANCELLED' });
});

test('no-skills release preserves discovery error when cleanup rejects and warning callback throws', async t => {
  const { client } = fixture(await archive({ 'README.md': '# Plugin repository' }));
  const remove = fs.rm;
  const cleanupCalls = [];
  const mocked = t.mock.method(fs, 'rm', async (name, options) => {
    cleanupCalls.push([name, options]);
    throw Object.assign(new Error('cleanup denied'), { code: 'EPERM' });
  });
  const warnings = [];
  try {
    await assert.rejects(client.prepare(REPO, 42, event => {
      if (event.text.includes('[警告]')) { warnings.push(event.text); throw new Error('UI failed'); }
    }), error => error.code === 'NO_SKILLS' && /No SKILL\.md/.test(error.message));
    assert.equal(cleanupCalls.length, 1);
    assert.deepEqual(cleanupCalls[0][1], { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes(cleanupCalls[0][0]));
  } finally {
    mocked.mock.restore();
    for (const [name] of cleanupCalls) await remove(name, { recursive: true, force: true });
  }
});

test('lists and prepares observed source snapshots for releases with no uploaded assets', async () => {
  const buffer = await archive({ 'example-abcdef/SKILL.md': '# source', 'example-abcdef/data.txt': 'data' });
  const { client, records, calls } = fixture(buffer);
  records[0].assets = [];
  records[0].zipball_url = 'https://api.github.com/repos/example/skills/zipball/v1';
  const catalog = await client.list(REPO);
  assert.deepEqual(catalog.releases[0], { tag: 'v1', name: 'Version 1', assets: [], source: { tag: 'v1', name: 'Source code (ZIP)', size: null, url: records[0].zipball_url } });
  records[0].zipball_url = 'https://codeload.github.com/example/skills/zip/abcdef';
  const events = [];
  const result = await client.prepare(REPO, { kind: 'source', tag: 'v1', url: 'https://evil.test/ignored.zip' }, event => events.push(event));
  try {
    assert.deepEqual(calls.at(-1), ['download', records[0].zipball_url]);
    assert.deepEqual(result.release, { kind: 'source', repo: 'example/skills', tag: 'v1', assetName: 'Source code (ZIP)', assetId: null });
    assert.equal(await fs.readFile(path.join(result.cloneDir, 'SKILL.md'), 'utf8'), '# source');
    assert.deepEqual(events.filter(e => e.stage === 'extract').map(e => [e.type, e.current, e.total]), [['info', 1, 2], ['info', 2, 2]]);
    assert.equal(calls.filter(c => c[0] === 'json').length, 2);
  } finally { await fs.rm(result.tempDir, { recursive: true, force: true }); }
  await assert.rejects(client.prepare(REPO, { kind: 'source', tag: 'missing' }), { code: 'UNKNOWN_ASSET' });
});

test('rejects source endpoints outside the observed repository and trusted ZIP routes', async () => {
  for (const url of ['https://evil.test/a.zip', 'http://api.github.com/repos/example/skills/zipball/v1', 'https://api.github.com/repos/other/skills/zipball/v1', 'https://api.github.com/repos/example/skills/tarball/v1', 'https://github.com/example/skills/zip/v1', 'https://codeload.github.com/example/skills/tar.gz/v1', 'https://codeload.github.com/other/skills/zip/v1', 'https://user:pass@codeload.github.com/example/skills/zip/v1', 'https://api.github.com/repos/example/skills/zipball/']) {
    const { client, records, calls } = fixture(Buffer.from('zip'));
    records[0].zipball_url = url;
    await assert.rejects(client.prepare(REPO, { kind: 'source', tag: 'v1' }), { code: 'UNSAFE_URL' });
    assert.equal(calls.some(c => c[0] === 'download'), false);
  }
});

test('source downloads retain compressed and extracted size limits', async () => {
  for (const [buffer, code] of [[Buffer.alloc(50 * 1024 * 1024 + 1), 'DOWNLOAD_TOO_LARGE'], [await archive({ '../SKILL.md': '# unsafe' }), 'UNSAFE_ARCHIVE']]) {
    const { client, records } = fixture(buffer);
    records[0].assets = [];
    records[0].zipball_url = 'https://api.github.com/repos/example/skills/zipball/v1';
    await assert.rejects(client.prepare(REPO, { kind: 'source', tag: 'v1' }), { code });
  }
});

test('download progress exposes byte counts and nullable content length', async () => {
  const https = require('node:https');
  const { EventEmitter } = require('node:events');
  const original = https.get;
  const buffer = await archive({ 'SKILL.md': '# progress' });
  try {
    for (const knownLength of [true, false]) {
      https.get = (url, options, receive) => {
        const req = new EventEmitter();
        req.setTimeout = () => {};
        req.destroy = error => req.emit('error', error);
        process.nextTick(() => {
          const res = new EventEmitter();
          res.statusCode = 200;
          res.headers = knownLength ? { 'content-length': String(buffer.length) } : {};
          receive(res);
          res.emit('data', buffer.subarray(0, 10));
          res.emit('data', buffer.subarray(10));
          res.emit('end');
          req.emit('close');
        });
        return req;
      };
      const client = createReleaseClient({ requestJSON: async () => [{ tag_name: 'v1', zipball_url: 'https://api.github.com/repos/example/skills/zipball/v1', assets: [] }] });
      const events = [];
      const result = await client.prepare(REPO, { kind: 'source', tag: 'v1' }, event => events.push(event));
      try {
        assert.deepEqual(events.filter(e => e.stage === 'download').map(e => [e.type, e.current, e.total]), [['info', 10, knownLength ? buffer.length : null], ['info', buffer.length, knownLength ? buffer.length : null]]);
        assert.equal(events.at(-1).stage, 'extract');
        assert.equal(events.at(-1).current, events.at(-1).total);
        assert.ok(events.every(e => typeof e.text === 'string'));
      } finally { await fs.rm(result.tempDir, { recursive: true, force: true }); }
    }
  } finally { https.get = original; }
});

test('extracts small ZIP64 archives with actual or sentinel EOCD and entry values', async () => {
  const original = await archive({ 'SKILL.md': '# ZIP64 skill' });
  for (const options of [{}, { sentinels: true }, { entrySentinels: true }, { sentinels: true, entrySentinels: true, signature: true }]) {
    const result = await fixture(zip64Archive(original, options)).client.prepare(REPO, 42);
    try { assert.equal(await fs.readFile(path.join(result.cloneDir, 'SKILL.md'), 'utf8'), '# ZIP64 skill'); }
    finally { await fs.rm(result.tempDir, { recursive: true, force: true }); }
  }
});

test('rejects invalid ZIP64 footer bounds, volumes, counts and unsafe uint64 values', async () => {
  const original = await archive({ 'SKILL.md': '# ZIP64 skill' });
  const changes = [
    b => b.writeUInt32LE(1, b.length - 22 - 20 + 4),
    b => b.writeUInt32LE(2, b.length - 22 - 20 + 16),
    b => b.writeBigUInt64LE(1n, b.length - 22 - 20 + 8),
    b => b.writeBigUInt64LE(2n ** 53n, b.length - 22 - 20 + 8),
    b => b.writeUInt32LE(0, b.length - 22 - 20 - 56),
    b => b.writeBigUInt64LE(43n, b.length - 22 - 20 - 56 + 4),
    b => b.writeBigUInt64LE(45n, b.length - 22 - 20 - 56 + 4),
    b => b.writeBigUInt64LE(2n ** 53n, b.length - 22 - 20 - 56 + 48),
    b => b.writeBigUInt64LE(2n, b.length - 22 - 20 - 56 + 32)
  ];
  for (const change of changes) {
    const buffer = zip64Archive(original);
    change(buffer);
    await assert.rejects(fixture(buffer).client.prepare(REPO, 42), { code: 'UNSAFE_ARCHIVE' });
  }
  const count = zip64Archive(original, { sentinels: true });
  const footer = count.length - 22 - 20 - 56;
  count.writeBigUInt64LE(20001n, footer + 24);
  count.writeBigUInt64LE(20001n, footer + 32);
  await assert.rejects(fixture(count).client.prepare(REPO, 42), { code: 'ARCHIVE_LIMIT', message: /20000/ });
});

test('validates ZIP64 entry extra lengths and sizes without weakening path checks', async () => {
  const original = await archive({ 'SKILL.md': '# ZIP64 skill' });
  for (const [relative, value, code] of [[4, 2n ** 53n, 'UNSAFE_ARCHIVE'], [4, 10485761n, 'ARCHIVE_LIMIT'], [12, 2n ** 53n, 'UNSAFE_ARCHIVE'], [20, 2n ** 53n, 'UNSAFE_ARCHIVE']]) {
    const buffer = zip64Archive(original, { entrySentinels: true });
    const central = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const extra = central + 46 + buffer.readUInt16LE(central + 28);
    buffer.writeBigUInt64LE(value, extra + relative);
    await assert.rejects(fixture(buffer).client.prepare(REPO, 42), { code });
  }
  const missing = zip64Archive(original, { entrySentinels: true });
  const central = missing.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  missing.writeUInt16LE(2, central + 46 + missing.readUInt16LE(central + 28));
  await assert.rejects(fixture(missing).client.prepare(REPO, 42), { code: 'UNSAFE_ARCHIVE' });
  await assert.rejects(fixture(zip64Archive(await archive({ '../SKILL.md': '# unsafe' }))).client.prepare(REPO, 42), { code: 'UNSAFE_ARCHIVE' });
});

test('accepts only a correctly sized digital signature gap, including ordinary ZIPs', async () => {
  const original = await archive({ 'SKILL.md': '# skill' });
  const zip64 = zip64Archive(original, { signature: true });
  const footer = zip64.length - 22 - 20 - 56;
  const ordinary = Buffer.concat([zip64.subarray(0, footer), original.subarray(original.length - 22)]);
  const result = await fixture(ordinary).client.prepare(REPO, 42);
  await fs.rm(result.tempDir, { recursive: true, force: true });
  for (const buffer of [ordinary, zip64]) {
    const signature = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x05]));
    buffer.writeUInt16LE(3, signature + 4);
    await assert.rejects(fixture(buffer).client.prepare(REPO, 42), { code: 'UNSAFE_ARCHIVE' });
  }
});

test('cancelAll aborts active requests and clears settled jobs', async () => {
  let observed;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const client = createReleaseClient({ requestJSON: async (url, { signal }) => {
    observed = signal;
    started();
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  const pending = client.list(REPO);
  const rejected = assert.rejects(pending, { code: 'CANCELLED' });
  await ready;
  await client.cancelAll();
  await rejected;
  assert.equal(observed.aborted, true);
  assert.deepEqual(await client.cancelAll(), []);
});

test('lists eligible assets from only the latest ten releases without choosing one', async () => {
  const { client, records, calls } = fixture(Buffer.from('zip'));
  records[0].assets.push(
    { id: 43, name: 'setup.exe', size: 10, browser_download_url: URL },
    { id: 45, name: 'skills-manager.zpx', size: 10, browser_download_url: URL },
    { id: 44, name: 'large.zip', size: 50 * 1024 * 1024 + 1, browser_download_url: URL }
  );
  records.push({ tag_name: 'draft', draft: true }, { tag_name: 'preview', prerelease: true });
  while (records.length < 10) records.push({ tag_name: 'old', assets: [] });
  records.push({ tag_name: 'not-requested', assets: [] });
  const result = await client.list(REPO + '.git');
  assert.equal(result.repo, 'example/skills');
  assert.equal(result.releases.length, 8);
  assert.deepEqual(result.releases[0], { tag: 'v1', name: 'Version 1', assets: [{ id: 42, name: 'skills.zip', size: 3, url: URL }] });
  assert.deepEqual(calls, [['json', 'https://api.github.com/repos/example/skills/releases?per_page=10']]);
});

test('prepare returns the old preview shape, strips one wrapping directory, and parses metadata', async () => {
  await preview({ 'bundle/SKILL.md': '---\nname: "Useful Skill"\ndescription: >\n  First line\n  second line\n---\n# Skill', 'bundle/data.txt': 'safe' }, async result => {
    assert.deepEqual(Object.keys(result).sort(), ['tempDir', 'cloneDir', 'skills', 'gitUrl', 'release'].sort());
    assert.equal(path.dirname(result.cloneDir), result.tempDir);
    assert.match(path.basename(result.tempDir), /^ai_skills_preview_/);
    assert.equal(path.dirname(result.tempDir), os.tmpdir());
    assert.deepEqual(result.skills, [{ name: 'Useful Skill', description: 'First line second line', path: '.' }]);
    assert.equal(result.gitUrl, REPO);
    assert.deepEqual(result.release, { kind: 'asset', repo: 'example/skills', tag: 'v1', assetId: 42, assetName: 'skills.zip' });
    assert.equal(await fs.readFile(path.join(result.cloneDir, 'data.txt'), 'utf8'), 'safe');
  });
});

test('finds recursive packages, excludes ignored directories, and preserves loose layout', async () => {
  await preview({ 'README.md': 'loose root', 'skills/a/SKILL.md': '# A', 'other/b/SKILL.md': '---\ndescription: "B description"\n---\n', '.git/x/SKILL.md': '# ignored', 'node_modules/x/SKILL.md': '# ignored' }, result => {
    assert.deepEqual(result.skills.map(s => s.path).sort(), ['other/b', 'skills/a']);
    assert.equal(result.skills.find(s => s.path === 'other/b').description, 'B description');
  });
});

test('re-resolves asset ID and downloads the observed GitHub URL, not a caller URL', async () => {
  const { client, asset, calls } = fixture(await archive({ 'SKILL.md': '# Skill' }));
  await client.list(REPO);
  asset.browser_download_url = 'https://release-assets.githubusercontent.com/new.zip?signature=official';
  const result = await client.prepare(REPO, 42);
  try {
    assert.equal(calls.filter(c => c[0] === 'json').length, 2);
    assert.deepEqual(calls.at(-1), ['download', asset.browser_download_url]);
  } finally { await fs.rm(result.tempDir, { recursive: true, force: true }); }
});

test('unknown assets and invalid repository URLs never download', async () => {
  const { client, calls } = fixture(Buffer.from('zip'));
  for (const id of [43, '42', URL, null]) await assert.rejects(client.prepare(REPO, id), { code: 'UNKNOWN_ASSET' });
  for (const url of ['http://github.com/a/b', 'https://evil.test/a/b', 'https://user:password@github.com/a/b', REPO + '/tree/main', REPO + '?token=secret']) {
    await assert.rejects(client.list(url), { code: 'INVALID_REPOSITORY' });
  }
  assert.equal(calls.some(c => c[0] === 'download'), false);
});

test('rejects untrusted download hosts, non-HTTPS URLs, credentials, and unexpected ports', async () => {
  for (const url of ['https://github.com.evil.test/a.zip', 'https://evil.test/a.zip', 'http://github.com/a.zip', 'https://user:pass@github.com/a.zip', 'https://github.com:444/a.zip']) {
    const { client, calls } = fixture(Buffer.from('zip'), { browser_download_url: url });
    await assert.rejects(client.prepare(REPO, 42), { code: 'UNSAFE_URL' });
    assert.equal(calls.some(c => c[0] === 'download'), false);
  }
});

test('rejects traversal, Windows names and separators, and absolute paths before extraction', async () => {
  for (const name of ['../SKILL.md', 'folder/../../SKILL.md', '/SKILL.md', 'C:/SKILL.md', 'folder\\SKILL.md', 'con/SKILL.md', 'folder./SKILL.md', 'bad /SKILL.md', 'a//SKILL.md']) {
    const { client } = fixture(await archive({ [name]: '# malicious' }));
    await assert.rejects(client.prepare(REPO, 42), { code: 'UNSAFE_ARCHIVE' }, name);
  }
});

test('rejects symlinks, case collisions, exact duplicates, and file/directory collisions', async () => {
  const symlink = fixture(await archive({ 'SKILL.md': '../../outside' }, { unixPermissions: 0o120777 }));
  await assert.rejects(symlink.client.prepare(REPO, 42), { code: 'UNSAFE_ARCHIVE' });
  const collision = fixture(await archive({ 'SKILL.md': 'a', 'skill.md': 'b' }));
  await assert.rejects(collision.client.prepare(REPO, 42), { code: 'UNSAFE_ARCHIVE' });
  await assert.rejects(fixture(await archive({ 'A/SKILL.md': 'a', 'a/other.txt': 'b' })).client.prepare(REPO, 42), { code: 'UNSAFE_ARCHIVE' });
  const duplicate = await archive({ 'SKILL.md': 'a', 'OTHER.md': 'b' });
  for (let offset = duplicate.indexOf('OTHER.md'); offset !== -1; offset = duplicate.indexOf('OTHER.md', offset + 8)) duplicate.write('SKILL.md', offset);
  await assert.rejects(fixture(duplicate).client.prepare(REPO, 42), { code: 'UNSAFE_ARCHIVE' });
  await assert.rejects(fixture(await archive({ 'a': 'file', 'a/SKILL.md': '# skill' })).client.prepare(REPO, 42), { code: 'UNSAFE_ARCHIVE' });
});

test('verifies SHA-256 when supplied and rejects altered downloads', async () => {
  const buffer = await archive({ 'SKILL.md': '# skill' });
  const digest = 'sha256:' + crypto.createHash('sha256').update(buffer).digest('hex');
  const result = await fixture(buffer, { digest }).client.prepare(REPO, 42);
  await fs.rm(result.tempDir, { recursive: true, force: true });
  for (const invalid of ['sha256:' + '0'.repeat(64), 'sha512:invalid']) await assert.rejects(fixture(buffer, { digest: invalid }).client.prepare(REPO, 42), { code: 'DIGEST_MISMATCH' });
  await assert.rejects(fixture(buffer, { size: buffer.length + 1 }).client.prepare(REPO, 42), { code: 'SIZE_MISMATCH' });
  await assert.rejects(fixture(Buffer.alloc(50 * 1024 * 1024 + 1), { size: 1 }).client.prepare(REPO, 42), { code: 'DOWNLOAD_TOO_LARGE' });
});

test('enforces declared per-file, total-size and entry-count extraction limits', async () => {
  const buffer = await archive({ 'SKILL.md': '# skill' });
  const central = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  buffer.writeUInt32LE(10 * 1024 * 1024 + 1, central + 24);
  await assert.rejects(fixture(buffer).client.prepare(REPO, 42), { code: 'ARCHIVE_LIMIT' });
  const many = {};
  for (let i = 0; i < 11; i++) many[`s${i}/SKILL.md`] = '# s';
  const total = await archive(many);
  let cursor = 0;
  while ((cursor = total.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), cursor)) !== -1) {
    total.writeUInt32LE(10 * 1024 * 1024, cursor + 24);
    cursor += 46;
  }
  await assert.rejects(fixture(total).client.prepare(REPO, 42), { code: 'ARCHIVE_LIMIT' });
  const count = await archive({ 'SKILL.md': '# s' });
  count.writeUInt16LE(20001, count.length - 22 + 10);
  await assert.rejects(fixture(count).client.prepare(REPO, 42), { code: 'ARCHIVE_LIMIT' });
});

test('extracts zero-byte files using validated central-directory sizes', async () => {
  await preview({ 'SKILL.md': '# skill', 'empty.txt': '' }, async result => {
    assert.equal((await fs.stat(path.join(result.cloneDir, 'empty.txt'))).size, 0);
  });
  const empty = await archive({ 'SKILL.md': '' });
  const result = await fixture(zip64Archive(empty, { entrySentinels: true })).client.prepare(REPO, 42);
  try { assert.equal((await fs.stat(path.join(result.cloneDir, 'SKILL.md'))).size, 0); }
  finally { await fs.rm(result.tempDir, { recursive: true, force: true }); }
  const mismatch = await archive({ 'SKILL.md': '' });
  const central = mismatch.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  mismatch.writeUInt32LE(1, central + 24);
  await assert.rejects(fixture(mismatch).client.prepare(REPO, 42), /size mismatch/);
});

test('supports legitimate archives above the previous 5000-entry cap', async () => {
  const files = { 'SKILL.md': '# skill' };
  for (let i = 0; i < 5000; i++) files[`data/${i}.txt`] = 'x';
  const result = await fixture(await archive(files)).client.prepare(REPO, 42);
  try { assert.equal((await fs.readdir(path.join(result.cloneDir, 'data'))).length, 5000); }
  finally { await fs.rm(result.tempDir, { recursive: true, force: true }); }
});

test('rejects decompression beyond declared size and cleans partial previews on failure', async () => {
  const before = new Set(await fs.readdir(os.tmpdir()));
  const buffer = await archive({ 'SKILL.md': '# skill'.repeat(1000) });
  const central = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  buffer.writeUInt32LE(1, central + 24);
  await assert.rejects(fixture(buffer).client.prepare(REPO, 42), { code: 'ARCHIVE_LIMIT' });
  await assert.rejects(fixture(await archive({ 'installer.exe': 'never executed' })).client.prepare(REPO, 42), { code: 'NO_SKILLS' });
  const added = (await fs.readdir(os.tmpdir())).filter(name => name.startsWith('ai_skills_preview_') && !before.has(name));
  assert.deepEqual(added, []);
});
