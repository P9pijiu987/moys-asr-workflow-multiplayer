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

  // 名字叠头像的拆段排版（坐标相对于整条字幕的文字锚点 A，结果为 PlayRes 绝对坐标）：
  // - 每一行单独成段，沿用整条字幕的对齐（\an1/\an2/\an3），底边贴在该行底线上；
  // - 含名字的行再拆成「前文 / 名字 / 中间 / 名字 / 后文」：名字以 \an2 居中在算好的位置，
  //   前文以 \an3 右缘贴住名字左缘，其余以 \an1 左缘贴住前一个名字右缘。
  // 头像与名字共用同一个中心点，浏览器与 libass 的测宽差异只影响名字自身宽度带来的
  // 一两个像素字距，不会在整行上累积；整条字幕的位置、拖动与命中框保持不变。
  function splitMarkedCue(placed, marks, measure) {
    const measurer = (run, text) => dependencies.assMeasureStackRun(placed.style, placed.fontSize, run, text, measure);
    const layout = dependencies.assCanvasLayoutLines(placed.runs, measurer);
    // 内容字符流（不含说话人前缀），行与行之间用换行分隔，记录每个字符所在的行与位置。
    let content = '';
    const where = [];
    layout.lines.forEach((line, lineIndex) => {
      if (lineIndex > 0) { content += '\n'; where.push(null); }
      line.items.forEach((entry, itemIndex) => {
        if (entry.run?.speakerColor) return;
        [...entry.text].forEach((character, charIndex) => {
          content += character;
          where.push({ lineIndex, itemIndex, charIndex });
        });
      });
    });
    // content 按 UTF-16 拼接，where 按码点记录；统一转成码点数组再匹配。
    const chars = [...content];
    const found = [];
    marks.forEach((mark) => {
      const needle = [...mark.text];
      let seen = -1;
      for (let index = 0; index + needle.length <= chars.length; index += 1) {
        if (!needle.every((character, offset) => chars[index + offset] === character)) continue;
        seen += 1;
        if (seen !== mark.occurrence) continue;
        const span = where.slice(index, index + needle.length);
        // 名字跨行（被自动折行切开）时不叠头像。
        if (span.every(Boolean) && span.every((entry) => entry.lineIndex === span[0].lineIndex)) {
          found.push({ mark, lineIndex: span[0].lineIndex, from: span[0], to: span[span.length - 1] });
        }
        break;
      }
    });
    if (!found.length) return null;

    const column = (placed.alignment - 1) % 3;
    const anchor = placed.offset;
    const fontSize = Math.max(1, Number(placed.fontSize) || 1);
    const charX = (line, itemIndex, charIndex) => {
      const entry = line.items[itemIndex];
      return entry.x + (charIndex > 0 ? measurer(entry.run, [...entry.text].slice(0, charIndex).join('')).width : 0);
    };
    // 取一行中 [from, to) 位置的 run 片段（位置为 { itemIndex, charIndex }）。
    const sliceRuns = (line, from, to) => {
      const runs = [];
      line.items.forEach((entry, itemIndex) => {
        const characters = [...entry.text];
        const start = itemIndex < from.itemIndex ? characters.length : itemIndex === from.itemIndex ? from.charIndex : 0;
        const stop = itemIndex > to.itemIndex ? 0 : itemIndex === to.itemIndex ? to.charIndex : characters.length;
        if (stop > start) runs.push({ ...entry.run, text: characters.slice(start, stop).join('') });
      });
      return runs;
    };
    // 片段不再各自携带整条字幕的头像；头像以 avatars 列表挂在片段上（坐标相对片段锚点），
    // 整条字幕的头像只挂在第一个片段，名字头像挂在对应的名字片段。
    const fragment = (runs, alignment, x, y) => ({ ...placed, runs, alignment, offset: { x, y },
      rect: { left: placed.rect.left + anchor.x - x, right: placed.rect.right + anchor.x - x,
        top: placed.rect.top + anchor.y - y, bottom: placed.rect.bottom + anchor.y - y },
      avatar: null, avatars: [], multiplayerFragment: true });
    const relative = (avatar, owner) => ({ ...avatar, x: avatar.x - owner.offset.x, y: avatar.y - owner.offset.y });

    const fragments = [];
    const avatars = [];
    let bottom = -layout.blockHeight;
    layout.lines.forEach((line, lineIndex) => {
      const lineHeight = line.ascent + line.descent;
      bottom += lineHeight;
      if (!line.items.length) return;
      const y = anchor.y + bottom;
      const lineMarks = found.filter((entry) => entry.lineIndex === lineIndex)
        .sort((left, right) => left.from.itemIndex - right.from.itemIndex || left.from.charIndex - right.from.charIndex);
      if (!lineMarks.length) {
        fragments.push(fragment(line.items.map((entry) => ({ ...entry.run, text: entry.text })), placed.alignment, anchor.x, y));
        return;
      }
      const lineLeft = anchor.x + (column === 0 ? 0 : column === 1 ? -line.width / 2 : -line.width);
      const begin = { itemIndex: 0, charIndex: 0 };
      const finish = { itemIndex: line.items.length - 1, charIndex: [...line.items[line.items.length - 1].text].length };
      let cursor = begin;
      let previousRight = null;
      lineMarks.forEach(({ mark, from, to }) => {
        const after = { itemIndex: to.itemIndex, charIndex: to.charIndex + 1 };
        const left = lineLeft + charX(line, from.itemIndex, from.charIndex);
        const right = lineLeft + charX(line, after.itemIndex, after.charIndex);
        if (previousRight !== null && left < previousRight) return; // 与前一个名字重叠时忽略
        const center = (left + right) / 2;
        const before = sliceRuns(line, cursor, from);
        if (before.some((run) => run.text)) {
          fragments.push(previousRight === null ? fragment(before, 3, left, y) : fragment(before, 1, previousRight, y));
        }
        const nameFragment = fragment(sliceRuns(line, from, after), 2, center, y);
        fragments.push(nameFragment);
        const size = Math.max(1, mark.style.size_em * fontSize);
        const markAvatar = { assetId: mark.assetId, size, opacity: mark.style.opacity, shape: mark.style.shape,
          radius: mark.style.radius, layer: 'below', shadow: null,
          x: center - size / 2, y: y - lineHeight / 2 + mark.style.offset_y_em * fontSize - size / 2 };
        avatars.push(markAvatar);
        nameFragment.avatars.push(relative(markAvatar, nameFragment));
        cursor = after;
        previousRight = right;
      });
      const rest = sliceRuns(line, cursor, finish);
      if (rest.some((run) => run.text)) fragments.push(fragment(rest, 1, previousRight, y));
    });
    if (placed.avatar && fragments.length) {
      const absolute = { ...placed.avatar, x: anchor.x + placed.avatar.x, y: anchor.y + placed.avatar.y };
      fragments[0].avatars.unshift(relative(absolute, fragments[0]));
    }
    return { fragments, avatars };
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
        slice.avatars = slice.avatars || [];
        const timing = { start, end, cueStart: item.start, cueEnd: item.end, fad: item.fad };
        if (box.avatar) {
          slice.avatars.push({ ...timing, ...box.avatar, x: anchor.x + box.avatar.x, y: anchor.y + box.avatar.y });
        }
        // 名字叠头像：把这条字幕拆成逐行、逐段的片段分别定位，头像以名字为中心垫在文字下方。
        const marks = dependencies.resolveMultiplayerMarks(data, track, item.segment);
        const split = marks.length ? splitMarkedCue(placed, marks, measure) : null;
        if (split) {
          slice.items.push(...split.fragments);
          split.avatars.forEach((avatar) => slice.avatars.push({ ...timing, ...avatar }));
        } else {
          slice.items.push(placed);
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

  // 头像烧录落点：把同一字幕、同一位置的连续分片合并成一段，并按 \fad 计算淡入淡出
  // （只有落点起于字幕开始才淡入、止于字幕结束才淡出；与 Canvas 预览的透明度规则一致）。
  function mergeMultiplayerAvatarPlacements(avatars, profile) {
    const result = [];
    const profileFad = profile?.animations?.fade?.enabled ? null
      : profile?.animations?.fad?.enabled ? profile.animations.fad : null;
    const sameSpot = (left, right) => left.assetId === right.assetId && left.cueStart === right.cueStart
      && left.x === right.x && left.y === right.y && left.size === right.size && left.layer === right.layer;
    for (const avatar of Array.isArray(avatars) ? avatars : []) {
      const previous = result[result.length - 1];
      if (previous && previous.end === avatar.start && sameSpot(previous, avatar)) {
        previous.end = avatar.end;
        continue;
      }
      result.push({ ...avatar });
    }
    return result.map(({ cueStart, cueEnd, fad, ...placement }) => {
      const fade = fad || profileFad;
      return { ...placement,
        fadeIn: fade && placement.start === cueStart ? Math.max(0, Math.round(fade.inMs || 0)) : 0,
        fadeOut: fade && placement.end === cueEnd ? Math.max(0, Math.round(fade.outMs || 0)) : 0 };
    });
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

  return Object.freeze({ createMultiplayerLayoutPlan, mergeMultiplayerAvatarPlacements, multiplayerHitTest });
}
