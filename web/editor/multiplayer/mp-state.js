// [multiplayer] 多人联机模式门面：window.MaweMultiplayer。
// 工程数据的唯一真源是 projectExtensionFields.multiplayer —— 上游把不认识的顶层
// 字段原样放在这里，加载与保存都会透传，因此读写多人数据不需要改动上游的
// 加载 / 保存代码。字段缺失时模式视为关闭，且绝不主动写出该字段（关闭态与上游一致）。
(function initMaweMultiplayer(global) {
  'use strict';

  const utils = global.AsrMultiplayerUtils;
  const listeners = new Set();
  const normalizedCache = new WeakMap();
  let lastRaw;
  let revisionCounter = 0;
  let pendingStyleEdit = null;
  const STYLE_EDIT_IDLE_MS = 800;

  function clone(value) {
    return value == null ? null : JSON.parse(JSON.stringify(value));
  }

  function rawData() {
    // projectExtensionFields 由上游 editor-wiring-export-context.js 声明（共享 classic 作用域）。
    const fields = typeof projectExtensionFields !== 'undefined' ? projectExtensionFields : null;
    const value = fields?.multiplayer;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  function setRawData(value) {
    if (typeof projectExtensionFields === 'undefined') return;
    if (value == null) delete projectExtensionFields.multiplayer;
    else projectExtensionFields.multiplayer = value;
    notify();
  }

  // 只读的规范化视图：读不会写回，避免仅打开工程就改动保存内容。
  function data() {
    const raw = rawData();
    if (!raw) return null;
    if (!normalizedCache.has(raw)) normalizedCache.set(raw, utils.normalizeMultiplayer(raw));
    return normalizedCache.get(raw);
  }

  function supported() {
    return !rawData() || data() !== null;
  }

  function isEnabled() {
    return data()?.enabled === true;
  }

  function revision() {
    const raw = rawData();
    if (raw !== lastRaw) {
      lastRaw = raw;
      revisionCounter += 1;
    }
    return revisionCounter;
  }

  function onChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function notify() {
    revision();
    listeners.forEach((listener) => {
      try { listener(); } catch (error) { console.error('[multiplayer]', error); }
    });
  }

  function workingCopy() {
    return clone(data() || utils.normalizeMultiplayer({}));
  }

  // 一次可撤销的多人数据修改；mutate 接收可写副本，返回 false 表示放弃。
  function mutate(label, mutateCopy, { cueList = true } = {}) {
    if (!supported()) {
      MaweHint.flashHint('工程中的多人联机数据来自更新的版本，当前版本只读保留', 'warning');
      return false;
    }
    flushStyleEdit();
    let applied = false;
    MaweCommands.run(label, () => {
      const next = workingCopy();
      if (mutateCopy(next) === false) return;
      setRawData(utils.normalizeMultiplayer(next));
      applied = true;
    }, { invalidate: { cueList, preview: 'refresh' } });
    return applied;
  }

  function setEnabled(enabled) {
    if (enabled === isEnabled()) return true;
    const ok = mutate(enabled ? '开启多人联机模式' : '关闭多人联机模式', (next) => {
      next.enabled = enabled === true;
      if (enabled && !Object.keys(next.speaker_map || {}).length) {
        const result = utils.autoAssignMultiplayerSpeakers(next.speaker_map,
          Object.values(utils.trackSegmentsFromProject(MaweBoot.DATA)));
        next.speaker_map = result.speaker_map;
        if (result.overflow) MaweHint.flashHint(`识别到超过 12 位说话人，其余 ${result.overflow} 位使用第 1 组`, 'warning');
      }
    });
    if (!ok) return false;
    // D6：槽位与头像只有 ASS Canvas 路径能与导出保持一致，开启时自动打开 ASS 字幕模式。
    if (enabled && MaweSettings.EDITOR_SETTINGS.assMode !== true) {
      if (typeof assModeToggle !== 'undefined' && assModeToggle && !assModeToggle.checked) assModeToggle.click();
    }
    MaweHint.flashHint(enabled ? '已开启多人联机模式：1–9、0、-、= 为选中字幕分配分组' : '已关闭多人联机模式，数据仍保留在工程中', 'success');
    return true;
  }

  function autoAssignSpeakers() {
    let summary = null;
    mutate('按说话人分配分组', (next) => {
      const result = utils.autoAssignMultiplayerSpeakers({}, Object.values(utils.trackSegmentsFromProject(MaweBoot.DATA)));
      if (!result.speakers.length) return false;
      next.speaker_map = result.speaker_map;
      summary = result;
      return undefined;
    });
    if (!summary) MaweHint.flashHint('当前工程没有 ASR 说话人信息', 'warning');
    else MaweHint.flashHint(`已按 ${summary.speakers.length} 位说话人分配分组`
      + (summary.overflow ? `，其中 ${summary.overflow} 位超出 12 组` : ''), summary.overflow ? 'warning' : 'success');
  }

  function selectedTargets() {
    const targets = [];
    const push = (track, segments, indexes) => {
      [...indexes].forEach((index) => {
        const id = segments?.[index]?.id;
        if (id) targets.push({ track, id });
      });
    };
    push('main', MaweBoot.DATA.segments, MaweSelection.selectedIdxs);
    const overlay = typeof getOverlayTrack === 'function' ? getOverlayTrack() : MaweBoot.DATA.overlay_track;
    push('overlay', overlay?.segments, MaweState.selection.indices('overlay'));
    push('extension', MaweMultiSubtitleCore.getActiveExtensionTrack()?.segments, MaweSelection.selectedExtensionIdxs);
    return targets;
  }

  function assignGroupToSelection(groupIndex) {
    const targets = selectedTargets();
    if (!targets.length) return false;
    const groupId = utils.multiplayerGroupId(groupIndex);
    const name = data()?.groups?.[groupIndex]?.name || `分组 ${groupIndex + 1}`;
    const ok = mutate('设置分组', (next) => {
      next.cues = utils.assignMultiplayerGroup(next.cues, targets, groupId);
    });
    if (ok) MaweHint.flashHint(`已将 ${targets.length} 条字幕设为「${name}」`, 'success');
    return ok;
  }

  function clearGroupOnSelection() {
    const targets = selectedTargets();
    if (!targets.length) return false;
    return mutate('恢复自动分组', (next) => {
      next.cues = utils.clearMultiplayerGroup(next.cues, targets);
    });
  }

  function group(groupId) {
    return data()?.groups?.find((item) => item.id === groupId) || null;
  }

  function groupStyle(groupId) {
    const found = group(groupId);
    return found ? { ...found.style, id: `mp-${found.id}`, name: found.name, builtin: false } : null;
  }

  function updateGroup(groupId, patch, label = '修改分组') {
    return mutate(label, (next) => {
      const target = next.groups.find((item) => item.id === groupId);
      if (!target) return false;
      Object.assign(target, patch);
      return undefined;
    });
  }

  // 样式表单逐键输入合并为一次撤销：同一分组同一字段连续修改共用一个命令。
  function flushStyleEdit() {
    if (!pendingStyleEdit) return;
    const { command, timer } = pendingStyleEdit;
    clearTimeout(timer);
    pendingStyleEdit = null;
    command.commit({ preview: 'refresh' });
  }

  function updateGroupStyleField(groupId, field, value) {
    if (!supported() || !group(groupId)) return;
    if (pendingStyleEdit && (pendingStyleEdit.groupId !== groupId || pendingStyleEdit.field !== field)) flushStyleEdit();
    if (!pendingStyleEdit) {
      pendingStyleEdit = { groupId, field, command: MaweCommands.begin('修改分组样式'), timer: 0 };
    }
    const next = workingCopy();
    const target = next.groups.find((item) => item.id === groupId);
    if (field === 'name') target.name = String(value ?? '');
    else target.style = { ...target.style, [field]: value };
    setRawData(utils.normalizeMultiplayer(next));
    clearTimeout(pendingStyleEdit.timer);
    pendingStyleEdit.timer = setTimeout(flushStyleEdit, STYLE_EDIT_IDLE_MS);
    MawePlaybackLoop.refreshSubtitlePreview?.();
  }

  function copyGroupStyle(fromId, toId) {
    const source = group(fromId);
    if (!source || fromId === toId) return false;
    return updateGroup(toId, { style: clone(source.style) }, '复制分组样式');
  }

  function loadGroupStyleFromLibrary(groupId, style) {
    if (!style) return false;
    const { id: _id, name: _name, builtin: _builtin, ...fields } = style;
    return updateGroup(groupId, { style: { ...(group(groupId)?.style || {}), ...fields } }, '从样式库载入分组样式');
  }

  // 命令提交后由 editor-commands 挂钩调用：拆分/合并/换轨后迁移 cue 表条目。
  function afterSegmentsCommand(beforeSnapshot) {
    const current = data();
    if (!current || !beforeSnapshot || !Object.keys(current.cues || {}).length) return;
    const before = utils.trackSegmentsFromProject(beforeSnapshot);
    const after = utils.trackSegmentsFromProject(MaweBoot.DATA);
    const cues = utils.reconcileMultiplayerCues(current.cues, before, after);
    if (cues === current.cues) return;
    setRawData({ ...rawData(), cues });
  }

  // 撤销快照：字段缺失时为 null，恢复时同样删除字段。
  function historySnapshot() {
    return clone(rawData());
  }

  function restoreSnapshot(value) {
    if (pendingStyleEdit) {
      clearTimeout(pendingStyleEdit.timer);
      pendingStyleEdit.command.discard();
      pendingStyleEdit = null;
    }
    setRawData(value == null ? null : clone(value));
  }

  function exportContext() {
    return isEnabled() ? data() : null;
  }

  function trackForCueElement(el) {
    if (!el) return null;
    if (el.dataset.extIdx != null && el.dataset.idx == null) return 'extension';
    if (el.classList.contains('overlay-track-cue') || el.dataset.overlayIdx != null) return 'overlay';
    // buildCueEl 为主轨写 data-idx、副轨写 data-ext-idx；叠加行构建时两者都没有。
    return el.dataset.idx != null || el.dataset.mainIdx != null ? 'main' : 'overlay';
  }

  function cueGroupIndex(track, segment) {
    const current = data();
    if (!current) return 0;
    const segments = utils.trackSegmentsFromProject(MaweBoot.DATA)[track];
    return utils.resolveMultiplayerGroupIndex(current, track, segment, segments);
  }

  // 字幕列表颜色条：多人模式下改为分组文字色，并用伪元素显示分组按键徽标
  //（不新增子节点，避免影响字幕行的网格布局）。
  function decorateCueElement(el, colorBar, segment) {
    if (!el || !colorBar) return;
    if (!isEnabled()) {
      delete el.dataset.mpGroup;
      delete colorBar.dataset.mpKey;
      return;
    }
    const track = trackForCueElement(el);
    const index = cueGroupIndex(track, segment);
    const current = data().groups[index];
    const color = current.style.primaryColor;
    el.dataset.mpGroup = current.id;
    colorBar.dataset.mpKey = utils.MULTIPLAYER_GROUP_KEYS[index];
    colorBar.classList.add('has-color');
    colorBar.style.setProperty('--color-bar', color);
    el.classList.add('has-color');
    el.style.setProperty('--color-bar', color);
    colorBar.title = `分组 ${index + 1}：${current.name}${current.speaker ? `（${current.speaker}）` : ''}`;
  }

  global.MaweMultiplayer = Object.freeze({
    utils,
    rawData,
    data,
    supported,
    isEnabled,
    revision,
    onChange,
    mutate,
    setEnabled,
    autoAssignSpeakers,
    selectedTargets,
    assignGroupToSelection,
    clearGroupOnSelection,
    group,
    groupStyle,
    updateGroup,
    updateGroupStyleField,
    flushStyleEdit,
    copyGroupStyle,
    loadGroupStyleFromLibrary,
    afterSegmentsCommand,
    historySnapshot,
    restoreSnapshot,
    exportContext,
    cueGroupIndex,
    decorateCueElement,
  });
})(typeof window !== 'undefined' ? window : globalThis);
