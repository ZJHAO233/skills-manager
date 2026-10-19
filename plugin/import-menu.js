'use strict';
(() => {
  if (window.__skillImportMenuUI) return;
  window.__skillImportMenuUI = true;
  const triggerSelector = '.header-actions button[title="导入配置"]';
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const button = (text, action) => {
    const element = node('button', text);
    element.type = 'button';
    element.addEventListener('click', action);
    return element;
  };
  let anchor = null;
  let menu = null;
  let github = null;
  let bypass = false;
  const originalControls = () => ({
    input: document.querySelector('.control-panel .install-box input'),
    submit: document.querySelector('.control-panel .install-box button.btn-glow')
  });
  function closeMenu(restoreFocus = false) {
    if (!menu) return;
    menu.remove();
    menu = null;
    if (anchor) {
      anchor.setAttribute('aria-expanded', 'false');
      if (restoreFocus && anchor.isConnected) anchor.focus();
    }
  }
  function positionMenu() {
    if (!menu || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - menu.offsetHeight - 8)) + 'px';
  }
  function closeGithub() {
    if (!github || github.busy) return;
    github.dialog.close();
    github.dialog.remove();
    github = null;
    if (anchor && anchor.isConnected) anchor.focus();
  }
  function syncGithub() {
    if (!github) return;
    const { input: originalInput, submit: originalSubmit } = originalControls();
    if (github.busy) {
      const preview = Array.from(document.querySelectorAll('.glass-modal h3')).some(heading => heading.textContent.trim() === '选择待安装技能');
      if (preview) {
        github.busy = false;
        closeGithub();
        return;
      }
      if (github.started && originalInput && !originalInput.disabled) {
        github.busy = false;
        github.status.textContent = '未能生成仓库预览，请按错误提示检查地址后重试。';
      }
    }
    github.input.disabled = github.busy || !!(originalInput && originalInput.disabled);
    github.submit.disabled = github.input.disabled || !originalInput || !originalSubmit || !github.input.value.trim();
    github.cancel.disabled = github.busy;
    github.submit.textContent = github.busy ? '正在预览…' : '预览仓库';
  }
  function showGithub() {
    if (github) return;
    const dialog = node('dialog', undefined, 'skill-import-dialog');
    const heading = node('h2', '从 GitHub 导入');
    heading.id = 'skill-import-github-heading';
    dialog.setAttribute('aria-labelledby', heading.id);
    const hint = node('p', '输入 GitHub 仓库根地址，预览后选择技能与安装目录。', 'skill-import-hint');
    const form = node('form');
    const label = node('label', 'GitHub 仓库根地址');
    label.htmlFor = 'skill-import-github-url';
    const input = node('input');
    input.id = label.htmlFor;
    input.type = 'url';
    input.required = true;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'https://github.com/owner/repository';
    const status = node('p', '', 'skill-import-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const actions = node('div', undefined, 'skill-import-actions');
    const cancel = button('取消', closeGithub);
    const submit = node('button', '预览仓库', 'skill-import-primary');
    submit.type = 'submit';
    actions.append(cancel, submit);
    form.append(label, input, status, actions);
    dialog.append(heading, hint, form);
    github = { dialog, input, status, submit, cancel, busy: false, started: false };
    input.addEventListener('input', () => { status.textContent = ''; syncGithub(); });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!github || submit.disabled) return;
      let url;
      try {
        url = new URL(input.value.trim());
        if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash || !/^\/[^/\s]+\/[^/\s]+\/?$/.test(url.pathname)) throw new Error();
      } catch {
        status.textContent = '请输入 HTTPS GitHub 仓库根地址，不包含分支、子目录或查询参数。';
        input.focus();
        return;
      }
      const { input: originalInput, submit: originalSubmit } = originalControls();
      if (!originalInput || !originalSubmit || originalInput.disabled) { syncGithub(); return; }
      const state = github;
      state.busy = true;
      state.started = false;
      status.textContent = '正在读取仓库并查找技能，请稍候…';
      syncGithub();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(originalInput, url.href.replace(/\/$/, ''));
      originalInput.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
      if (originalSubmit.disabled) {
        state.busy = false;
        status.textContent = '当前无法预览，请稍后重试。';
        syncGithub();
        return;
      }
      originalSubmit.click();
      await Promise.resolve();
      state.started = true;
      syncGithub();
    });
    dialog.addEventListener('cancel', event => { event.preventDefault(); closeGithub(); });
    document.body.append(dialog);
    syncGithub();
    dialog.showModal();
    input.focus();
  }
  function openMenu(trigger, focusLast = false) {
    anchor = trigger;
    if (trigger.disabled) return;
    menu = node('div', undefined, 'skill-import-menu');
    menu.id = 'skill-import-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', '导入来源');
    const items = [
      ['GitHub 仓库', showGithub],
      ['本地 ZIP', () => window.dispatchEvent(new CustomEvent('local-import-request', { detail: { kind: 'zip' } }))],
      ['本地文件夹', () => window.dispatchEvent(new CustomEvent('local-import-request', { detail: { kind: 'folder' } }))],
      ['导入清单', () => {
        if (!anchor || anchor.disabled) return;
        bypass = true;
        try { anchor.click(); } finally { bypass = false; }
      }]
    ];
    for (const [label, action] of items) {
      const item = button(label, () => {
        if (anchor.disabled) { closeMenu(); return; }
        closeMenu(true);
        action();
      });
      item.setAttribute('role', 'menuitem');
      const icons = ['M9 19c-5 1-5-3-7-3M16 22v-4a4 4 0 0 0-1-3c3 0 6-1 6-6a5 5 0 0 0-1-3 5 5 0 0 0 0-3s-1 0-3 1a12 12 0 0 0-6 0C9 3 8 3 8 3a5 5 0 0 0 0 3 5 5 0 0 0-1 3c0 5 3 6 6 6a4 4 0 0 0-1 3v4', 'M14 2H6v20h12V6zM14 2v5h5M10 7h1M10 10h1M10 13h1M10 16h3v3h-3z', 'M3 5h6l2 3h10v12H3z', 'M5 3h14v18H5zM8 8h8M8 12h8M8 16h5'];
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox','0 0 24 24'); svg.setAttribute('aria-hidden','true');
      const path = document.createElementNS(svg.namespaceURI,'path'); path.setAttribute('d',icons[items.findIndex(entry => entry[0] === label)]); svg.append(path);
      item.textContent = ''; item.append(svg, node('span',label));
      menu.append(item);
    }
    document.body.append(menu);
    trigger.setAttribute('aria-expanded', 'true');
    positionMenu();
    (focusLast ? menu.lastElementChild : menu.firstElementChild).focus();
  }
  function start() {
    const root = document.getElementById('app');
    if (!root) return;
    const sync = () => {
      const trigger = document.querySelector(triggerSelector);
      if (trigger) {
        if (trigger.getAttribute('aria-haspopup') !== 'menu') trigger.setAttribute('aria-haspopup', 'menu');
        if (!trigger.hasAttribute('aria-expanded')) trigger.setAttribute('aria-expanded', 'false');
        if (trigger.getAttribute('aria-controls') !== 'skill-import-menu') trigger.setAttribute('aria-controls', 'skill-import-menu');
      }
      if (menu && (!anchor.isConnected || anchor.disabled)) closeMenu();
      syncGithub();
    };
    new MutationObserver(sync).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
    sync();
    document.addEventListener('click', event => {
      const trigger = event.target instanceof Element ? event.target.closest(triggerSelector) : null;
      if (!trigger || bypass) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (trigger.disabled) return;
      if (menu) closeMenu(true);
      else openMenu(trigger);
    }, true);
    document.addEventListener('pointerdown', event => {
      if (menu && !menu.contains(event.target) && !anchor.contains(event.target)) closeMenu();
    }, true);
    document.addEventListener('keydown', event => {
      const trigger = event.target instanceof Element ? event.target.closest(triggerSelector) : null;
      if (!menu && trigger && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault();
        openMenu(trigger, event.key === 'ArrowUp');
        return;
      }
      if (!menu) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(true); }
      else if (event.key === 'Tab') closeMenu();
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const items = Array.from(menu.children);
        const current = items.indexOf(document.activeElement);
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[index].focus();
      }
    });
    window.addEventListener('resize', positionMenu);
    window.addEventListener('scroll', positionMenu, true);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
