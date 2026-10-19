'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
const REPO = 'https://github.com/example/skills';
const HOME = path.resolve('/mock-home');
const TEMP = path.resolve('/mock-temp');
const RELEASE = { tag: 'v1', assetId: 42, assetName: 'skills.zip' };
const plain = value => JSON.parse(JSON.stringify(value));

function memoryFs() {
  const entries = new Map();
  const calls = [];
  const key = name => path.resolve(name);
  function mkdirSync(name) {
    name = key(name);
    const parent = path.dirname(name);
    if (parent !== name && !entries.has(parent)) mkdirSync(parent);
    entries.set(name, null);
  }
  function writeFileSync(name, data) {
    mkdirSync(path.dirname(name));
    entries.set(key(name), String(data));
    calls.push(['write', key(name)]);
  }
  function readFileSync(name) {
    if (!entries.has(key(name))) throw Object.assign(new Error('Missing mock file'), { code: 'ENOENT' });
    return entries.get(key(name));
  }
  function rmSync(name) {
    name = key(name);
    calls.push(['rm', name]);
    for (const entry of entries.keys()) {
      if (entry === name || entry.startsWith(name + path.sep)) entries.delete(entry);
    }
  }
  function cpSync(from, to) {
    from = key(from);
    to = key(to);
    assert.ok(entries.has(from), `Missing mock copy source: ${from}`);
    calls.push(['cp', from, to]);
    for (const [entry, data] of [...entries]) {
      if (entry === from || entry.startsWith(from + path.sep)) entries.set(to + entry.slice(from.length), data);
    }
  }
  function readdirSync(name, options = {}) {
    name = key(name);
    return [...entries.keys()].filter(entry => entry !== name && path.dirname(entry) === name).map(entry => {
      const basename = path.basename(entry);
      return options.withFileTypes ? { name: basename, isDirectory: () => entries.get(entry) === null } : basename;
    });
  }
  const statSync = name => {
    readFileSync(name);
    return { isDirectory: () => entries.get(key(name)) === null, mtime: new Date(0), birthtime: new Date(0) };
  };
  const mock = {
    existsSync: name => entries.has(key(name)), mkdirSync, writeFileSync, readFileSync,
    rmSync, cpSync, readdirSync, statSync,
    rm: (name, options, callback) => { rmSync(name); callback(null); },
    promises: {
      rm: async (name, options) => rmSync(name),
      access: async name => { readFileSync(name); },
      readFile: async name => readFileSync(name),
      writeFile: async (name, data) => writeFileSync(name, data),
      readdir: async (name, options) => readdirSync(name, options),
      stat: async name => statSync(name)
    }
  };
  return { mock, calls };
}

function sandbox(options = {}) {
  const disk = memoryFs();
  const calls = { list: [], prepare: [], clone: [], cancel: 0 };
  const events = [];
  const catalog = options.catalog || { releases: [{ tag: 'v1', assets: [{ id: 42, name: 'skills.zip' }] }] };
  const preview = {
    tempDir: path.join(TEMP, 'release'), cloneDir: path.join(TEMP, 'release', 'repo'),
    gitUrl: REPO, skills: [{ name: 'sample', path: 'skills/sample', description: 'Sample skill' }],
    release: { ...RELEASE }, ...options.preview
  };
  const sentinel = Object.assign(new Error('mock clone stopped'), { code: 'CANCELLED' });
  const releaseClient = {
    cancelAll: async () => [],
    list: async (...args) => {
      calls.list.push(args);
      if (options.listError) throw options.listError;
      return catalog;
    },
    prepare: async (...args) => {
      calls.prepare.push(args);
      if (options.prepareError) throw options.prepareError;
      return preview;
    }
  };
  const downloader = {
    clone: async (...args) => {
      calls.clone.push(args);
      if (options.clone) return options.clone(disk.mock, ...args);
      throw sentinel;
    },
    cancelAll: async () => { calls.cancel++; return []; }
  };
  let onEvent;
  let choiceDispatched;
  const choiceReady = new Promise(resolve => { choiceDispatched = resolve; });
  const context = vm.createContext({
    require(name) {
      if (name === 'fs') return disk.mock;
      if (name === 'path') return path;
      if (name === 'os') return { tmpdir: () => TEMP, homedir: () => HOME };
      if (name === './download.cjs') return { createDownloader: () => downloader };
      if (name === './release.cjs') return { createReleaseClient: () => releaseClient };
      if (name === './association.cjs') return {
        createAssociations: () => ({
          preview: async () => { throw new Error('Unexpected association preview'); },
          commit: async () => { throw new Error('Unexpected association commit'); }
        })
      };
      if (name === './install.cjs') return {
        async installFolderAsync(sourcePath, baseDir, safeName, { onProgress } = {}) {
          const destination = path.join(baseDir, safeName);
          if (onProgress) onProgress({ stage: 'copy', current: 0, total: 1 });
          await Promise.resolve();
          disk.mock.cpSync(sourcePath, destination, { recursive: true });
          if (onProgress) onProgress({ stage: 'copy', current: 1, total: 1 });
          return { destination };
        }
      };
      throw new Error(`Unexpected sandbox require: ${name}`);
    },
    process: { env: { USERPROFILE: HOME, HOME, TEMP, TMP: TEMP }, platform: 'win32' },
    console: { log() {}, warn() {}, error() {} },
    CustomEvent: class CustomEvent {
      constructor(type, options) { this.type = type; this.detail = options.detail; }
    },
    window: { dispatchEvent(event) {
      events.push(event);
      if (event.type === 'skill-release-choice') choiceDispatched(event);
      if (onEvent) onEvent(event);
      return true;
    } }
  });
  vm.runInContext(source, context, { filename: 'preload.js' });
  const api = context.window.preloadAPI;
  function seed(skills) {
    context.fixtureSkills = skills;
    vm.runInContext('MEM_REGISTRY = fixtureSkills; CACHED_SKILLS = fixtureSkills;', context);
    delete context.fixtureSkills;
  }
  function choose(type, assetId = 42) {
    onEvent = event => {
      if (event.type === 'skill-release-choice') api.resolveReleaseChoice({ type, assetId });
    };
  }
  function releaseSkill(overrides = {}) {
    return { id: 'sample-id', name: 'sample', localPath: path.join(HOME, '.claude', 'skills', 'sample'),
      sourceUrl: REPO, description: 'Sample skill', release: { ...RELEASE }, ...overrides };
  }
  function materializePreview() {
    for (const skill of preview.skills) {
      const dir = skill.path === '.' ? preview.cloneDir : path.join(preview.cloneDir, skill.path);
      disk.mock.writeFileSync(path.join(dir, 'SKILL.md'), '# Sample');
    }
  }
  return { api, calls, disk, events, context, catalog, preview, sentinel, seed, choose, choiceReady, releaseSkill, materializePreview };
}

test('loading preload only exposes APIs without filesystem or download activity', () => {
  const fixture = sandbox();
  assert.equal(typeof fixture.api.previewSkills, 'function');
  assert.equal(typeof fixture.api.resolveReleaseChoice, 'function');
  assert.deepEqual(fixture.calls, { list: [], prepare: [], clone: [], cancel: 0 });
  assert.deepEqual(fixture.disk.calls, []);
  assert.deepEqual(fixture.events, []);
});

test('release choice event is dispatched before preparing the explicitly selected asset', async () => {
  const fixture = sandbox();
  const receivedProgress = [];
  const progress = event => receivedProgress.push(event);
  fixture.choose('release');
  assert.equal(await fixture.api.previewSkills(REPO, progress), fixture.preview);
  assert.equal(fixture.events[0].type, 'skill-release-choice');
  assert.equal(fixture.events[0].detail, fixture.catalog);
  assert.deepEqual(fixture.calls.list, [[REPO]]);
  assert.deepEqual(fixture.calls.prepare.map(args => args.slice(0, 2)), [[REPO, 42]]);
  const downloadProgress = { stage: 'download', current: 1, total: 2 };
  fixture.calls.prepare[0][2](downloadProgress);
  assert.deepEqual(receivedProgress, []);
  assert.equal(fixture.events.at(-1).type, 'skill-task-progress');
  assert.deepEqual(plain(fixture.events.at(-1).detail), downloadProgress);
  assert.deepEqual(fixture.calls.clone, []);
  assert.deepEqual(fixture.events.filter(event => event.type === 'skill-download-state').map(event => plain(event.detail)), [{ active: true }, { active: false }]);
});

test('only an explicit source choice invokes the source downloader', async () => {
  const fixture = sandbox();
  fixture.choose('source');
  await assert.rejects(fixture.api.previewSkills(REPO), error => error === fixture.sentinel);
  assert.equal(fixture.calls.clone.length, 1);
  assert.equal(fixture.calls.clone[0][0], REPO + '.git');
  assert.ok(fixture.calls.clone[0][1].startsWith(TEMP + path.sep));
  assert.deepEqual(fixture.calls.prepare, []);
});

for (const cleanupFails of [false, true]) {
  test(`source without SKILL.md preserves discovery error when cleanup ${cleanupFails ? 'rejects' : 'succeeds'}`, async () => {
    const fixture = sandbox({ clone(mockFs, gitUrl, cloneDir) {
      mockFs.writeFileSync(path.join(cloneDir, 'README.md'), '# Plugin, not a skill repository');
    } });
    const cleanupCalls = [];
    const remove = fixture.disk.mock.promises.rm;
    fixture.disk.mock.rmSync = () => { throw Object.assign(new Error('sync cleanup denied'), { code: 'EPERM' }); };
    fixture.disk.mock.promises.rm = async (name, options) => {
      cleanupCalls.push([name, plain(options)]);
      if (cleanupFails) throw Object.assign(new Error('async cleanup denied'), { code: 'EPERM' });
      await remove(name, options);
    };
    const warnings = [];
    fixture.choose('source');
    await assert.rejects(fixture.api.previewSkills(REPO, event => {
      if (event.text.includes('[警告]')) { warnings.push(event.text); throw new Error('UI callback failed'); }
    }), /未发现任何 SKILL\.md/);
    assert.equal(cleanupCalls.length, 1);
    assert.deepEqual(cleanupCalls[0][1], { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    assert.equal(warnings.length, cleanupFails ? 1 : 0);
    if (cleanupFails) assert.ok(warnings[0].includes(cleanupCalls[0][0]));
  });
}

test('source cleanup preserves clone error identity and skips running processes', async () => {
  for (const code of ['CANCELLED', 'PROCESS_STILL_RUNNING']) {
    const error = Object.assign(new Error('original clone failure'), { code });
    const fixture = sandbox({ clone() { throw error; } });
    let cleanups = 0;
    fixture.disk.mock.promises.rm = async () => { cleanups++; throw new Error('cleanup denied'); };
    fixture.choose('source');
    await assert.rejects(fixture.api.previewSkills(REPO), actual => actual === error);
    assert.equal(cleanups, code === 'PROCESS_STILL_RUNNING' ? 0 : 1);
  }
});

test('cancel choice rejects preview without preparing or cloning', async () => {
  const fixture = sandbox();
  fixture.choose('cancel');
  await assert.rejects(fixture.api.previewSkills(REPO), /已取消下载/);
  assert.deepEqual(fixture.calls.prepare, []);
  assert.deepEqual(fixture.calls.clone, []);
});

for (const queryFails of [false, true]) {
  test(`preview waits for explicit choice when catalog ${queryFails ? 'query fails' : 'is empty'}`, async () => {
    const fixture = sandbox({ catalog: { releases: [] }, listError: queryFails ? new Error('offline') : undefined });
    const progress = [];
    let settled = false;
    const pending = fixture.api.previewSkills(REPO, event => progress.push(event));
    const rejection = assert.rejects(pending, /已取消下载/);
    pending.then(() => { settled = true; }, () => { settled = true; });
    await fixture.choiceReady;
    assert.equal(settled, false);
    assert.equal(fixture.events[0].type, 'skill-release-choice');
    assert.equal(fixture.events[0].detail.releases.length, 0);
    assert.equal(progress.length, queryFails ? 1 : 0);
    assert.deepEqual(fixture.calls.clone, []);
    assert.deepEqual(fixture.calls.prepare, []);
    fixture.api.resolveReleaseChoice({ type: 'cancel' });
    await rejection;
  });
}

test('failed release preparation clears download state and never falls back to source', async () => {
  const error = new Error('bad release archive');
  const fixture = sandbox({ prepareError: error });
  fixture.choose('release');
  await assert.rejects(fixture.api.previewSkills(REPO), actual => actual === error);
  assert.deepEqual(fixture.calls.clone, []);
  assert.equal(fixture.events.at(-1).detail.active, false);
});

test('installFromPreview preserves release identity in metadata and registry', async () => {
  const fixture = sandbox();
  fixture.seed([]);
  fixture.materializePreview();
  assert.equal(await fixture.api.installFromPreview(fixture.preview, ['sample'], ['claudecode'], REPO), true);
  const copyProgress = fixture.events.filter(event => event.type === 'skill-task-progress' && event.detail.stage === 'copy' && typeof event.detail.current === 'number');
  assert.equal(copyProgress.length, 2);
  assert.equal(copyProgress.at(-1).detail.current, 1);
  assert.equal(copyProgress.at(-1).detail.label, 'sample');
  const finalDir = path.join(HOME, '.claude', 'skills', 'sample');
  const metadata = JSON.parse(fixture.disk.mock.readFileSync(path.join(finalDir, 'metadata.json')));
  const registry = JSON.parse(fixture.disk.mock.readFileSync(path.join(HOME, '.ai-skills-manager', 'registry.json')));
  assert.equal(metadata.type, 'release');
  assert.deepEqual(metadata.release, RELEASE);
  assert.deepEqual(registry[0].release, RELEASE);
  assert.equal(registry[0].sourceUrl, REPO);
  assert.equal(registry[0].localPath, finalDir);
  assert.equal(fixture.disk.mock.readFileSync(path.join(finalDir, 'SKILL.md')), '# Sample');
  const reloaded = await fixture.api.getSkillsList();
  assert.deepEqual(plain(reloaded[0].release), RELEASE);
  assert.deepEqual(fixture.calls.clone, []);
});

test('local root preview installs as unhosted local metadata and registry entry', async () => {
  const local = { kind: 'folder', path: path.join(HOME, 'imports', 'sample') };
  const fixture = sandbox({ preview: {
    local, release: null, gitUrl: '',
    skills: [{ name: 'sample', path: '.', description: 'Local sample skill' }]
  } });
  fixture.seed([]);
  fixture.materializePreview();
  assert.equal(await fixture.api.installFromPreview(fixture.preview, ['sample'], ['claudecode'], ''), true);
  const destination = path.join(HOME, '.claude', 'skills', 'sample');
  const metadata = JSON.parse(fixture.disk.mock.readFileSync(path.join(destination, 'metadata.json')));
  const registry = JSON.parse(fixture.disk.mock.readFileSync(path.join(HOME, '.ai-skills-manager', 'registry.json')));
  assert.equal(metadata.type, 'local');
  assert.equal(metadata.source_url, '本地/未托管');
  assert.equal(metadata.release, null);
  assert.deepEqual(metadata.local_import, local);
  assert.equal(registry[0].sourceUrl, '本地/未托管');
  assert.equal(registry[0].release, null);
  assert.deepEqual(registry[0].localImport, local);
  assert.equal(registry[0].localPath, destination);
  assert.equal(fixture.disk.mock.readFileSync(path.join(destination, 'SKILL.md')), '# Sample');
  assert.deepEqual(fixture.calls.list, []);
  assert.deepEqual(fixture.calls.prepare, []);
  assert.deepEqual(fixture.calls.clone, []);
});

test('same release tag and asset short-circuit update without preparation or clone', async () => {
  const fixture = sandbox();
  fixture.seed([fixture.releaseSkill()]);
  assert.deepEqual(plain(await fixture.api.updateSkill('sample-id')), { status: 'current', version: 'v1' });
  assert.deepEqual(fixture.calls.list, [[REPO]]);
  assert.deepEqual(fixture.calls.prepare, []);
  assert.deepEqual(fixture.calls.clone, []);
});

for (const [tag, id] of [['v2', 42], ['v1', 43]]) {
  test(`release update prepares when tag or asset changes (${tag}, ${id})`, async () => {
    const nextRelease = { tag, assetId: id, assetName: 'skills.zip' };
    const fixture = sandbox({ catalog: { releases: [{ tag, assets: [{ id, name: 'skills.zip' }] }] },
      preview: { release: nextRelease } });
    fixture.seed([fixture.releaseSkill()]);
    fixture.materializePreview();
    assert.equal(await fixture.api.updateSkill('sample-id'), true);
    assert.deepEqual(fixture.calls.prepare.map(args => args.slice(0, 2)), [[REPO, id]]);
    assert.equal(typeof fixture.calls.prepare[0][2], 'function');
    assert.deepEqual(fixture.calls.clone, []);
    const registry = JSON.parse(fixture.disk.mock.readFileSync(path.join(HOME, '.ai-skills-manager', 'registry.json')));
    assert.equal(registry[0].id, 'sample-id');
    assert.deepEqual(registry[0].release, nextRelease);
    assert.equal(fixture.disk.mock.existsSync(fixture.preview.tempDir), false);
  });
}

test('missing matching release asset rejects rather than converting to Git', async () => {
  const fixture = sandbox({ catalog: { releases: [{ tag: 'v2', assets: [{ id: 43, name: 'other.zip' }] }] } });
  fixture.seed([fixture.releaseSkill()]);
  await assert.rejects(fixture.api.updateSkill('sample-id'), /不会自动切换/);
  assert.deepEqual(fixture.calls.prepare, []);
  assert.deepEqual(fixture.calls.clone, []);
});

test('batch release updates use the release update path and report failures without cloning', async () => {
  const fixture = sandbox();
  fixture.seed([fixture.releaseSkill(), fixture.releaseSkill({ id: 'missing-asset', release: { ...RELEASE, assetName: 'missing.zip' } })]);
  const result = plain(await fixture.api.batchUpdateSkills(['sample-id', 'missing-asset']));
  assert.deepEqual(result.success, ['sample-id']);
  assert.equal(result.failed[0].id, 'missing-asset');
  assert.match(result.failed[0].error, /不会自动切换/);
  assert.deepEqual(fixture.calls.list, [[REPO], [REPO]]);
  assert.deepEqual(fixture.calls.prepare, []);
  assert.deepEqual(fixture.calls.clone, []);
});

test('source snapshot update selects the latest tag, not a same-name asset', async () => {
  const nextRelease = { kind: 'source', tag: 'v2', assetId: null, assetName: 'Source code (ZIP)' };
  const fixture = sandbox({
    catalog: { releases: [{ tag: 'v2', source: { tag: 'v2', name: 'Source code (ZIP)' },
      assets: [{ id: 99, name: 'Source code (ZIP)' }] }] },
    preview: { release: nextRelease }
  });
  fixture.seed([fixture.releaseSkill({ release: { ...nextRelease, tag: 'v1' } })]);
  fixture.materializePreview();
  assert.equal(await fixture.api.updateSkill('sample-id'), true);
  assert.deepEqual(plain(fixture.calls.prepare.map(args => args.slice(0, 2))), [[REPO, { kind: 'source', tag: 'v2' }]]);
  assert.equal(typeof fixture.calls.prepare[0][2], 'function');
  assert.deepEqual(fixture.calls.clone, []);
  const metadata = JSON.parse(fixture.disk.mock.readFileSync(path.join(HOME, '.claude', 'skills', 'sample', 'metadata.json')));
  assert.deepEqual(metadata.release, nextRelease);
});

test('unchanged source snapshot tag avoids preparing a same-name asset', async () => {
  const release = { kind: 'source', tag: 'v1', assetId: null, assetName: 'Source code (ZIP)' };
  const fixture = sandbox({ catalog: { releases: [{ tag: 'v1', source: { tag: 'v1', name: 'Source code (ZIP)' },
    assets: [{ id: 99, name: 'Source code (ZIP)' }] }] } });
  fixture.seed([fixture.releaseSkill({ release })]);
  assert.deepEqual(plain(await fixture.api.updateSkill('sample-id')), { status: 'current', version: 'v1' });
  assert.deepEqual(fixture.calls.prepare, []);
  assert.deepEqual(fixture.calls.clone, []);
});

for (const batch of [false, true]) {
  test(`associated source-path ${batch ? 'batch' : 'single'} update preserves the local folder and exact remote choice`, async () => {
    const sourcePath = 'skills/remote-name';
    const fixture = sandbox({ clone(mockFs, gitUrl, cloneDir) {
      mockFs.writeFileSync(path.join(cloneDir, sourcePath, 'SKILL.md'), '# Correct remote content');
      mockFs.writeFileSync(path.join(cloneDir, 'skills', 'local-name', 'SKILL.md'), '# Wrong same-name content');
    } });
    const localPath = path.join(HOME, '.claude', 'skills', 'local-name');
    const unrelatedPath = path.join(HOME, '.claude', 'skills', 'unrelated');
    fixture.disk.mock.writeFileSync(path.join(localPath, 'SKILL.md'), '# Old local content');
    fixture.disk.mock.writeFileSync(path.join(unrelatedPath, 'SKILL.md'), '# Keep unchanged');
    fixture.seed([fixture.releaseSkill({ name: 'local-name', localPath, release: null, sourcePath })]);
    if (batch) {
      assert.deepEqual(plain(await fixture.api.batchUpdateSkills(['sample-id'])), { success: ['sample-id'], failed: [] });
    } else {
      assert.equal(await fixture.api.updateSkill('sample-id'), true);
    }
    assert.equal(fixture.disk.mock.readFileSync(path.join(localPath, 'SKILL.md')), '# Correct remote content');
    assert.equal(fixture.disk.mock.readFileSync(path.join(unrelatedPath, 'SKILL.md')), '# Keep unchanged');
    assert.equal(fixture.disk.mock.existsSync(path.join(HOME, '.claude', 'skills', 'remote-name')), false);
    const metadata = JSON.parse(fixture.disk.mock.readFileSync(path.join(localPath, 'metadata.json')));
    assert.equal(metadata.name, 'local-name');
    assert.equal(metadata.source_path, sourcePath);
    assert.equal(metadata.type, 'git');
    const registry = JSON.parse(fixture.disk.mock.readFileSync(path.join(HOME, '.ai-skills-manager', 'registry.json')));
    assert.equal(registry.length, 1);
    assert.equal(registry[0].id, 'sample-id');
    assert.equal(registry[0].localPath, localPath);
    assert.equal(registry[0].sourcePath, sourcePath);
    assert.equal(fixture.calls.clone.length, 1);
    assert.deepEqual(fixture.calls.prepare, []);
    assert.deepEqual(fixture.calls.list, []);
  });
}

test('Git updates remain Git installs even when releases could be available', async () => {
  const fixture = sandbox({ clone(mockFs, gitUrl, cloneDir) {
    mockFs.writeFileSync(path.join(cloneDir, 'skills', 'sample', 'SKILL.md'), '# Sample');
  } });
  fixture.seed([fixture.releaseSkill({ release: null })]);
  assert.equal(await fixture.api.updateSkill('sample-id'), true);
  assert.equal(fixture.calls.clone.length, 1);
  assert.deepEqual(fixture.calls.list, []);
  assert.deepEqual(fixture.calls.prepare, []);
  assert.equal(fixture.events.some(event => event.type === 'skill-release-choice'), false);
  const metadata = JSON.parse(fixture.disk.mock.readFileSync(path.join(HOME, '.claude', 'skills', 'sample', 'metadata.json')));
  assert.equal(metadata.type, 'git');
  assert.equal(metadata.release, null);
});
