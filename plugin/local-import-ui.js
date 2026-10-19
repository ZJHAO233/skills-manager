'use strict';
(() => {
  if (window.__skillLocalImportUI) return;
  window.__skillLocalImportUI = true;
  const api = () => window.preloadAPI;
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const button = (text, action) => {
    const node = el('button', text);
    node.type = 'button';
    node.onclick = action;
    return node;
  };
  let active = null;
  let pending = 0;
  const errorText = error => error && error.message ? error.message : String(error);
  async function cleanup(preview, status) {
    if (!preview || !preview.tempDir) return;
    try { await api().cancelPreview(preview.tempDir); }
    catch (error) { if (status) status.textContent = '临时文件清理失败：' + errorText(error); }
  }
  function createDialog(title) {
    if (active || pending) return null;
    const dialog = el('dialog', undefined, 'local-skill-dialog');
    const heading = el('h2', title);
    const status = el('p', '', 'local-skill-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const body = el('div', undefined, 'local-skill-body');
    const actions = el('div', undefined, 'local-skill-actions');
    const state = { dialog, body, status, actions, preview: null, busy: false, closed: false, changed: false };
    const close = async () => {
      if (state.busy) { status.textContent = '正在写入，请等待操作完成后关闭。'; return; }
      if (state.closed) return;
      state.closed = true;
      pending++;
      await cleanup(state.preview, status);
      state.preview = null;
      dialog.close();
      dialog.remove();
      active = null;
      pending--;
      if (state.changed) {
        const refresh = document.querySelector('.btn-refresh');
        if (refresh) refresh.click();
        else window.location.reload();
      }
    };
    const cancel = button('取消', close);
    state.cancel = cancel;
    actions.append(cancel);
    dialog.append(heading, body, status, actions);
    heading.id = 'local-import-heading';
    dialog.setAttribute('aria-labelledby', heading.id);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    document.body.append(dialog);
    active = state;
    dialog.showModal();
    return state;
  }
  function choice(input, name, description) {
    const row = el('label', undefined, 'local-skill-choice');
    const details = el('span');
    details.append(el('strong', name));
    if (description) details.append(el('small', description));
    row.append(input, details);
    return row;
  }
  function showLocalImport(initialKind) {
    const state = createDialog('本地导入');
    if (!state) return;
    const { body, status, actions } = state;
    body.append(el('p', '选择本地 ZIP 或文件夹，仅检查并复制 Skill 文件，不执行其中的说明或脚本。', 'local-skill-hint'));
    const sources = el('div', undefined, 'local-skill-source-actions');
    const previewArea = el('div');
    const confirm = button('确认导入', install);
    confirm.className = 'local-skill-primary';
    confirm.disabled = true;
    const zip = button('选择 ZIP', () => choose('zip'));
    const folder = button('选择文件夹', () => choose('folder'));
    sources.append(zip, folder);
    body.append(sources, previewArea);
    if (initialKind === 'zip' || initialKind === 'folder') Promise.resolve().then(() => choose(initialKind));
    actions.append(confirm);
    let selected = [];
    let targetInput = null;
    let defaultTarget = '';
    let custom = null;
    function updateConfirm() {
      confirm.disabled = state.busy || !state.preview || !selected.some(input => input.checked) || !(custom && custom.checked ? targetInput.value.trim() : defaultTarget);
    }
    async function choose(kind) {
      if (pending || state.busy) return;
      pending++;
      zip.disabled = folder.disabled = true;
      confirm.disabled = true;
      status.textContent = '正在读取本地内容…';
      const previous = state.preview;
      state.preview = null;
      previewArea.replaceChildren();
      await cleanup(previous, status);
      try {
        const preview = await api().chooseLocalImport(kind);
        if (state.closed) { await cleanup(preview); return; }
        state.preview = preview;
        if (!preview) { status.textContent = '已取消选择。'; return; }
        defaultTarget = await api().getCodexPath();
        if (state.closed) return;
        renderPreview(preview);
        status.textContent = preview.skills.length ? '请核对技能和安装目录后确认。' : '未发现可导入的 Skill。';
      } catch (error) {
        if (!state.closed) {
          status.textContent = errorText(error);
          await cleanup(state.preview, status);
          state.preview = null;
        }
      } finally {
        pending--;
        if (!state.closed) { zip.disabled = folder.disabled = false; updateConfirm(); }
      }
    }
    function renderPreview(preview) {
      selected = [];
      const list = el('fieldset', undefined, 'local-skill-list');
      list.append(el('legend', '选择 Skill（' + preview.skills.length + '）'));
      for (const skill of preview.skills) {
        const input = el('input');
        input.type = 'checkbox'; input.checked = true; input.value = skill.name;
        input.onchange = updateConfirm;
        selected.push(input);
        list.append(choice(input, skill.name, skill.description || skill.path || ''));
      }
      const targets = el('fieldset', undefined, 'local-skill-targets');
      targets.append(el('legend', '安装目录'));
      const codex = el('input'); codex.type = 'radio'; codex.name = 'local-import-target'; codex.checked = true;
      custom = el('input'); custom.type = 'radio'; custom.name = 'local-import-target';
      targetInput = el('input'); targetInput.type = 'text'; targetInput.placeholder = '输入自定义安装目录'; targetInput.disabled = true;
      targetInput.setAttribute('aria-label', '自定义安装目录');
      const pick = button('选择目录', async () => {
        if (pending || state.busy) return;
        pending++; pick.disabled = true;
        try {
          const path = await api().chooseImportTarget();
          if (!state.closed && path) { targetInput.value = path; custom.checked = true; targetInput.disabled = false; updateConfirm(); }
        } catch (error) { if (!state.closed) status.textContent = errorText(error); }
        finally { pending--; pick.disabled = false; }
      });
      const changeTarget = () => { targetInput.disabled = !custom.checked; updateConfirm(); };
      codex.onchange = custom.onchange = changeTarget;
      targetInput.oninput = updateConfirm;
      const pathRow = el('div', undefined, 'local-skill-path-row'); pathRow.append(targetInput, pick);
      targets.append(choice(codex, 'Codex（默认）', defaultTarget), choice(custom, '自定义目录'), pathRow);
      previewArea.replaceChildren(list, targets);
    }
    async function install() {
      if (pending || state.busy || confirm.disabled) return;
      const names = selected.filter(input => input.checked).map(input => input.value);
      const target = custom.checked ? targetInput.value.trim() : defaultTarget;
      state.busy = true;
      for (const input of body.querySelectorAll('button,input')) input.disabled = true;
      confirm.disabled = true; state.cancel.disabled = true;
      status.textContent = '正在导入，请勿关闭窗口…';
      try {
        const result = await api().installFromPreview(state.preview, names, [target], '', progress => {
          if (progress && typeof progress.text === 'string') status.textContent = progress.text;
        });
        if (result === false) throw new Error('导入未完成，请重新选择本地内容后重试。');
        state.changed = true;
        status.textContent = '导入完成。关闭后刷新技能列表。';
      } catch (error) { status.textContent = '导入失败：' + errorText(error) + '；请重新选择本地内容后重试。'; }
      finally {
        await cleanup(state.preview, status);
        state.preview = null;
        state.busy = false;
        state.cancel.disabled = false;
        state.cancel.textContent = '关闭';
        if (!state.changed) zip.disabled = folder.disabled = false;
      }
    }
  }
  window.addEventListener('local-import-request', event => showLocalImport(event.detail?.kind));
  function inject() {
    const panel = document.querySelector('.control-panel');
    if (panel && !panel.querySelector('.local-import-trigger')) {
      const trigger = button('本地导入', showLocalImport);
      trigger.className = 'local-import-trigger';
      panel.append(trigger);
    }
  }
  function start() {
    const root = document.getElementById('app');
    if (!root) return;
    new MutationObserver(inject).observe(root, { childList: true, subtree: true });
    inject();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
