// [multiplayer] 单条字幕的画面位置：Alt+↑/↓ 切换槽位、当前字幕面板的槽位与数值偏移、
// 在 ASS 即时预览上拖动字幕块。全部写入 multiplayer.cues，排版统一由
// multiplayer-layout 计算，因此预览、导出与实际帧使用同一结果。
(function initMaweMultiplayerPlacement(global) {
  'use strict';

  const SLOT_NAMES = Object.freeze({ bottom: '下', middle: '中', top: '上' });
  const PANEL_POLL_MS = 400;
  let panel = null;
  let panelKey = '';
  let drag = null;
  let refreshFrame = 0;

  function multiplayer() {
    return global.MaweMultiplayer;
  }

  function slotName(slotId) {
    return SLOT_NAMES[slotId] || slotId;
  }

  function trackOfKind(kind) {
    return kind === 'overlay' || kind === 'extension' ? kind : 'main';
  }

  function trackSegments(track) {
    return multiplayer().utils.trackSegmentsFromProject(MaweBoot.DATA)[track] || [];
  }

  function segmentFor(target) {
    return trackSegments(target.track).find((segment) => segment.id === target.id) || null;
  }

  // Alt+↑ 移到更高的槽位，Alt+↓ 移到更低的槽位；到顶 / 到底时保持不变。
  function shiftSlotForSelection(direction) {
    const mp = multiplayer();
    if (!mp?.isEnabled()) return false;
    const targets = mp.selectedTargets();
    if (!targets.length) return false;
    const data = mp.data();
    const order = mp.utils.multiplayerSlotOrder(data);
    let changed = 0;
    let lastSlot = '';
    mp.mutate('调整字幕槽位', (next) => {
      targets.forEach((target) => {
        const segment = segmentFor(target);
        if (!segment) return;
        const current = mp.utils.resolveMultiplayerSlot(next, target.track, segment).id;
        const index = Math.min(order.length - 1, Math.max(0, order.indexOf(current) + direction));
        if (order[index] === current) return;
        next.cues = mp.utils.setMultiplayerCuePlacement(next, target.track, target.id, { slot: order[index] });
        lastSlot = order[index];
        changed += 1;
      });
      return changed ? undefined : false;
    }, { cueList: false });
    MaweHint.flashHint(changed
      ? `已将 ${changed} 条字幕移到「${slotName(lastSlot)}」槽位`
      : (direction > 0 ? '已经在最上面的槽位' : '已经在最下面的槽位'), changed ? 'success' : 'invalid');
    return changed > 0;
  }

  // === 当前字幕面板：槽位与数值偏移 ===
  function panelTarget() {
    const target = MaweCuePanel.getCurrentCuePanelTarget?.();
    if (!target?.segment?.id) return null;
    return { track: trackOfKind(target.kind), id: target.segment.id, segment: target.segment };
  }

  function buildPanel() {
    const anchor = document.querySelector('#current-cue-panel .cue-panel-metrics');
    if (!anchor) return null;
    const row = document.createElement('div');
    row.className = 'mp-placement-row';
    row.id = 'mp-placement-row';
    row.hidden = true;
    const slot = document.createElement('select');
    slot.id = 'mp-placement-slot';
    slot.title = '槽位（Alt+↑ / Alt+↓）';
    const number = (id, title) => {
      const input = document.createElement('input');
      input.type = 'number';
      input.id = id;
      input.step = '0.5';
      input.min = '-100';
      input.max = '100';
      input.title = title;
      return input;
    };
    const x = number('mp-placement-x', '水平偏移，占画面宽度的百分比；正数向右');
    const y = number('mp-placement-y', '垂直偏移，占画面高度的百分比；正数向下');
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.id = 'mp-placement-reset';
    reset.textContent = '复位';
    reset.title = '恢复轨道默认槽位并清除偏移';
    const label = (text, control) => {
      const element = document.createElement('label');
      element.append(document.createTextNode(text), control);
      return element;
    };
    row.append(label('槽位', slot), label('X%', x), label('Y%', y), reset);
    anchor.after(row);
    const apply = (patch, label) => {
      const target = panelTarget();
      const mp = multiplayer();
      if (!target || !mp?.isEnabled()) return;
      mp.mutate(label, (next) => {
        next.cues = mp.utils.setMultiplayerCuePlacement(next, target.track, target.id, patch);
      }, { cueList: false });
      panelKey = '';
      syncPanel();
    };
    slot.addEventListener('change', () => apply({ slot: slot.value }, '调整字幕槽位'));
    const applyOffset = () => apply({ offset: { x: (Number(x.value) || 0) / 100, y: (Number(y.value) || 0) / 100 } }, '调整字幕偏移');
    x.addEventListener('change', applyOffset);
    y.addEventListener('change', applyOffset);
    reset.addEventListener('click', () => {
      const target = panelTarget();
      const mp = multiplayer();
      if (!target || !mp?.isEnabled()) return;
      apply({ slot: mp.data().tracks?.[target.track]?.slot, offset: { x: 0, y: 0 } }, '复位字幕位置');
    });
    return { row, slot, x, y };
  }

  function syncPanel() {
    const mp = multiplayer();
    if (!panel) panel = buildPanel();
    if (!panel) return;
    const target = mp?.isEnabled() ? panelTarget() : null;
    const key = target ? `${target.track}/${target.id}:${mp.revision()}` : '';
    if (key === panelKey) return;
    panelKey = key;
    panel.row.hidden = !target;
    if (!target) return;
    const data = mp.data();
    const order = mp.utils.multiplayerSlotOrder(data);
    const current = mp.utils.resolveMultiplayerSlot(data, target.track, target.segment).id;
    const defaultSlot = data.tracks?.[target.track]?.slot;
    panel.slot.replaceChildren(...order.map((id) => new Option(`${slotName(id)}${id === defaultSlot ? '（轨道默认）' : ''}`, id)));
    panel.slot.value = current;
    const offset = mp.utils.resolveMultiplayerOffset(data, target.track, target.segment);
    if (document.activeElement !== panel.x) panel.x.value = String(Math.round(offset.x * 1000) / 10);
    if (document.activeElement !== panel.y) panel.y.value = String(Math.round(offset.y * 1000) / 10);
  }

  // === 在 ASS 即时预览上拖动字幕块 ===
  function previewFrame() {
    if (typeof cachedAssStackPlan === 'undefined' || !cachedAssStackPlan) return null;
    const plan = cachedAssStackPlan;
    const timeMs = Math.max(0, (Number(MaweCoreState.player?.currentTime) || 0) * 1000);
    return { plan, items: window.AsrEditorUtils.assStackFrame(plan, timeMs).items };
  }

  function playResPoint(event, plan) {
    const rect = MaweDom.overlayEl?.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: (event.clientX - rect.left) / rect.width * plan.width,
      y: (event.clientY - rect.top) / rect.height * plan.height,
    };
  }

  function hitAt(event) {
    const mp = multiplayer();
    if (!mp?.isEnabled() || MaweSettings.EDITOR_SETTINGS.assMode !== true) return null;
    const frame = previewFrame();
    if (!frame?.items?.length) return null;
    const point = playResPoint(event, frame.plan);
    if (!point) return null;
    const item = mp.utils.multiplayerHitTest(frame.items, point.x, point.y);
    return item?.multiplayer ? { item, point, plan: frame.plan } : null;
  }

  function scheduleRefresh() {
    if (refreshFrame) return;
    refreshFrame = requestAnimationFrame(() => {
      refreshFrame = 0;
      MawePlaybackLoop.refreshSubtitlePreview?.();
    });
  }

  function onPointerDown(event) {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const hit = hitAt(event);
    if (!hit) return;
    event.preventDefault();
    event.stopPropagation();
    const mp = multiplayer();
    const track = hit.item.multiplayer.track;
    const id = hit.item.segment.id;
    const startOffset = mp.utils.resolveMultiplayerOffset(mp.data(), track, hit.item.segment);
    drag = { pointerId: event.pointerId, track, id, startOffset, startPoint: hit.point, plan: hit.plan,
      command: MaweCommands.begin('拖动字幕位置'), moved: false, stage: event.currentTarget };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch (_) { /* 旧浏览器忽略 */ }
  }

  function onPointerMove(event) {
    if (!drag) {
      const stage = event.currentTarget;
      const hovering = Boolean(hitAt(event));
      if (hovering) stage.dataset.mpHover = 'true';
      else delete stage.dataset.mpHover;
      return;
    }
    if (event.pointerId !== drag.pointerId) return;
    const point = playResPoint(event, drag.plan);
    if (!point) return;
    const offset = {
      x: drag.startOffset.x + (point.x - drag.startPoint.x) / drag.plan.width,
      y: drag.startOffset.y + (point.y - drag.startPoint.y) / drag.plan.height,
    };
    drag.moved = true;
    const mp = multiplayer();
    mp.writeCues(mp.utils.setMultiplayerCuePlacement(mp.data(), drag.track, drag.id, { offset }));
    scheduleRefresh();
  }

  function onPointerUp(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { command, moved } = drag;
    try { drag.stage.releasePointerCapture(event.pointerId); } catch (_) { /* 已释放 */ }
    drag = null;
    if (moved) command.commit({ preview: 'refresh' });
    else command.cancel();
    panelKey = '';
    syncPanel();
  }

  function bindStage() {
    const stage = MaweDom.playerStage || document.querySelector('.player-stage');
    if (!stage || stage.dataset.mpPlacementBound) return;
    stage.dataset.mpPlacementBound = 'true';
    stage.addEventListener('pointerdown', onPointerDown, true);
    stage.addEventListener('pointermove', onPointerMove, true);
    stage.addEventListener('pointerup', onPointerUp, true);
    stage.addEventListener('pointercancel', onPointerUp, true);
  }

  function injectStyles() {
    if (document.getElementById('mp-multiplayer-placement-styles')) return;
    const style = document.createElement('style');
    style.id = 'mp-multiplayer-placement-styles';
    style.textContent = `
    .mp-placement-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 8px; font-size: 12px; color: var(--text-muted); }
    .mp-placement-row[hidden] { display: none; }
    .mp-placement-row label { display: inline-flex; align-items: center; gap: 4px; }
    .mp-placement-row select, .mp-placement-row input { min-height: 24px; font-size: 12px; color: var(--text-primary);
      background: var(--bg-input); border: 1px solid var(--border); border-radius: var(--radius-sm, 4px); }
    .mp-placement-row input { width: 64px; }
    .mp-placement-row button { min-height: 24px; padding: 2px 8px; font-size: 12px; cursor: pointer; color: var(--text-secondary);
      background: var(--bg-input); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm, 4px); }
    .player-stage[data-mp-hover="true"] { cursor: move; }
    `;
    document.head.append(style);
  }

  injectStyles();
  bindStage();
  syncPanel();
  multiplayer()?.onChange(() => { panelKey = ''; syncPanel(); });
  setInterval(syncPanel, PANEL_POLL_MS);

  global.MaweMultiplayerPlacement = Object.freeze({ shiftSlotForSelection, syncPanel, slotName });
})(typeof window !== 'undefined' ? window : globalThis);
