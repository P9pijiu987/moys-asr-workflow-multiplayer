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

  // 文字 + 头像的整体框（坐标相对文字锚点，即导出的 \pos）：
  // - 无头像：\an2，文字底边居中；
  // - 头像在左：\an1，文字左缘贴在「头像右缘 + 间距」；头像在右：\an3，文字右缘贴在
  //   「头像左缘 − 间距」；头像在上：\an2，头像底边在文字顶边之上一个间距。
  // 文字锚定在贴近头像的一侧，浏览器与 libass 的测宽差异只会让整体中心略偏，
  // 头像与文字的间距始终精确。centerOffset 是整体框中心相对文字锚点的水平偏移。
  function placeBox(cue, avatar, start, end, measure, profile, height) {
    if (!avatar) {
      const rect = dependencies.assStackCueBounds(cue, start, end, 2, measure, profile);
      return { alignment: 2, rect, textRect: rect, centerOffset: 0, avatar: null };
    }
    const style = avatar.style;
    const fontSize = Math.max(1, Number(cue.fontSize) || 1);
    const size = Math.max(1, style.size_em * fontSize);
    const gap = style.gap_em * fontSize;
    const alignment = style.position === 'left' ? 1 : style.position === 'right' ? 3 : 2;
    const textRect = dependencies.assStackCueBounds(cue, start, end, alignment, measure, profile);
    // 包围盒两侧各含相同的描边 / 阴影留白，互相抵消后得到文字本身的宽高。
    const textWidth = alignment === 1 ? textRect.right + textRect.left
      : alignment === 3 ? -(textRect.left + textRect.right) : textRect.right - textRect.left;
    const textHeight = Math.max(0, -(textRect.top + textRect.bottom));
    let x;
    let y;
    let centerOffset;
    if (alignment === 1) {
      x = -(gap + size);
      y = -textHeight / 2 - size / 2;
      centerOffset = (textWidth - gap - size) / 2;
    } else if (alignment === 3) {
      x = gap;
      y = -textHeight / 2 - size / 2;
      centerOffset = (gap + size - textWidth) / 2;
    } else {
      x = -size / 2;
      y = -textHeight - gap - size;
      centerOffset = 0;
    }
    const scale = height / 1080;
    const shadow = style.shadow.enabled ? {
      color: style.shadow.color, opacity: style.shadow.opacity,
      blur: style.shadow.blur * scale, x: style.shadow.x * scale, y: style.shadow.y * scale,
    } : null;
    const spread = shadow ? shadow.blur * 2 + Math.max(Math.abs(shadow.x), Math.abs(shadow.y)) : 0;
    const rect = {
      left: Math.min(textRect.left, x - spread),
      right: Math.max(textRect.right, x + size + spread),
      top: Math.min(textRect.top, y - spread),
      bottom: Math.max(textRect.bottom, y + size + spread),
    };
    return {
      alignment, rect, textRect, centerOffset,
      avatar: { assetId: avatar.assetId, x, y, size, opacity: style.opacity, shape: style.shape,
        radius: style.radius, layer: style.layer, shadow },
    };
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
        const avatar = Number.isInteger(item.multiplayerGroup)
          ? dependencies.resolveMultiplayerAvatar(data, item.multiplayerGroup) : null;
        const box = placeBox(cue, avatar, start, end, measure, profile, height);
        const rect = box.rect;
        if (rect.right - rect.left > width - padding * 2 || rect.bottom - rect.top > height - padding * 2) {
          slice.diagnostic = '多人字幕超出画面；请减少该条文字或调小分组样式 / 头像后重试。';
          break;
        }
        // 槽位给出整体框的水平中心与文字底边；文字锚点按头像位置换算。
        const anchor = { x: width / 2 + offset.x * width - box.centerOffset, y: slot.y * height + offset.y * height };
        const slotTop = slotTops.get(slot.id);
        if (slotTop) anchor.y = Math.min(anchor.y, slotTop.top - stackGap(slotTop.fontSize) - rect.bottom);
        anchor.x = Math.min(Math.max(anchor.x, padding - rect.left), width - padding - rect.right);
        anchor.y = Math.min(Math.max(anchor.y, padding - rect.top), height - padding - rect.bottom);
        const top = anchor.y + rect.top;
        if (!slotTop || top < slotTop.top) slotTops.set(slot.id, { top, fontSize: cue.fontSize });
        const placed = { ...cue, alignment: box.alignment, offset: anchor, rect, textRect: box.textRect,
          absolute: true, sharedStackCue: true, multiplayer: { track, slot: slot.id }, avatar: box.avatar };
        slice.items.push(placed);
        if (box.avatar) {
          slice.avatars = slice.avatars || [];
          slice.avatars.push({ start, end, cueStart: item.start, cueEnd: item.end, fad: item.fad,
            ...box.avatar, x: anchor.x + box.avatar.x, y: anchor.y + box.avatar.y });
        }
      }
      if (slice.diagnostic) {
        slice.items = [];
        slice.avatars = [];
        diagnostics.push({ start, end, message: slice.diagnostic });
      }
      slices.push(slice);
    }
    // 头像落点（PlayRes 绝对坐标），供 Canvas 预览、实际帧与烧录叠加使用。
    const avatars = slices.flatMap((slice) => slice.avatars || []);
    return { slices, diagnostics, width, height, avatars };
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
