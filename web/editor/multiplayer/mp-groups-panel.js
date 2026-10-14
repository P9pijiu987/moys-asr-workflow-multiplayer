// [multiplayer] 多人联机模式界面：工程设置开关、样式库窗口中的「多人分组」列表
// 与分组专属字段。全部节点由本模块按上游已有锚点动态插入，不改动上游模板；
// 锚点缺失时静默跳过（便于合并上游后由测试发现）。
(function initMaweMultiplayerGroupsPanel(global) {
  'use strict';

  const STYLE_ID = 'mp-multiplayer-styles';
  const SYNC_INTERVAL_MS = 1000;
  let lastSyncedRevision = -1;
  let elements = null;

  const CSS = `
  .cue[data-mp-group] > .color-bar { width: 14px; position: relative; }
  .cue[data-mp-group] > .color-bar::after {
    content: attr(data-mp-key); position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    color: #111; font-size: 11px; font-weight: 700; line-height: 1;
  }
  .mp-project-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .mp-project-actions button { min-height: var(--control-h, 28px); padding: 4px 10px; font-size: 12px; cursor: pointer;
    color: var(--text-secondary); background: var(--bg-input); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm, 4px); }
  .mp-project-hint { display: block; margin-top: 8px; color: var(--text-muted); font-size: 11px; }
  .mp-group-section[hidden] { display: none; }
  .mp-group-section .ass-style-section-heading { margin-top: 12px; }
  .mp-group-list button .ass-style-list-badge { font-variant-numeric: tabular-nums; }
  .mp-group-list button::before { background: var(--mp-group-color, var(--text-faint)); }
  .mp-group-extra { display: flex; flex-direction: column; gap: 10px; margin-top: 10px; }
  .mp-group-extra[hidden] { display: none; }
  .mp-group-extra-row { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; align-items: end; }
  .mp-group-extra-actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .mp-group-extra-actions button, .mp-group-extra-row button { min-height: var(--control-h, 28px); padding: 4px 10px; font-size: 12px; cursor: pointer;
    color: var(--text-secondary); background: var(--bg-input); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm, 4px); }
  .mp-group-extra small { color: var(--text-muted); font-size: 11px; }
  `;

  function createElement(tag, props = {}, children = []) {
    const element = document.createElement(tag);
    Object.entries(props).forEach(([key, value]) => {
      if (key === 'dataset') Object.assign(element.dataset, value);
      else if (key === 'text') element.textContent = value;
      else if (key in element) element[key] = value;
      else element.setAttribute(key, value);
    });
    children.forEach((child) => element.append(child));
    return element;
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    document.head.append(createElement('style', { id: STYLE_ID, text: CSS }));
  }

  function buildProjectControls() {
    const anchor = document.getElementById('multi-subtitle-toggle-label');
    if (!anchor) return {};
    const toggle = createElement('input', { type: 'checkbox', id: 'multiplayer-toggle' });
    const label = createElement('label', {
      className: 'toggle editor-settings-item project-track-toggle',
      id: 'multiplayer-toggle-label',
      title: '多人游戏实况字幕：12 个样式分组，按 1–9、0、-、= 给选中字幕分配分组。开启时自动打开 ASS 字幕模式。',
    }, [toggle, document.createTextNode(' 多人联机')]);
    const openGroups = createElement('button', { type: 'button', id: 'multiplayer-open-groups', text: '分组与样式…' });
    const autoAssign = createElement('button', { type: 'button', id: 'multiplayer-auto-speakers', text: '按说话人分配分组' });
    const actions = createElement('div', { className: 'mp-project-actions', id: 'multiplayer-project-actions' }, [openGroups, autoAssign]);
    const hint = createElement('small', { className: 'mp-project-hint', id: 'multiplayer-unsupported-hint',
      text: '此工程的多人联机数据来自更新的版本，当前只读保留。' });
    hint.hidden = true;
    anchor.after(label);
    const subGroup = anchor.closest('.editor-settings-sub-group') || anchor.parentElement;
    subGroup.after(actions, hint);
    toggle.addEventListener('change', () => {
      if (!global.MaweMultiplayer.setEnabled(toggle.checked)) toggle.checked = global.MaweMultiplayer.isEnabled();
      sync({ force: true });
    });
    openGroups.addEventListener('click', () => openGroupStyles());
    autoAssign.addEventListener('click', () => global.MaweMultiplayer.autoAssignSpeakers());
    return { toggle, actions, hint };
  }

  function buildStyleWindowSection() {
    const profileHeading = document.querySelector('#ass-style-window .ass-profile-heading');
    if (!profileHeading) return {};
    const count = createElement('span', { className: 'ass-style-section-count', text: '12' });
    const heading = createElement('div', { className: 'ass-style-section-heading' },
      [createElement('span', { text: '多人分组' }), count]);
    const list = createElement('div', { className: 'ass-style-list mp-group-list', id: 'mp-group-list', role: 'listbox', 'aria-label': '多人分组' });
    const section = createElement('div', { className: 'mp-group-section', id: 'mp-group-section' }, [heading, list]);
    section.hidden = true;
    profileHeading.before(section);
    return { section, list };
  }

  function buildGroupExtra() {
    const mainFields = document.querySelector('#ass-style-form .ass-style-fields-main');
    if (!mainFields) return {};
    const speaker = createElement('input', { type: 'text', id: 'mp-group-speaker', maxLength: 64, autocomplete: 'off' });
    const keyLabel = createElement('input', { type: 'text', id: 'mp-group-key', readOnly: true });
    const copyTarget = createElement('select', { id: 'mp-group-copy-target', 'aria-label': '复制样式到分组' });
    const copyButton = createElement('button', { type: 'button', id: 'mp-group-copy', text: '复制样式到该组' });
    const librarySelect = createElement('select', { id: 'mp-group-library-style', 'aria-label': '从样式库载入' });
    const libraryButton = createElement('button', { type: 'button', id: 'mp-group-load-library', text: '从样式库载入' });
    const saveButton = createElement('button', { type: 'button', id: 'mp-group-save-library', text: '另存到样式库' });
    const clearButton = createElement('button', { type: 'button', id: 'mp-group-clear-selection', text: '选中字幕恢复自动分组' });
    const field = (text, control) => createElement('label', { className: 'ass-style-field' }, [document.createTextNode(text), control]);
    const extra = createElement('div', { className: 'mp-group-extra', id: 'mp-group-extra' }, [
      createElement('div', { className: 'mp-group-extra-row' }, [
        field('说话人', speaker), field('快捷键', keyLabel), field('复制样式到', copyTarget), copyButton,
      ]),
      createElement('div', { className: 'mp-group-extra-row' }, [field('样式库样式', librarySelect), libraryButton]),
      createElement('div', { className: 'mp-group-extra-actions' }, [saveButton, clearButton]),
      createElement('small', { text: '分组样式保存在工程中，不影响本机样式库。位置（对齐与边距）由字幕所在的轨道决定。' }),
    ]);
    extra.hidden = true;
    mainFields.after(extra);
    const currentGroupId = () => (assStyleManagerSelection.kind === 'mpgroup' ? assStyleManagerSelection.id : '');
    speaker.addEventListener('change', () => {
      const id = currentGroupId();
      if (id) global.MaweMultiplayer.updateGroup(id, { speaker: speaker.value }, '修改分组说话人');
    });
    copyButton.addEventListener('click', () => {
      const id = currentGroupId();
      if (id && copyTarget.value && global.MaweMultiplayer.copyGroupStyle(id, copyTarget.value)) {
        MaweHint.flashHint('已复制分组样式', 'success');
      }
    });
    libraryButton.addEventListener('click', () => {
      const id = currentGroupId();
      if (!id || !librarySelect.value) return;
      const style = window.AsrEditorUtils.assStyleForId(ASS_STYLE_LIBRARY, librarySelect.value);
      if (global.MaweMultiplayer.loadGroupStyleFromLibrary(id, style)) {
        MaweHint.flashHint(`已载入样式「${style.name}」`, 'success');
        syncAssStyleManager();
      }
    });
    saveButton.addEventListener('click', () => {
      if (currentGroupId()) duplicateAssStyle();
    });
    clearButton.addEventListener('click', () => {
      if (!global.MaweMultiplayer.clearGroupOnSelection()) MaweHint.flashHint('请先选中字幕', 'warning');
    });
    return { extra, speaker, keyLabel, copyTarget, librarySelect };
  }

  // 帮助面板中「1~5 分配颜色」一行：多人模式下改为分组快捷键说明，关闭时恢复原文。
  let helpEntry = null;
  let helpOriginal = '';
  function syncHelpEntry(enabled) {
    if (!helpEntry) {
      helpEntry = [...document.querySelectorAll('.help-important')]
        .find((element) => element.textContent.includes('1~5') && element.textContent.includes('分配颜色')) || null;
      helpOriginal = helpEntry?.innerHTML || '';
    }
    if (!helpEntry) return;
    helpEntry.innerHTML = enabled
      ? '<kbd>1~9</kbd> <kbd>0</kbd> <kbd>-</kbd> <kbd>=</kbd> 分配第 1–12 个多人分组'
      : helpOriginal;
  }

  function ensureElements() {
    if (elements) return elements;
    injectStyles();
    elements = { ...buildProjectControls(), ...buildStyleWindowSection(), ...buildGroupExtra() };
    return elements;
  }

  function renderGroupList(list, groups, selectedId) {
    list.replaceChildren();
    groups.forEach((group, index) => {
      const button = createElement('button', { type: 'button', role: 'option',
        dataset: { assSelectionKind: 'mpgroup', assSelectionId: group.id } });
      button.setAttribute('aria-selected', group.id === selectedId ? 'true' : 'false');
      button.style.setProperty('--mp-group-color', group.style.primaryColor);
      button.append(
        createElement('span', { className: 'ass-style-list-label', text: group.speaker ? `${group.name} · ${group.speaker}` : group.name }),
        createElement('span', { className: 'ass-style-list-badge', text: global.MaweMultiplayer.utils.MULTIPLAYER_GROUP_KEYS[index] }),
      );
      button.addEventListener('click', () => assStyleManagerSetSelection('mpgroup', group.id));
      list.append(button);
    });
  }

  function syncGroupExtra(selection, groups) {
    const { extra, speaker, keyLabel, copyTarget, librarySelect } = elements;
    if (!extra) return;
    const active = selection.kind === 'mpgroup' && groups.some((group) => group.id === selection.id);
    extra.hidden = !active;
    if (!active) return;
    // 分组样式属于工程，不是样式库的内置条目。
    if (typeof assStyleBuiltinBadge !== 'undefined' && assStyleBuiltinBadge) assStyleBuiltinBadge.hidden = true;
    const index = groups.findIndex((group) => group.id === selection.id);
    const group = groups[index];
    if (document.activeElement !== speaker) speaker.value = group.speaker || '';
    keyLabel.value = global.MaweMultiplayer.utils.MULTIPLAYER_GROUP_KEYS[index];
    const previousTarget = copyTarget.value;
    copyTarget.replaceChildren(...groups.filter((item) => item.id !== group.id)
      .map((item) => new Option(item.name, item.id)));
    if ([...copyTarget.options].some((option) => option.value === previousTarget)) copyTarget.value = previousTarget;
    const previousStyle = librarySelect.value;
    librarySelect.replaceChildren(...(ASS_STYLE_LIBRARY.styles || []).map((style) => new Option(style.name, style.id)));
    if ([...librarySelect.options].some((option) => option.value === previousStyle)) librarySelect.value = previousStyle;
  }

  // 由样式库窗口的 syncAssStyleManager 挂钩调用。
  function syncStyleWindow(selection = assStyleManagerSelection) {
    ensureElements();
    const multiplayer = global.MaweMultiplayer;
    const enabled = multiplayer.isEnabled();
    const groups = enabled ? multiplayer.data().groups : [];
    if (elements.section) {
      elements.section.hidden = !enabled;
      if (enabled) renderGroupList(elements.list, groups, selection.kind === 'mpgroup' ? selection.id : '');
    }
    syncGroupExtra(selection, groups);
  }

  function sync({ force = false } = {}) {
    ensureElements();
    const multiplayer = global.MaweMultiplayer;
    const revision = multiplayer.revision();
    if (!force && revision === lastSyncedRevision) return;
    lastSyncedRevision = revision;
    const { toggle, actions, hint } = elements;
    const supported = multiplayer.supported();
    if (toggle) {
      toggle.checked = multiplayer.isEnabled();
      toggle.disabled = !supported;
    }
    if (actions) actions.hidden = !multiplayer.isEnabled();
    if (hint) hint.hidden = supported;
    syncHelpEntry(multiplayer.isEnabled());
    // 样式库窗口开着时同步分组列表与表单（关闭模式时回落到样式列表）。
    if (typeof syncAssStyleManager === 'function') syncAssStyleManager();
  }

  function openGroupStyles(groupId = 'g01') {
    if (!global.MaweMultiplayer.isEnabled()) return;
    assStyleManagerSelection = { kind: 'mpgroup', id: groupId };
    assStyleFloatingPanel.open();
    syncAssStyleManager({ force: true });
  }

  ensureElements();
  global.MaweMultiplayer.onChange(() => sync());
  // 打开其它工程、撤销等路径会替换多人数据但不经过本模块；轻量轮询修订号兜底。
  setInterval(() => sync(), SYNC_INTERVAL_MS);

  global.MaweMultiplayerGroupsPanel = Object.freeze({ sync, syncStyleWindow, openGroupStyles });
})(typeof window !== 'undefined' ? window : globalThis);
