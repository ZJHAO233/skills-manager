'use strict';
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const root = path.join(__dirname, 'plugin');
  const requested = new Set();
  const server = http.createServer((req, res) => {
    let relative;
    try { relative = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { res.writeHead(400).end(); return; }
    if (relative === '/') relative = '/index.html';
    requested.add(relative);
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
    const origin = 'http://127.0.0.1:' + server.address().port;
    const screenshotDir = path.join(__dirname, 'output', 'playwright');
    await fs.promises.mkdir(screenshotDir, { recursive: true });
    for (const dark of [false, true]) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: dark ? 'dark' : 'light' });
      page.setDefaultTimeout(8000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      await page.addInitScript(({ dark }) => {
        const skill = { id: 'demo', name: 'Menu Demo Skill', description: 'Original Vue skill card', localPath: 'C:\\Mock\\skill', agent: 'codex', sourceUrl: '未注册', updatedAt: new Date().toISOString() };
        const state = window.menuTest = { calls: [], events: [], refreshes: 0 };
        const record = (name, ...args) => state.calls.push({ name, args });
        const preview = kind => ({ tempDir: 'mock-menu-' + kind, cloneDir: 'mock-menu-' + kind + '/repo', sourceKind: kind, skills: [{ name: 'Menu Imported Skill', description: 'Preview only; must never auto-install', path: 'skills/imported' }] });
        window.addEventListener('local-import-request', event => state.events.push(event.detail.kind));
        window.ztools = { isDarkColors: () => dark, onPluginEnter: () => {}, showNotification: () => {} };
        window.preloadAPI = {
          refreshRegistry: async () => { state.refreshes++; return [skill]; },
          getSkillsList: async () => [skill],
          getSupportedAgents: () => [{ id: 'codex', name: 'Codex', path: '.codex/skills' }],
          migrateLegacyData: async () => {}, openUrl: () => {}, readSkillDocs: async () => [],
          resolveReleaseChoice: () => {}, cancelDownloads: async () => {},
          previewSkills: (...args) => {
            record('previewSkills', ...args.filter(arg => typeof arg !== 'function'));
            return new Promise(resolve => { state.resolvePreview = () => { resolve(preview('github')); delete state.resolvePreview; }; });
          },
          chooseLocalImport: async kind => { record('chooseLocalImport', kind); return preview(kind); },
          getCodexPath: async () => 'C:\\Mock\\codex\\skills',
          chooseImportTarget: async () => 'C:\\Mock\\custom\\skills',
          cancelPreview: async tempDir => { record('cancelPreview', tempDir); },
          installFromPreview: async (...args) => { record('installFromPreview', ...args.filter(arg => typeof arg !== 'function')); throw new Error('Unexpected automatic installation'); }
        };
      }, { dark });
      await page.goto(origin + '/');
      await page.locator('.glass-card h3').getByText('Menu Demo Skill', { exact: true }).waitFor();
      const trigger = page.locator('.header-actions button[title="导入配置"]');
      await page.waitForFunction(() => document.querySelector('.header-actions button[title="导入配置"]')?.getAttribute('aria-haspopup') === 'menu');
      await page.evaluate(() => {
        window.menuTest.root = document.getElementById('app');
        window.menuTest.vue = window.menuTest.root.__vue_app__;
      });
      assert.equal(await page.evaluate(() => !!window.menuTest.vue), true, 'Original Vue app must be mounted');
      const menu = page.getByRole('menu', { name: '导入来源', exact: true });
      const github = page.getByRole('dialog', { name: '从 GitHub 导入', exact: true });
      const local = page.getByRole('dialog', { name: '本地导入', exact: true });
      const calls = name => page.evaluate(name => window.menuTest.calls.filter(call => call.name === name), name);
      const openMenu = async () => {
        await trigger.click();
        await menu.waitFor();
        assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), ['GitHub 仓库', '本地 ZIP', '本地文件夹', '导入清单']);
        assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
        assert.equal(await page.locator('.glass-modal').count(), 0, 'Opening the menu must not invoke Vue JSON import');
      };
      let baselineDocumentWidth;
      const noOverflow = async locator => {
        const geometry = await locator.evaluate(element => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, documentWidth: document.documentElement.scrollWidth };
        });
        assert.ok(geometry.left >= -1 && geometry.right <= geometry.width + 1 && geometry.top >= -1 && geometry.bottom <= geometry.height + 1, JSON.stringify(geometry));
        assert.ok(geometry.scrollWidth <= geometry.clientWidth + 1 && geometry.documentWidth <= Math.max(geometry.width, baselineDocumentWidth) + 1, JSON.stringify(geometry));
      };
      for (const width of [720, 1280]) {
        await page.setViewportSize({ width, height: 800 });
        baselineDocumentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        if (baselineDocumentWidth > width) console.warn(`BASELINE ${dark ? 'dark' : 'light'} ${width}: original page overflows by ${baselineDocumentWidth - width}px before opening menu`);
        await openMenu();
        await page.keyboard.press('Home');
        await page.keyboard.press('ArrowDown');
        await noOverflow(menu);
        assert.equal(await menu.getByRole('menuitem', { name: '本地 ZIP', exact: true }).evaluate(element => element === document.activeElement), true);
        await page.screenshot({ path: path.join(screenshotDir, `import-menu-${dark ? 'dark' : 'light'}-${width}.png`) });
        await page.keyboard.press('Escape');
        await menu.waitFor({ state: 'detached' });
        assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
        assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
        await openMenu();
        await page.locator('.brand').click();
        await menu.waitFor({ state: 'detached' });
      }
      await openMenu();
      await menu.getByRole('menuitem', { name: 'GitHub 仓库', exact: true }).click();
      await github.waitFor();
      assert.equal(await github.getByRole('button', { name: '预览仓库', exact: true }).isDisabled(), true);
      const repository = 'https://github.com/example/skill';
      await github.getByRole('textbox', { name: 'GitHub 仓库根地址' }).fill(repository);
      await github.getByRole('button', { name: '预览仓库', exact: true }).click();
      await page.waitForFunction(() => typeof window.menuTest.resolvePreview === 'function');
      assert.equal((await calls('previewSkills')).length, 1);
      assert.equal((await calls('previewSkills'))[0].args[0], repository);
      assert.equal(await github.isVisible(), true, 'GitHub dialog stays open while original preview awaits');
      assert.equal(await github.getByRole('button', { name: '取消', exact: true }).isDisabled(), true);
      assert.equal(await page.locator('.glass-modal').count(), 0);
      await page.evaluate(() => window.menuTest.resolvePreview());
      const originalPreview = page.locator('.glass-modal').filter({ has: page.getByRole('heading', { name: '选择待安装技能', exact: true }) });
      await originalPreview.waitFor();
      await github.waitFor({ state: 'detached' });
      assert.equal(await originalPreview.locator('.full-agent-grid').count(), 1, 'Original Vue preview should choose installation agents');
      assert.equal((await calls('installFromPreview')).length, 0);
      await originalPreview.getByRole('button', { name: '取消', exact: true }).click();
      await originalPreview.waitFor({ state: 'detached' });
      await page.waitForFunction(() => window.menuTest.calls.some(call => call.name === 'cancelPreview' && call.args[0] === 'mock-menu-github'));
      for (const [label, kind] of [['本地 ZIP', 'zip'], ['本地文件夹', 'folder']]) {
        await openMenu();
        await menu.getByRole('menuitem', { name: label, exact: true }).click();
        await local.waitFor();
        await local.getByText('请核对技能和安装目录后确认。', { exact: true }).waitFor();
        assert.equal((await calls('chooseLocalImport')).at(-1).args[0], kind);
        assert.equal(await local.getByRole('checkbox', { name: /Menu Imported Skill/ }).isChecked(), true);
        assert.equal(await local.getByRole('button', { name: '确认导入', exact: true }).isEnabled(), true);
        assert.equal((await calls('installFromPreview')).length, 0);
        await noOverflow(local);
        await local.getByRole('button', { name: '取消', exact: true }).click();
        await local.waitFor({ state: 'detached' });
        assert.equal((await calls('cancelPreview')).filter(call => call.args[0] === 'mock-menu-' + kind).length, 1);
      }
      assert.deepEqual(await page.evaluate(() => window.menuTest.events), ['zip', 'folder']);
      assert.deepEqual((await calls('chooseLocalImport')).map(call => call.args[0]), ['zip', 'folder']);
      await openMenu();
      await menu.getByRole('menuitem', { name: '导入清单', exact: true }).click();
      await menu.waitFor({ state: 'detached' });
      const jsonModal = page.locator('.glass-modal');
      await jsonModal.waitFor();
      const jsonText = await jsonModal.textContent();
      assert.match(jsonText, /导入/);
      assert.equal(await jsonModal.locator('textarea').count(), 1, 'Original Vue import modal exposes JSON textarea');
      assert.equal(await page.locator('.skill-import-dialog,.local-skill-dialog').count(), 0);
      assert.equal(await page.locator('.glass-modal').count(), 1, 'JSON handoff must not recursively open the menu');
      await jsonModal.getByRole('button', { name: /取消|关闭/ }).click();
      await jsonModal.waitFor({ state: 'detached' });
      await openMenu();
      await page.keyboard.press('Escape');
      await menu.waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(() => document.getElementById('app') === window.menuTest.root && window.menuTest.root.__vue_app__ === window.menuTest.vue), true, 'Original root and Vue instance must remain unchanged');
      assert.equal(await page.locator('.workspace-sidebar,.skill-store,.store-sidebar').count(), 0);
      assert.equal([...requested].some(file => /(?:workspace-ui|store)\.(?:js|css|cjs)$/.test(file)), false, 'Sidebar/store resources must not be loaded');
      assert.equal((await calls('installFromPreview')).length, 0);
      assert.deepEqual((await calls('cancelPreview')).map(call => call.args[0]), ['mock-menu-github', 'mock-menu-zip', 'mock-menu-folder']);
      assert.deepEqual(errors, []);
      console.log(`PASS ${dark ? 'dark' : 'light'}: original Vue/root, no sidebar/store, four menu sources, awaited GitHub preview, automatic native ZIP/folder preview, no installation, exact cleanup, original JSON modal, outside/Escape, keyboard-focused 720/1280 screenshots, overlays contained with no added overflow`);
      await page.close();
    }
    console.log('PASS import menu UI; real Edge + local HTTP Vue app, mocked host APIs, external network blocked');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
