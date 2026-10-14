// [multiplayer] 头像样式统一窗口：左侧选择「全局默认」或某个分组，右侧编辑位置、间距、
// 大小、不透明度、形状与圆角、图层与阴影；分组页可上传头像并逐项选择是否覆盖默认值。
// 头像图片导入时缩放到最长边 ≤512px 并转为 PNG，以 base64 存入工程（决策 D5）。
(function initMaweMultiplayerAvatarPanel(global) {
  'use strict';

  const MAX_SIDE = 512;
  const POSITION_KEY = 'maw.multiplayer.avatar_window.v1';
  const FIELDS = Object.freeze([
    { key: 'position', label: '位置', type: 'select', options: [['left', '文字左侧'], ['right', '文字右侧'], ['top', '文字上方']] },
    { key: 'gap_em', label: '与文字间距（× 字号）', type: 'number', step: 0.05, min: 0, max: 4 },
    { key: 'size_em', label: '大小（× 字号）', type: 'number', step: 0.1, min: 0.2, max: 6 },
    { key: 'opacity', label: '不透明度 %', type: 'number', step: 5, min: 0, max: 100 },
    { key: 'shape', label: '裁切形状', type: 'select', options: [['circle', '圆形'], ['rounded', '圆角'], ['square', '方形']] },
    { key: 'radius', label: '圆角（× 边长）', type: 'number', step: 0.05, min: 0, max: 0.5 },
    { key: 'layer', label: '图层', type: 'select', options: [['above', '文字前'], ['below', '文字后']] },
    { key: 'shadow.enabled', label: '阴影', type: 'checkbox' },
    { key: 'shadow.color', label: '阴影颜色', type: 'color' },
    { key: 'shadow.opacity', label: '阴影不透明度 %', type: 'number', step: 5, min: 0, max: 100 },
    { key: 'shadow.blur', label: '阴影模糊（1080p 像素）', type: 'number', step: 1, min: 0, max: 100 },
    { key: 'shadow.x', label: '阴影 X（1080p 像素）', type: 'number', step: 1, min: -200, max: 200 },
    { key: 'shadow.y', label: '阴影 Y（1080p 像素）', type: 'number', step: 1, min: -200, max: 200 },
  ]);

  let scope = 'defaults';
  let elements = null;
  let floating = null;

  function multiplayer() {
    return global.MaweMultiplayer;
  }

  function getPath(object, path) {
    return path.split('.').reduce((value, key) => (value == null ? undefined : value[key]), object);
  }

  function setPath(object, path, value) {
    const keys = path.split('.');
    let target = object;
    keys.slice(0, -1).forEach((key) => {
      if (!target[key] || typeof target[key] !== 'object') target[key] = {};
      target = target[key];
    });
    target[keys[keys.length - 1]] = value;
  }

  function deletePath(object, path) {
    const keys = path.split('.');
    const parent = keys.length > 1 ? getPath(object, keys.slice(0, -1).join('.')) : object;
    if (!parent) return;
    delete parent[keys[keys.length - 1]];
    if (keys.length > 1 && !Object.keys(parent).length) delete object[keys[0]];
  }

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.entries(props).forEach(([key, value]) => {
      if (key === 'text') node.textContent = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key in node) node[key] = value;
      else node.setAttribute(key, value);
    });
    children.forEach((child) => node.append(child));
    return node;
  }

  function assetUrl(assetId) {
    const asset = assetId ? multiplayer().asset(assetId) : null;
    return asset ? `data:${asset.mime};base64,${asset.data}` : '';
  }

  function build() {
    const close = el('button', { type: 'button', className: 'editor-settings-window-close', id: 'mp-avatar-close', text: '×', title: '关闭（Esc）' });
    const handle = el('header', { className: 'editor-settings-window-header', id: 'mp-avatar-drag-handle' },
      [el('span', { className: 'editor-settings-window-title', text: '头像样式' }), close]);
    const scopes = el('div', { className: 'mp-avatar-scopes', id: 'mp-avatar-scopes', role: 'listbox', 'aria-label': '头像样式范围' });
    const preview = el('img', { className: 'mp-avatar-preview', id: 'mp-avatar-preview', alt: '' });
    const file = el('input', { type: 'file', id: 'mp-avatar-file', accept: 'image/png,image/jpeg,image/webp,image/gif' });
    file.hidden = true;
    const choose = el('button', { type: 'button', id: 'mp-avatar-choose', text: '选择头像图片…' });
    const remove = el('button', { type: 'button', id: 'mp-avatar-remove', text: '移除头像' });
    const imageRow = el('div', { className: 'mp-avatar-image-row', id: 'mp-avatar-image-row' }, [preview, choose, remove, file]);
    const title = el('div', { className: 'mp-avatar-title', id: 'mp-avatar-title' });
    const hint = el('small', { className: 'mp-avatar-hint', id: 'mp-avatar-hint' });
    const grid = el('div', { className: 'mp-avatar-grid', id: 'mp-avatar-grid' });
    const controls = {};
    FIELDS.forEach((field) => {
      let control;
      if (field.type === 'select') {
        control = el('select', { dataset: { avatarField: field.key } });
        field.options.forEach(([value, label]) => control.append(new Option(label, value)));
      } else {
        control = el('input', { type: field.type, dataset: { avatarField: field.key } });
        if (field.type === 'number') Object.assign(control, { step: String(field.step), min: String(field.min), max: String(field.max) });
      }
      const override = el('input', { type: 'checkbox', dataset: { avatarOverride: field.key }, title: '勾选后该分组单独设置此项；不勾选则跟随全局默认' });
      const overrideLabel = el('label', { className: 'mp-avatar-override' }, [override, document.createTextNode('覆盖')]);
      grid.append(el('span', { className: 'mp-avatar-label', text: field.label }), control, overrideLabel);
      controls[field.key] = { control, override, overrideLabel };
    });
    const body = el('div', { className: 'mp-avatar-body' }, [scopes,
      el('div', { className: 'mp-avatar-editor' }, [title, imageRow, grid, hint])]);
    const panel = el('aside', { className: 'editor-settings-window mp-avatar-window', id: 'mp-avatar-window',
      role: 'dialog', 'aria-modal': 'false', 'aria-label': '头像样式', 'aria-hidden': 'true' }, [handle, body]);
    document.body.append(panel);
    floating = MaweFloatingPanel.createFloatingPanel({ panel, dragHandle: handle, positionKey: POSITION_KEY, onOpen: () => sync() });
    close.addEventListener('click', closeWindow);
    panel.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.stopPropagation(); closeWindow(); } });
    choose.addEventListener('click', () => { file.value = ''; file.click(); });
    file.addEventListener('change', () => { if (file.files?.[0]) void importImage(file.files[0]); });
    remove.addEventListener('click', () => {
      if (scope !== 'defaults') multiplayer().updateGroup(scope, { avatar: null }, '移除分组头像');
    });
    grid.addEventListener('change', (event) => {
      const fieldKey = event.target.dataset.avatarField;
      const overrideKey = event.target.dataset.avatarOverride;
      if (fieldKey) applyField(fieldKey, readControl(controls[fieldKey].control));
      else if (overrideKey) toggleOverride(overrideKey, event.target.checked, readControl(controls[overrideKey].control));
    });
    return { panel, scopes, preview, imageRow, title, hint, controls, remove };
  }

  function readControl(control) {
    if (control.type === 'checkbox') return control.checked;
    if (control.type === 'number') return Number(control.value);
    return control.value;
  }

  function writeControl(control, value) {
    if (document.activeElement === control) return;
    if (control.type === 'checkbox') control.checked = value === true;
    else control.value = value == null ? '' : String(value);
  }

  function applyField(key, value) {
    const mp = multiplayer();
    mp.mutate('修改头像样式', (next) => {
      if (scope === 'defaults') {
        next.avatar_defaults = { ...(next.avatar_defaults || {}) };
        setPath(next.avatar_defaults, key, value);
        return undefined;
      }
      const group = next.groups.find((item) => item.id === scope);
      if (!group) return false;
      group.avatar_style = JSON.parse(JSON.stringify(group.avatar_style || {}));
      setPath(group.avatar_style, key, value);
      return undefined;
    }, { cueList: false });
  }

  function toggleOverride(key, enabled, value) {
    if (scope === 'defaults') return;
    multiplayer().mutate(enabled ? '覆盖头像样式' : '恢复跟随默认头像样式', (next) => {
      const group = next.groups.find((item) => item.id === scope);
      if (!group) return false;
      group.avatar_style = JSON.parse(JSON.stringify(group.avatar_style || {}));
      if (enabled) setPath(group.avatar_style, key, value);
      else deletePath(group.avatar_style, key);
      return undefined;
    }, { cueList: false });
  }

  async function importImage(fileObject) {
    if (scope === 'defaults') return;
    try {
      const bitmap = await createImageBitmap(fileObject);
      const ratio = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
      const width = Math.max(1, Math.round(bitmap.width * ratio));
      const height = Math.max(1, Math.round(bitmap.height * ratio));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
      bitmap.close?.();
      const data = canvas.toDataURL('image/png').split(',')[1] || '';
      const assetId = multiplayer().addAsset({ mime: 'image/png', width, height, data, name: String(fileObject.name || '').slice(0, 120) });
      if (!assetId) throw new Error('无法写入头像');
      multiplayer().updateGroup(scope, { avatar: assetId }, '设置分组头像');
      MaweHint.flashHint(`已设置头像（${width}×${height}）`, 'success');
    } catch (error) {
      MaweHint.flashHint(`无法读取头像图片：${error?.message || error}`, 'warning');
    }
  }

  function renderScopes(data) {
    const items = [{ id: 'defaults', label: '全局默认', avatar: null }].concat(data.groups.map((group, index) => ({
      id: group.id, label: `${multiplayer().utils.MULTIPLAYER_GROUP_KEYS[index]} · ${group.name}`, avatar: group.avatar,
      color: group.style.primaryColor,
    })));
    elements.scopes.replaceChildren(...items.map((item) => {
      const button = el('button', { type: 'button', role: 'option', dataset: { avatarScope: item.id } });
      button.setAttribute('aria-selected', item.id === scope ? 'true' : 'false');
      const thumb = el('span', { className: 'mp-avatar-thumb' });
      const url = assetUrl(item.avatar);
      if (url) thumb.style.backgroundImage = `url("${url}")`;
      if (item.color) thumb.style.borderColor = item.color;
      button.append(thumb, el('span', { text: item.label }));
      button.addEventListener('click', () => { scope = item.id; sync(); });
      return button;
    }));
  }

  function sync() {
    const mp = multiplayer();
    if (!elements || !mp?.isEnabled()) return;
    const data = mp.data();
    if (scope !== 'defaults' && !data.groups.some((group) => group.id === scope)) scope = 'defaults';
    renderScopes(data);
    const isGroup = scope !== 'defaults';
    const group = isGroup ? data.groups.find((item) => item.id === scope) : null;
    const defaults = mp.utils.normalizeMultiplayerAvatarStyle(data.avatar_defaults);
    const override = group?.avatar_style || {};
    const effective = isGroup
      ? mp.utils.normalizeMultiplayerAvatarStyle({ ...defaults, ...override, shadow: { ...defaults.shadow, ...(override.shadow || {}) } })
      : defaults;
    elements.title.textContent = isGroup ? `分组：${group.name}${group.speaker ? `（${group.speaker}）` : ''}` : '全局默认（所有分组共用）';
    elements.imageRow.hidden = !isGroup;
    const url = isGroup ? assetUrl(group.avatar) : '';
    elements.preview.hidden = !url;
    if (url) elements.preview.src = url;
    elements.remove.disabled = !group?.avatar;
    elements.hint.textContent = isGroup
      ? '勾选「覆盖」的项目只作用于此分组，其余跟随全局默认。头像与文字作为一个整体在槽位上居中。'
      : '这里的设置作用于所有分组；分组页可以单独覆盖。没有设置头像的分组不显示头像。';
    FIELDS.forEach((field) => {
      const { control, override: overrideInput, overrideLabel } = elements.controls[field.key];
      const overridden = isGroup && getPath(override, field.key) !== undefined;
      writeControl(control, getPath(effective, field.key));
      overrideLabel.hidden = !isGroup;
      overrideInput.checked = overridden;
      control.disabled = isGroup && !overridden;
    });
  }

  function openWindow(groupId = null) {
    if (!multiplayer()?.isEnabled()) return;
    if (!elements) elements = build();
    if (groupId) scope = groupId;
    floating.open();
    sync();
  }

  function closeWindow() {
    floating?.close();
    const removed = multiplayer()?.pruneUnusedAssets() || 0;
    if (removed) global.MaweMultiplayerAvatarCanvas?.clear();
  }

  function addEntryButtons() {
    const projectActions = document.getElementById('multiplayer-project-actions');
    if (projectActions && !document.getElementById('multiplayer-open-avatars')) {
      const button = el('button', { type: 'button', id: 'multiplayer-open-avatars', text: '头像…' });
      button.addEventListener('click', () => openWindow());
      projectActions.append(button);
    }
    const groupActions = document.querySelector('#mp-group-extra .mp-group-extra-actions');
    if (groupActions && !document.getElementById('mp-group-avatar')) {
      const button = el('button', { type: 'button', id: 'mp-group-avatar', text: '头像…' });
      button.addEventListener('click', () => {
        const id = typeof assStyleManagerSelection !== 'undefined' && assStyleManagerSelection.kind === 'mpgroup'
          ? assStyleManagerSelection.id : null;
        openWindow(id);
      });
      groupActions.prepend(button);
    }
  }

  function injectStyles() {
    if (document.getElementById('mp-multiplayer-avatar-styles')) return;
    const style = document.createElement('style');
    style.id = 'mp-multiplayer-avatar-styles';
    style.textContent = `
    .mp-avatar-window { width: min(640px, calc(100vw - 24px)); }
    .mp-avatar-body { display: flex; gap: 12px; min-height: 0; flex: 1 1 auto; overflow: hidden; padding: 12px; }
    .mp-avatar-scopes { display: flex; flex-direction: column; gap: 4px; width: 170px; flex: 0 0 auto; overflow-y: auto; }
    .mp-avatar-scopes button { display: flex; align-items: center; gap: 8px; padding: 6px 8px; font-size: 12px; text-align: left; cursor: pointer;
      color: var(--text-secondary); background: transparent; border: 1px solid transparent; border-radius: var(--radius-sm, 4px); }
    .mp-avatar-scopes button[aria-selected="true"] { color: var(--text-primary); background: var(--accent-tint-strong); border-color: var(--accent-line); }
    .mp-avatar-thumb { flex: 0 0 22px; width: 22px; height: 22px; border-radius: 50%; border: 2px solid var(--border);
      background: var(--bg-input) center / cover no-repeat; }
    .mp-avatar-editor { display: flex; flex-direction: column; gap: 10px; flex: 1 1 auto; min-width: 0; overflow-y: auto; }
    .mp-avatar-title { font-size: 13px; color: var(--text-primary); }
    .mp-avatar-image-row { display: flex; align-items: center; gap: 8px; }
    .mp-avatar-image-row[hidden] { display: none; }
    .mp-avatar-preview { width: 48px; height: 48px; object-fit: cover; border-radius: 50%; border: 1px solid var(--border); }
    .mp-avatar-preview[hidden] { display: none; }
    .mp-avatar-image-row button { min-height: 26px; padding: 3px 10px; font-size: 12px; cursor: pointer; color: var(--text-secondary);
      background: var(--bg-input); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm, 4px); }
    .mp-avatar-grid { display: grid; grid-template-columns: minmax(0, 1fr) 140px auto; gap: 8px 10px; align-items: center; font-size: 12px; color: var(--text-muted); }
    .mp-avatar-grid select, .mp-avatar-grid input[type="number"] { min-height: 26px; font-size: 12px; color: var(--text-primary);
      background: var(--bg-input); border: 1px solid var(--border); border-radius: var(--radius-sm, 4px); }
    .mp-avatar-override { display: inline-flex; align-items: center; gap: 4px; }
    .mp-avatar-override[hidden] { visibility: hidden; display: inline-flex; }
    .mp-avatar-hint { color: var(--text-muted); font-size: 11px; }
    `;
    document.head.append(style);
  }

  injectStyles();
  addEntryButtons();
  multiplayer()?.onChange(() => { if (floating?.isOpen()) sync(); });

  global.MaweMultiplayerAvatarPanel = Object.freeze({ open: openWindow, close: closeWindow, sync });
})(typeof window !== 'undefined' ? window : globalThis);
