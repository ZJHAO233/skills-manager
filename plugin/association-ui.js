'use strict';
(() => {
  if (window.__skillAssociationUI) return;
  window.__skillAssociationUI = true;
  let active = false;
  let pending = false;
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const button = (text, action) => {
    const node = el('button', text); node.type = 'button'; node.onclick = action; return node;
  };
  const message = error => error && error.message ? error.message : String(error);
  function open(skillPath) {
    if (active || pending) return;
    active = true;
    let closed = false;
    let saving = false;
    let changed = false;
    let verified = null;
    let selected = null;
    const dialog = el('dialog', undefined, 'skill-association-dialog');
    const heading = el('h2', '关联仓库'); heading.id = 'skill-association-heading';
    dialog.setAttribute('aria-labelledby', heading.id);
    const hint = el('p', '仅支持 HTTPS GitHub 仓库根地址，不含分支或子目录。验证后请选择精确对应的 Skill。此次仅保存关联，不覆盖当前文件。', 'association-hint');
    const localPath = el('p', skillPath, 'association-hint');
    const repo = el('input'); repo.type = 'url'; repo.placeholder = 'GitHub 仓库根地址'; repo.setAttribute('aria-label', 'GitHub 仓库根地址');
    const row = el('div', undefined, 'association-repo-row');
    const list = el('fieldset', undefined, 'association-candidates'); list.hidden = true;
    const warning = el('p', '仅关联当前文件，无版本基线；首次同步会备份并替换，请核对来源', 'association-warning');
    const status = el('p', '', 'association-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const actions = el('div', undefined, 'association-actions');
    const confirm = button('确认关联', commit); confirm.className = 'association-primary'; confirm.disabled = true;
    const close = () => {
      if (saving) { status.textContent = '正在保存，请等待操作完成后关闭。'; return; }
      if (closed) return;
      closed = true; verified = null; dialog.close(); dialog.remove(); active = false;
      if (changed) {
        const refresh = document.querySelector('.btn-refresh');
        if (refresh) refresh.click(); else window.location.reload();
      }
    };
    const cancel = button('取消', close);
    const invalidate = () => { verified = null; selected = null; confirm.disabled = true; list.replaceChildren(); list.hidden = true; };
    repo.oninput = invalidate;
    const verify = button('验证仓库', async () => {
      if (pending || saving) return;
      invalidate(); pending = true; verify.disabled = repo.disabled = true;
      status.textContent = '正在验证仓库…';
      try {
        const value = repo.value.trim();
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port || url.search || url.hash || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(url.pathname) || url.pathname.split('/').some(part => part === '.' || part === '..')) throw new Error('请输入 HTTPS GitHub 仓库根地址，不含分支或子目录。');
        const result = await window.preloadAPI.previewAssociation(skillPath, value);
        if (closed) return;
        verified = result;
        list.append(el('legend', '选择对应的 Skill 目录'));
        for (const skill of result.skills) {
          const label = el('label', undefined, 'association-candidate');
          const input = el('input'); input.type = 'radio'; input.name = 'association-candidate';
          input.onchange = () => { selected = skill.path; confirm.disabled = false; };
          const details = el('span'); details.append(el('strong', skill.name), el('small', skill.path));
          label.append(input, details); list.append(label);
        }
        list.hidden = false;
        status.textContent = result.skills.length ? '验证完成，请选择精确对应的 Skill。' : '仓库中未发现可关联的 Skill。';
      } catch (error) { if (!closed) status.textContent = message(error); }
      finally { pending = false; if (!closed) verify.disabled = repo.disabled = false; }
    });
    async function commit() {
      if (pending || saving || !verified || selected === null) return;
      saving = true; confirm.disabled = cancel.disabled = true;
      for (const node of dialog.querySelectorAll('input,button')) node.disabled = true;
      status.textContent = '正在保存关联…';
      try {
        const result = await window.preloadAPI.commitAssociation(verified.token, selected);
        if (result === false) throw new Error('关联未完成');
        changed = true;
        status.textContent = '关联已保存，当前文件未替换。关闭后刷新技能列表。';
      } catch (error) {
        invalidate();
        status.textContent = message(error) + '；请重新验证仓库后重试。';
        verify.disabled = repo.disabled = false;
      } finally { saving = false; cancel.disabled = false; cancel.textContent = '关闭'; }
    }
    row.append(repo, verify); actions.append(cancel, confirm);
    dialog.append(heading, hint, localPath, row, list, warning, status, actions);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    document.body.append(dialog); dialog.showModal(); repo.focus();
  }
  function inject() {
    for (const doc of document.querySelectorAll('.skill-doc-button[data-skill-path]')) {
      const container = doc.parentElement;
      if (!container || container.querySelector('.skill-association-button')) continue;
      const action = button('', event => { event.stopPropagation(); open(doc.dataset.skillPath); });
      action.className = 'btn-icon-link skill-action-button skill-association-button';
      action.title = '关联仓库'; action.setAttribute('aria-label', '关联仓库');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M10 13a5 5 0 0 0 7 .1l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7-.1l-3 3a5 5 0 0 0 7 7l1.7-1.7');
      svg.append(path); action.append(svg);
      const rename = container.querySelector('.skill-nickname-button');
      if (rename) container.insertBefore(action, rename); else container.append(action);
    }
  }
  function start() {
    const root = document.getElementById('app');
    if (!root) return;
    new MutationObserver(inject).observe(root, { childList: true, subtree: true });
    inject();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
})();
