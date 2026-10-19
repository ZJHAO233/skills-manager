'use strict';
(() => {
  const button = document.createElement('button');
  button.id = 'cancel-skill-download';
  button.textContent = '取消下载';
  button.hidden = true;
  button.type = 'button';
  button.setAttribute('aria-label', '取消当前所有 Skill 下载');
  document.body.append(button);
  const panel = document.createElement('section'); panel.id = 'skill-task-progress'; panel.hidden = true;
  panel.setAttribute('role', 'status'); panel.setAttribute('aria-live', 'polite');
  const status = document.createElement('div');
  const meter = document.createElement('progress'); meter.max = 1; meter.setAttribute('aria-label', '当前阶段进度');
  panel.append(status, meter); document.body.append(panel);
  const stages = { download: '下载', extract: '解压', install: '安装' };
  window.addEventListener('skill-task-progress', e => {
    const progress = e.detail;
    if (!stages[progress.stage]) return;
    meter.removeAttribute('value');
    meter.hidden = progress.state === 'error';
    if (progress.state === 'done') { panel.hidden = true; return; }
    panel.hidden = false;
    panel.dataset.state = progress.state || 'progress';
    const label = stages[progress.stage] + (progress.label ? ' · ' + progress.label : '');
    if (progress.state === 'error') { status.textContent = label + '失败：' + (progress.error || '请查看操作日志'); return; }
    const current = progress.current;
    const total = progress.total;
    const measured = Number.isFinite(current) && current >= 0 && Number.isFinite(total) && total > 0;
    if (measured) { meter.max = total; meter.value = Math.min(current, total); }
    status.textContent = label + (measured ? ' · ' + current + ' / ' + total + (progress.stage === 'download' ? ' 字节' : ' 文件') : ' · 正在处理，等待实际进度…');
  });
  const version = document.createElement('small'); version.id = 'joel-build-version'; version.textContent = 'SkillHub · Joel · 2.3.1'; document.body.append(version);
  const dialog = document.createElement('dialog'); dialog.id = 'release-picker';
  const heading = document.createElement('h2'); heading.textContent = '选择 Skill 下载方式';
  const hint = document.createElement('p'); const list = document.createElement('div'); list.className = 'release-assets';
  const actions = document.createElement('div'); actions.className = 'release-actions';
  const source = document.createElement('button'); source.textContent = '使用仓库源码（可能较大）';
  const cancel = document.createElement('button'); cancel.textContent = '取消';
  actions.append(source, cancel); dialog.append(heading, hint, list, actions); document.body.append(dialog);
  const finish = choice => { dialog.close(); window.preloadAPI.resolveReleaseChoice(choice); };
  cancel.onclick = () => finish({ type: 'cancel' }); source.onclick = () => finish({ type: 'source' });
  dialog.oncancel = e => { e.preventDefault(); finish({ type: 'cancel' }); };
  window.addEventListener('skill-release-choice', e => {
    list.replaceChildren();
    const releases = e.detail.releases || [];
    hint.textContent = e.detail.error ? '无法查询发行附件：' + e.detail.error : releases.some(r => r.assets.length) ? '以下是作者上传的 ZIP 附件，不含自动生成的 Source code。附件不一定都是 Skill 包，选择后将检查内容。' : releases.some(r => r.source) ? '作者未上传 ZIP 发行附件。可选择下方版本源码快照（可能包含整个仓库），也可使用仓库源码或取消。' : '未找到可用的 ZIP 发行附件或版本源码快照。你可以明确选择仓库源码，或取消。';
    for (const release of releases) for (const asset of release.assets) {
      const item = document.createElement('button'); item.type = 'button';
      item.textContent = release.tag + ' · ' + asset.name + ' · ' + (asset.size / 1048576).toFixed(1) + ' MB';
      item.onclick = () => finish({ type: 'release', assetId: asset.id }); list.append(item);
    }
    for (const release of releases) if (release.source) {
      const item = document.createElement('button'); item.type = 'button';
      item.textContent = release.tag + ' · 源码快照 ZIP（可能包含整个仓库，非精简安装包）';
      item.onclick = () => finish({ type: 'snapshot', tag: release.tag }); list.append(item);
    }
    dialog.showModal();
  });
  const docs = document.createElement('dialog'); docs.id = 'skill-docs';
  const docsTitle = document.createElement('h2'); docsTitle.textContent = 'Skill 使用说明';
  const tabs = document.createElement('div'); tabs.className = 'release-actions';
  const content = document.createElement('pre');
  const close = document.createElement('button'); close.textContent = '关闭'; close.onclick = () => docs.close();
  docs.append(docsTitle, tabs, content, close); document.body.append(docs);
  window.addEventListener('skill-open-docs', async e => {
    const detail = typeof e.detail === 'string' ? { path: e.detail } : e.detail;
    try {
      const url = new URL(detail.source || '');
      if (url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && !url.port && /^\/[^/]+\/[^/]+/.test(url.pathname)) {
        const parts = url.pathname.split('/').filter(Boolean);
        const repo = parts[1].replace(/\.git$/i, '');
        if (parts[0] && repo && !['.', '..'].includes(parts[0]) && !['.', '..'].includes(repo)) { window.preloadAPI.openUrl('https://github.com/' + parts[0] + '/' + repo); return; }
      }
    } catch {}
    content.textContent = '正在读取本地说明…'; tabs.replaceChildren(); if (!docs.open) docs.showModal();
    try {
      const files = await window.preloadAPI.readSkillDocs(detail.path);
      tabs.replaceChildren();
      for (const file of files) { const tab = document.createElement('button'); tab.textContent = file.name; tab.onclick = () => { content.textContent = file.text; }; tabs.append(tab); }
      content.textContent = files[0].text;
    } catch (error) { content.textContent = error.message; }
  });
  const nicknameDialog = document.createElement('dialog'); nicknameDialog.id = 'skill-nickname';
  const nicknameTitle = document.createElement('h2'); nicknameTitle.textContent = 'Skill 昵称';
  const nicknameInput = document.createElement('input'); nicknameInput.type = 'text'; nicknameInput.maxLength = 60; nicknameInput.placeholder = '最多 60 字，留空恢复原名'; nicknameInput.setAttribute('aria-label', 'Skill 昵称');
  const nicknameHint = document.createElement('p'); nicknameHint.textContent = '仅保存在本插件的本机存储，不修改 Skill 文件。';
  const nicknameSave = document.createElement('button'); nicknameSave.textContent = '保存昵称';
  const nicknameCancel = document.createElement('button'); nicknameCancel.textContent = '取消'; nicknameCancel.onclick = () => nicknameDialog.close();
  const nicknameActions = document.createElement('div'); nicknameActions.className = 'nickname-actions'; nicknameSave.className = 'nickname-primary'; nicknameActions.append(nicknameCancel, nicknameSave);
  nicknameDialog.append(nicknameTitle, nicknameInput, nicknameHint, nicknameActions); document.body.append(nicknameDialog);
  let nicknamePath = '';
  const nicknameKey = path => 'skills-manager.nickname:' + path;
  const readNickname = path => { try { return (localStorage.getItem(nicknameKey(path)) || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 60); } catch { return ''; } };
  nicknameSave.onclick = () => {
    try { const text = nicknameInput.value.trim().slice(0, 60); if (text) localStorage.setItem(nicknameKey(nicknamePath), text); else localStorage.removeItem(nicknameKey(nicknamePath)); nicknameDialog.close(); refreshNicknames(); }
    catch { nicknameHint.textContent = '本地存储失败，请检查空间后重试。'; }
  };
  function refreshNicknames() {
    for (const action of document.querySelectorAll('.skill-doc-button,button[title="打开本地目录"],button[title="打开目录"]')) {
      if (!action.classList.contains('skill-action-button')) action.classList.add('skill-action-button');
    }
    for (const doc of document.querySelectorAll('.skill-doc-button[data-skill-path]')) {
      const container = doc.parentElement; if (!container) continue;
      const path = doc.dataset.skillPath;
      let edit = container.querySelector('.skill-nickname-button');
      if (!edit) {
        edit = document.createElement('button'); edit.type = 'button'; edit.className = 'btn-icon-link skill-action-button skill-nickname-button'; edit.setAttribute('aria-label', '编辑 Skill 昵称'); edit.title = '编辑 Skill 昵称';
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '16'); svg.setAttribute('height', '16'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'path'); icon.setAttribute('d', 'M3 4h12M9 4v13M5 17h5M15 13l3 3M12 20l1-4 6-6a2.12 2.12 0 0 1 3 3l-6 6-4 1Z'); svg.append(icon); edit.append(svg); container.append(edit);
        edit.onclick = e => { e.stopPropagation(); nicknamePath = doc.dataset.skillPath; nicknameInput.value = readNickname(nicknamePath); nicknameHint.textContent = '仅保存在本插件的本机存储，不修改 Skill 文件。'; nicknameDialog.showModal(); nicknameInput.focus(); };
      }
      const text = readNickname(path);
      if (edit.classList.contains('has-nickname') !== !!text) edit.classList.toggle('has-nickname', !!text);
      const card = doc.closest('.glass-card,.group-child-card'); if (!card) continue;
      const title = card.querySelector('.child-info strong,h3'); if (!title) continue;
      if (title.dataset.originalPath !== path || title.textContent !== title.dataset.renderedName) {
        if (title.dataset.originalName !== title.textContent) title.dataset.originalName = title.textContent;
        if (title.dataset.originalPath !== path) title.dataset.originalPath = path;
      }
      const original = title.dataset.originalName;
      const display = text || original;
      if (title.textContent !== display) title.textContent = display;
      if (title.dataset.renderedName !== display) title.dataset.renderedName = display;
      const tooltip = text ? '原名：' + original : original;
      if (title.title !== tooltip) title.title = tooltip;
      const anchor = title.closest('.card-title-row') || title;
      anchor.parentElement.querySelector(':scope > .skill-original-name')?.remove();
    }
  }
  const compactTargets = () => {
    refreshNicknames();
    for (const grid of document.querySelectorAll('.full-agent-grid')) {
      if (!grid.classList.contains('compact-agent-targets')) grid.classList.add('compact-agent-targets');
      for (const label of grid.querySelectorAll(':scope > label')) {
        const input = label.querySelector('input');
        const extra = !!input && !['codex', 'on', ''].includes(input.value);
        if (label.classList.contains('extra-agent-target') !== extra) label.classList.toggle('extra-agent-target', extra);
      }
      if (!grid.dataset.targetToggle) {
        grid.dataset.targetToggle = 'true';
        const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'more-agent-targets'; toggle.textContent = '其他'; toggle.setAttribute('aria-expanded', 'false');
        toggle.onclick = () => { const expanded = grid.classList.toggle('show-extra-targets'); toggle.setAttribute('aria-expanded', String(expanded)); toggle.textContent = expanded ? '收起其他' : '其他'; };
        const custom = [...grid.querySelectorAll(':scope > label')].find(label => { const input = label.querySelector('input'); return input && ['on', ''].includes(input.value); });
        if (custom) custom.after(toggle); else grid.append(toggle);
      }
    }
  };
  new MutationObserver(compactTargets).observe(document.getElementById('app'), { childList: true, subtree: true });
  compactTargets();
  let active = 0;
  window.addEventListener('skill-download-state', e => {
    active = e.detail.active ? active + 1 : Math.max(0, active - 1);
    button.hidden = active === 0;
    if (!active) { button.disabled = false; button.textContent = '取消下载'; }
  });
  button.onclick = async () => {
    button.disabled = true; button.textContent = '正在停止…';
    try { await window.preloadAPI.cancelDownloads(); }
    finally { if (active) { button.disabled = false; button.textContent = '取消下载'; } }
  };
})();
