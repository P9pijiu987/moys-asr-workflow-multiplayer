// multiplayer-layout: [multiplayer] 多人联机模式的槽位排版纯函数；依赖由 editor-utils.js 注入。
// ASS 导出、Canvas 即时预览与实际帧（libass 读取导出的 \pos）共用这一份计划：
// 输出与 assCreateStackPlan 同构（slices / items / pieces），且每个字幕项都是
// absolute 定位，导出写 \an + \pos，预览由 assStackFrame 取同一个锚点，三者天然一致。
// 文本测量通过注入的 measure 完成（浏览器字体度量 / Node 确定性回退）。
export function createUtilsModule(dependencies) {
  'use strict';

  const ROLE_ORDER = Object.freeze({ main: 0, overlay: 1, extension: 2 });

  function trackForRole(role) {
    return role === 'overlay' || role === 'extension' ? role : 'main';
  }

  // 同一槽位同时出现多块时，先出现的留在槽位，后出现的依次向上让位。
  function stackGap(fontSize) {
    return Math.max(2, Math.round(Number(fontSize || 0) * 0.2));
  }

  /**
   * @param {{ items?: any[], data?: any, profile?: any, width?: number, height?: number, measure?: any }} [options]
   */
  function createMultiplayerLayoutPlan({ items, data, profile, width = 1920, height = 1080, measure } = {}) {
    const events = new Map();
    const queue = (time, item, active) => {
      if (!events.has(time)) events.set(time, []);
      events.get(time).push({ item, active });
    };
    for (const item of items || []) { queue(item.start, item, true); queue(item.end, item, false); }
    const times = [...events.keys()].sort((a, b) => a - b);
    const active = new Set();
    const slices = [];
    const diagnostics = [];
    const prepared = new Map();
    const padding = Math.max(2, Math.round(height / 135));
    for (let i = 0; i < times.length - 1; i += 1) {
      const start = times[i];
      const end = times[i + 1];
      for (const event of events.get(start)) { if (event.active) active.add(event.item); else active.delete(event.item); }
      if (!active.size || end <= start) continue;
      const ordered = [...active].sort((a, b) => a.start - b.start
        || ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.index - b.index);
      const slice = { start, end, root: ordered[0], profile, width, height, padding, scale: 1,
        items: [], legacy: false, diagnostic: '',
        // 全部字幕项都是 absolute：根位置恒为原点，仅为满足 assStackFrame 的分片结构。
        pieces: [{ start, end, from: { x: 0, y: 0 }, to: { x: 0, y: 0 }, instant: null }],
        box: { left: 0, top: 0, right: width, bottom: height } };
      const slotTops = new Map();
      for (const item of ordered) {
        let cue = prepared.get(item);
        if (!cue) {
          const wrapWidth = Math.max(1, width - (Number(item.style.marginL) || 0) - (Number(item.style.marginR) || 0));
          cue = { ...item, runs: dependencies.assStackWrappedRuns(item, wrapWidth, measure) };
          prepared.set(item, cue);
        }
        const track = trackForRole(item.role);
        const slot = dependencies.resolveMultiplayerSlot(data, track, item.segment);
        const offset = dependencies.resolveMultiplayerOffset(data, track, item.segment);
        // 第 3 阶段：文字块底边居中锚定在槽位上（\an2）。头像加入后，整体框
        // （头像 + 间距 + 文字）居中，文字改为锚定在贴近头像的一侧。
        const alignment = 2;
        const rect = dependencies.assStackCueBounds(cue, start, end, alignment, measure, profile);
        if (rect.right - rect.left > width - padding * 2 || rect.bottom - rect.top > height - padding * 2) {
          slice.diagnostic = '多人字幕超出画面；请减少该条文字或调小分组样式后重试。';
          break;
        }
        const anchor = { x: width / 2 + offset.x * width, y: slot.y * height + offset.y * height };
        const slotTop = slotTops.get(slot.id);
        if (slotTop) anchor.y = Math.min(anchor.y, slotTop.top - stackGap(slotTop.fontSize) - rect.bottom);
        anchor.x = Math.min(Math.max(anchor.x, padding - rect.left), width - padding - rect.right);
        anchor.y = Math.min(Math.max(anchor.y, padding - rect.top), height - padding - rect.bottom);
        const top = anchor.y + rect.top;
        if (!slotTop || top < slotTop.top) slotTops.set(slot.id, { top, fontSize: cue.fontSize });
        slice.items.push({ ...cue, alignment, offset: anchor, rect, absolute: true, sharedStackCue: true,
          multiplayer: { track, slot: slot.id } });
      }
      if (slice.diagnostic) {
        slice.items = [];
        diagnostics.push({ start, end, message: slice.diagnostic });
      }
      slices.push(slice);
    }
    return { slices, diagnostics, width, height };
  }

  // 预览命中测试：返回当前帧中包含 PlayRes 坐标点的最上层字幕项（后绘制者优先）。
  function multiplayerHitTest(frameItems, x, y) {
    const list = Array.isArray(frameItems) ? frameItems : [];
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const item = list[index];
      const anchor = item.anchor || item.offset;
      if (!anchor || !item.rect) continue;
      if (x >= anchor.x + item.rect.left && x <= anchor.x + item.rect.right
        && y >= anchor.y + item.rect.top && y <= anchor.y + item.rect.bottom) return item;
    }
    return null;
  }

  return Object.freeze({ createMultiplayerLayoutPlan, multiplayerHitTest });
}
