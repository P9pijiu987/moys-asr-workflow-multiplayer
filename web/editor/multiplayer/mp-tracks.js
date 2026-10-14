// [multiplayer] 三条多人轨（方案甲）：轨 1 = 主轨、轨 2 = 叠加轨、轨 3 = 副轨。
// 负责轨间移动（Alt+1/2/3）、波形 lane 的「1 / 2 / 3」标签，以及多人模式下
// 防止误关叠加轨 / 双语开关（否则轨 2 / 轨 3 会被隐藏）。
(function initMaweMultiplayerTracks(global) {
  'use strict';

  const STYLE_ID = 'mp-multiplayer-track-styles';
  const ROOT_CLASS = 'mp-multiplayer-active';
  const TRACK_ORDER = ['main', 'overlay', 'extension'];
  const LANE_MARK = 'mpLanes';
  let observer = null;

  const CSS = `
  .${ROOT_CLASS} .waveform-row.multi-subtitle-row::before,
  .${ROOT_CLASS} .waveform-row.multi-subtitle-row::after { display: none; }
  .mp-lane-label {
    position: absolute; z-index: 8; right: 6px; height: 15px; padding: 0 4px; box-sizing: border-box;
    border-radius: 2px; color: var(--active-cue-fg, #fff); background: var(--accent, #5ea7ff);
    font: 11px/15px var(--font-mono, monospace); pointer-events: none;
  }
  .mp-lane-label[data-track="extension"] {
    background: var(--amber, #c4a019);
    bottom: calc(var(--multi-subtitle-bottom-inset) + (var(--multi-subtitle-lane-height) - 15px) / 2);
  }
  .mp-lane-label[data-track="main"] {
    bottom: calc(var(--multi-subtitle-bottom-inset) + var(--multi-subtitle-lane-height) + (var(--multi-subtitle-lane-height) - 15px) / 2);
  }
  .mp-lane-label[data-track="overlay"] {
    background: var(--text-secondary, #9aa4ad);
    bottom: calc(var(--multi-subtitle-bottom-inset) + var(--multi-subtitle-lane-height) * 2 + 1px + 10px);
  }
  `;

  function multiplayer() {
    return global.MaweMultiplayer;
  }

  function trackLabel(track) {
    return multiplayer()?.data()?.tracks?.[track]?.label || `轨 ${TRACK_ORDER.indexOf(track) + 1}`;
  }

  function trackArrays() {
    const overlay = getOverlayTrack();
    const extension = MaweMultiSubtitleCore.getActiveExtensionTrack();
    return { main: MaweBoot.DATA.segments, overlay: overlay?.segments, extension: extension?.segments };
  }

  function moveSelectionToTrack(track) {
    if (!multiplayer()?.isEnabled() || !TRACK_ORDER.includes(track)) return false;
    const targets = multiplayer().selectedTargets().filter((target) => target.track !== track);
    if (!targets.length) {
      MaweHint.flashHint(`请先选中不在「${trackLabel(track)}」上的字幕`, 'invalid');
      return false;
    }
    const arrays = trackArrays();
    if (!Array.isArray(arrays[track])) {
      MaweHint.flashHint(`「${trackLabel(track)}」尚未就绪`, 'warning');
      return false;
    }
    detachCuePanelFromTrackEdits();
    MaweSelection.clearSelection();
    let result = null;
    MaweCommands.run(`移动到${trackLabel(track)}`, () => {
      result = multiplayer().utils.moveMultiplayerSegments(trackArrays(), targets, track);
      if (!result.ok) return;
      multiplayer().moveCueEntries(result.moved.filter((move) => move.newId !== move.id));
      const movedIds = new Set(result.moved.map((move) => move.newId));
      (trackArrays()[track] || []).forEach((segment) => { if (movedIds.has(segment.id)) segment._dirty = true; });
      const overlay = getOverlayTrack();
      if (overlay) overlay._dirty = true;
      MaweMultiSubtitleCore.markMultiSubtitleStateDirty();
    }, { invalidate: { cueList: true, preview: 'refresh' } });
    if (result?.ok) {
      MaweHint.flashHint(`已将 ${result.moved.length} 条字幕移动到「${trackLabel(track)}」`, 'success');
      return true;
    }
    MaweHint.flashHint(result?.reason === 'overlap'
      ? `「${trackLabel(track)}」在该时间已有字幕，未移动（同一轨内字幕不能重叠）`
      : '没有可移动的字幕', 'warning');
    return false;
  }

  function decorateRows(root = document) {
    if (!multiplayer()?.isEnabled()) return;
    root.querySelectorAll?.('.waveform-row.multi-subtitle-row').forEach((row) => {
      if (row.dataset[LANE_MARK]) return;
      row.dataset[LANE_MARK] = 'true';
      TRACK_ORDER.forEach((track, index) => {
        const label = document.createElement('span');
        label.className = 'mp-lane-label';
        label.dataset.track = track;
        label.textContent = String(index + 1);
        label.title = trackLabel(track);
        label.setAttribute('aria-hidden', 'true');
        row.append(label);
      });
    });
  }

  function clearRowDecorations() {
    document.querySelectorAll('.mp-lane-label').forEach((label) => label.remove());
    document.querySelectorAll('.waveform-row[data-mp-lanes]').forEach((row) => { delete row.dataset[LANE_MARK]; });
  }

  function ensureObserver() {
    if (observer) return;
    const pane = document.querySelector('.waveform-pane') || document.getElementById('waveform-pane');
    if (!pane) return;
    observer = new MutationObserver(() => decorateRows(pane));
    observer.observe(pane, { childList: true, subtree: true });
  }

  function sync() {
    const enabled = multiplayer()?.isEnabled() === true;
    document.documentElement.classList.toggle(ROOT_CLASS, enabled);
    if (enabled) {
      ensureObserver();
      decorateRows();
    } else {
      clearRowDecorations();
    }
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.append(style);
  }

  // 多人模式依赖叠加轨与双语轨可见：拦截关闭这两个开关的点击（含工具栏快捷按钮转发的 click）。
  function guardTrackToggle(id) {
    document.getElementById(id)?.addEventListener('click', (event) => {
      // click 派发时勾选状态已切换为新值：新值为未勾选即表示用户要关闭。
      if (!multiplayer()?.isEnabled() || event.currentTarget.checked) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      MaweHint.flashHint('多人联机模式使用叠加轨（轨 2）与副轨（轨 3），请先关闭多人联机再关闭此开关', 'warning');
    }, true);
  }

  injectStyles();
  guardTrackToggle('multi-subtitle-toggle');
  guardTrackToggle('overlay-track-toggle');
  multiplayer()?.onChange(sync);
  setInterval(sync, 1000);
  sync();

  global.MaweMultiplayerTracks = Object.freeze({ TRACK_ORDER, moveSelectionToTrack, trackLabel, sync });
})(typeof window !== 'undefined' ? window : globalThis);
