// [multiplayer] 多人联机模式快捷键。
// 捕获阶段监听：只有多人模式开启、存在选中字幕且焦点不在输入控件时才接管
// 1–9、0、-、=（第 1–12 组）。关闭模式时直接放行，上游 1–5 / 0 颜色键保持原样，
// 因此上游 editor-wiring-edit-shortcuts.js 无需任何改动。
(function initMaweMultiplayerShortcuts(global) {
  'use strict';

  function isBlockedTarget() {
    const active = document.activeElement;
    return Boolean(active && (
      active.tagName === 'INPUT'
      || active.tagName === 'TEXTAREA'
      || active.tagName === 'SELECT'
      || active.isContentEditable
    ));
  }

  function modalOpen() {
    return [MaweDom.replaceModal, MaweDom.stickerModal, MaweDom.stickerPreviewModal,
      MaweDom.projectMediaModal, MaweDom.multiSubtitleSplitModal, MaweDom.ctxmenu]
      .some((element) => element?.classList?.contains('show'));
  }

  function hasSelection() {
    return MaweSelection.selectedIdxs.size > 0
      || MaweState.selection.indices('overlay').size > 0
      || MaweSelection.selectedExtensionIdxs.size > 0;
  }

  document.addEventListener('keydown', (event) => {
    const multiplayer = global.MaweMultiplayer;
    if (!multiplayer?.isEnabled()) return;
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    const groupIndex = multiplayer.utils.multiplayerGroupIndexForKey(event.key);
    if (groupIndex < 0) return;
    if (MaweInlineEdit.editingState || MaweInlineEdit.extensionEditingState) return;
    if (isBlockedTarget() || modalOpen() || !hasSelection()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.repeat) return;
    multiplayer.assignGroupToSelection(groupIndex);
  }, true);
})(typeof window !== 'undefined' ? window : globalThis);
