'use strict';
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const root = path.join(__dirname, 'plugin');
  const server = http.createServer((req, res) => {
    let relative = decodeURIComponent(req.url.split('?')[0]);
    if (relative === '/') relative = '/index.html';
    const file = path.resolve(root, '.' + relative);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (error, content) => {
      if (error) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream');
      res.end(content);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1000, height: 740 } });
    page.setDefaultTimeout(6000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const origin = 'http://127.0.0.1:' + server.address().port;
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.addInitScript(() => {
      const skill = { id: 'demo', name: 'Local Demo Skill', description: 'Local skill usage', localPath: 'C:\\Mock\\skill', agent: 'codex', sourceUrl: '未注册', updatedAt: new Date().toISOString() };
      const state = window.importTest = { calls: [], mode: '', refreshes: 0 };
      const record = (name, ...args) => state.calls.push({ name, args });
      window.ztools = { isDarkColors: () => false, onPluginEnter: () => {}, showNotification: () => {} };
      window.preloadAPI = {
        refreshRegistry: async () => { state.refreshes++; return [skill]; },
        getSkillsList: async () => [skill],
        getSupportedAgents: () => [{ id: 'codex', name: 'Codex', path: '.codex/skills' }],
        migrateLegacyData: async () => {},
        openUrl: () => {}, readSkillDocs: async () => [],
        previewSkills: async () => { throw new Error('Unexpected repository installation'); },
        resolveReleaseChoice: () => {}, cancelDownloads: async () => {},
        chooseLocalImport: async kind => {
          record('chooseLocalImport', kind);
          if (state.mode === 'picker-cancel') return null;
          if (state.mode === 'picker-error') throw new Error('mock local read error');
          return { tempDir: 'mock-temp-' + kind, cloneDir: 'mock-temp-' + kind + '/repo', sourceKind: kind, skills: [{ name: 'Imported Skill', description: 'Mock preview only', path: 'skills/imported' }] };
        },
        getCodexPath: async () => {
          record('getCodexPath');
          if (state.mode === 'path-error') throw new Error('mock target lookup error');
          return 'C:\\Mock\\codex\\skills';
        },
        chooseImportTarget: async () => {
          record('chooseImportTarget');
          if (state.mode === 'target-error') throw new Error('mock target picker error');
          return state.mode === 'target-cancel' ? null : 'C:\\Mock\\custom\\skills';
        },
        cancelPreview: async tempDir => { record('cancelPreview', tempDir); },
        installFromPreview: async (preview, names, targets, source, progress) => {
          record('installFromPreview', preview, names, targets, source);
          if (state.mode === 'install-error') throw new Error('mock copy error');
          if (state.mode === 'install-false') return false;
          progress({ text: 'Mock import progress' });
          return true;
        },
        previewAssociation: async (localPath, url) => {
          record('previewAssociation', localPath, url);
          return { token: 'mock-association-token', skills: [{ name: 'Different Skill', path: 'skills/other' }, { name: 'Matching Skill', path: 'skills/matching' }] };
        },
        commitAssociation: async (token, candidate) => { record('commitAssociation', token, candidate); return true; }
      };
    });
    await page.goto(origin + '/');
    await page.locator('.brand').waitFor();
    await page.locator('.glass-card h3').getByText('Local Demo Skill', { exact: true }).waitFor();
    await page.locator('.local-import-trigger').waitFor({state:'attached'});
    assert.equal(await page.locator('.local-import-trigger').count(), 1);
    const local = page.getByRole('dialog', { name: '本地导入', exact: true });
    const association = page.getByRole('dialog', { name: '关联仓库', exact: true });
    const calls = name => page.evaluate(name => window.importTest.calls.filter(call => call.name === name), name);
    const mode = value => page.evaluate(value => { window.importTest.mode = value; }, value);
    const refreshes = () => page.evaluate(() => window.importTest.refreshes);
    const openLocal = async () => {
      await page.locator('.local-import-trigger').evaluate(e=>e.click());
      await local.waitFor();
      assert.equal(await local.getByRole('button', { name: '确认导入' }).isDisabled(), true);
    };
    const choose = async kind => {
      await local.getByRole('button', { name: kind === 'zip' ? '选择 ZIP' : '选择文件夹', exact: true }).click();
      await local.getByText('请核对技能和安装目录后确认。', { exact: true }).waitFor();
    };
    const closeLocal = async name => { await local.getByRole('button', { name, exact: true }).click(); await local.waitFor({ state: 'detached' }); };

    await openLocal();
    await choose('zip');
    const checkbox = local.getByRole('checkbox', { name: /Imported Skill/ });
    assert.equal(await checkbox.isChecked(), true);
    await checkbox.uncheck();
    assert.equal(await local.getByRole('button', { name: '确认导入' }).isDisabled(), true);
    await checkbox.check();
    await local.getByRole('radio', { name: '自定义目录', exact: true }).check();
    assert.equal(await local.getByRole('button', { name: '确认导入' }).isDisabled(), true);
    await local.getByRole('button', { name: '选择目录', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="自定义安装目录"]').value === 'C:\\Mock\\custom\\skills');
    const beforeImport = await refreshes();
    await local.getByRole('button', { name: '确认导入' }).click();
    await local.getByText('导入完成。关闭后刷新技能列表。', { exact: true }).waitFor();
    const installed = await calls('installFromPreview');
    assert.equal(installed.length, 1);
    assert.equal(installed[0].args[0].tempDir, 'mock-temp-zip');
    assert.deepEqual(installed[0].args.slice(1), [['Imported Skill'], ['C:\\Mock\\custom\\skills'], '']);
    assert.deepEqual((await calls('cancelPreview')).map(call => call.args[0]), ['mock-temp-zip']);
    assert.equal(await refreshes(), beforeImport);
    await closeLocal('关闭');
    await page.waitForFunction(before => window.importTest.refreshes > before, beforeImport);
    console.log('PASS original Vue mount, injected local import, ZIP preview/checkbox/custom target/install/cleanup/close refresh');

    const beforeCancel = await refreshes();
    await openLocal(); await choose('folder'); await closeLocal('取消');
    assert.equal((await calls('cancelPreview')).at(-1).args[0], 'mock-temp-folder');
    assert.equal((await calls('installFromPreview')).length, 1);
    assert.equal(await refreshes(), beforeCancel);
    await mode('picker-cancel'); await openLocal();
    const cleanups = (await calls('cancelPreview')).length;
    await local.getByRole('button', { name: '选择 ZIP', exact: true }).click();
    await local.getByText('已取消选择。', { exact: true }).waitFor();
    assert.equal(await local.getByRole('button', { name: '确认导入' }).isDisabled(), true);
    await closeLocal('取消');
    assert.equal((await calls('cancelPreview')).length, cleanups);
    console.log('PASS folder preview cancellation cleanup and canceled native picker without installation');

    for (const [failure, text] of [['picker-error', 'mock local read error'], ['path-error', 'mock target lookup error']]) {
      await mode(failure); await openLocal();
      const before = (await calls('cancelPreview')).length;
      await local.getByRole('button', { name: '选择 ZIP', exact: true }).click();
      await local.getByRole('status').filter({ hasText: text }).waitFor();
      assert.equal(await local.getByRole('button', { name: '确认导入' }).isDisabled(), true);
      await closeLocal('取消');
      assert.equal((await calls('cancelPreview')).length, before + (failure === 'path-error' ? 1 : 0));
    }
    for (const failure of ['target-cancel', 'target-error']) {
      await mode(failure); await openLocal(); await choose('folder');
      await local.getByRole('button', { name: '选择目录', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('.local-skill-path-row button').disabled);
      assert.equal(await local.getByRole('radio', { name: /Codex（默认）/ }).isChecked(), true);
      if (failure === 'target-error') await local.getByRole('status').filter({ hasText: 'mock target picker error' }).waitFor();
      await closeLocal('取消');
    }
    for (const failure of ['install-error', 'install-false']) {
      await mode(failure); await openLocal(); await choose('zip');
      const before = (await calls('cancelPreview')).length;
      await local.getByRole('button', { name: '确认导入' }).click();
      await local.getByRole('status').filter({ hasText: '导入失败：' }).waitFor();
      await local.getByRole('button', { name: '关闭', exact: true }).waitFor();
      assert.equal((await calls('cancelPreview')).length, before + 1);
      assert.equal(await local.getByRole('button', { name: '确认导入' }).isDisabled(), true);
      await closeLocal('关闭');
      assert.equal((await calls('cancelPreview')).length, before + 1);
    }
    assert.equal(await refreshes(), beforeCancel);
    await mode('');
    console.log('PASS local picker/path/target/install errors and false-result recovery, cleanup exactly once, no failed-import refresh');

    const installCount = (await calls('installFromPreview')).length;
    const repository = 'https://github.com/example/skill';
    const openAssociation = async () => { await page.getByRole('button', { name: '关联仓库', exact: true }).click(); await association.waitFor(); };
    const verify = async () => {
      await association.getByRole('textbox', { name: 'GitHub 仓库根地址' }).fill(repository);
      await association.getByRole('button', { name: '验证仓库', exact: true }).click();
      await association.getByText('验证完成，请选择精确对应的 Skill。', { exact: true }).waitFor();
    };
    await openAssociation();
    assert.equal(await association.getByRole('button', { name: '确认关联' }).isDisabled(), true);
    await verify();
    assert.equal(await association.getByRole('radio').count(), 2);
    assert.equal(await association.getByRole('button', { name: '确认关联' }).isDisabled(), true);
    await association.getByRole('radio', { name: /Matching Skill/ }).check();
    const beforeAssociation = await refreshes();
    await association.getByRole('button', { name: '确认关联' }).click();
    await association.getByText('关联已保存，当前文件未替换。关闭后刷新技能列表。', { exact: true }).waitFor();
    assert.deepEqual((await calls('previewAssociation'))[0].args, ['C:\\Mock\\skill', repository]);
    assert.deepEqual((await calls('commitAssociation'))[0].args, ['mock-association-token', 'skills/matching']);
    assert.equal((await calls('installFromPreview')).length, installCount);
    await association.getByRole('button', { name: '关闭', exact: true }).click();
    await association.waitFor({ state: 'detached' });
    await page.waitForFunction(before => window.importTest.refreshes > before, beforeAssociation);
    const beforeAssociationCancel = await refreshes();
    await openAssociation(); await verify();
    await association.getByRole('radio', { name: /Matching Skill/ }).check();
    await association.getByRole('textbox', { name: 'GitHub 仓库根地址' }).fill(repository + '/tree/main');
    assert.equal(await association.getByRole('button', { name: '确认关联' }).isDisabled(), true);
    assert.equal(await association.getByRole('radio').count(), 0);
    await association.getByRole('button', { name: '验证仓库', exact: true }).click();
    await association.getByRole('status').filter({ hasText: '请输入 HTTPS GitHub 仓库根地址' }).waitFor();
    assert.equal((await calls('previewAssociation')).length, 2);
    await association.getByRole('button', { name: '取消', exact: true }).click();
    await association.waitFor({ state: 'detached' });
    assert.equal((await calls('commitAssociation')).length, 1);
    assert.equal((await calls('installFromPreview')).length, installCount);
    assert.equal(await refreshes(), beforeAssociationCancel);
    assert.deepEqual(errors, []);
    console.log('PASS association verifies URL, requires exact candidate, commits token/path only (never installs), refreshes on close; edit invalidation, URL rejection and cancellation');
    console.log('PASS all import/association UI checks; real Vue + installed Edge, mocked host APIs, external network blocked');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
