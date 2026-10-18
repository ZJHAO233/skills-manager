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
  const version = document.createElement('small'); version.id = 'joel-build-version'; version.textContent = 'Joel 修改版 · 1.2.0'; document.body.append(version);
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
    content.textContent = '正在读取本地说明…'; tabs.replaceChildren(); if (!docs.open) docs.showModal();
    try {
      const files = await window.preloadAPI.readSkillDocs(e.detail);
      tabs.replaceChildren();
      for (const file of files) { const tab = document.createElement('button'); tab.textContent = file.name; tab.onclick = () => { content.textContent = file.text; }; tabs.append(tab); }
      content.textContent = files[0].text;
    } catch (error) { content.textContent = error.message; }
  });
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
