// multiplayer-data: [multiplayer] 多人联机模式的纯数据规则；依赖由 editor-utils.js 注入。
// 不触碰 DOM：便携 HTML、localhost 编辑器与 Node 测试共用同一套规范化、
// 分组解析与拆分/合并后的 cue 表对账规则。工程数据只放在顶层 `multiplayer`。
export function createUtilsModule(dependencies) {
  'use strict';
  const { ASS_DEFAULT_ASS_STYLE, cloneJsonValue, effectiveColorName, normalizeAssStyle, stableId, uniqueStableSegmentId } = dependencies;

  const MULTIPLAYER_SCHEMA = 'maw.multiplayer.v1';

  const MULTIPLAYER_GROUP_COUNT = 12;

  // 选中字幕后按键分配分组：1–9、0、-、= 依次对应第 1–12 组。
  const MULTIPLAYER_GROUP_KEYS = Object.freeze(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '=']);

  // 方案甲：三条多人轨借用现有三条字幕数组。
  const MULTIPLAYER_TRACK_KEYS = Object.freeze(['main', 'overlay', 'extension']);

  const MULTIPLAYER_MAX_SLOTS = 5;

  // 前 5 色与 maw/colors.py 的五色一致，便于已有颜色标记平滑映射到第 1–5 组。
  const MULTIPLAYER_DEFAULT_GROUP_COLORS = Object.freeze([
    '#c4a019', '#66bb6a', '#f07f6f', '#bf89e6', '#61a7fa', '#ff8a3d',
    '#4dd0e1', '#f48fb1', '#aed581', '#9575cd', '#ffd54f', '#90a4ae',
  ]);

  const MULTIPLAYER_DEFAULT_COLOR_MAP = Object.freeze({
    yellow: 'g01', green: 'g02', red: 'g03', purple: 'g04', blue: 'g05',
  });

  const MULTIPLAYER_DEFAULT_TRACKS = Object.freeze({
    main: Object.freeze({ label: '轨 1', slot: 'bottom' }),
    overlay: Object.freeze({ label: '轨 2', slot: 'middle' }),
    extension: Object.freeze({ label: '轨 3', slot: 'top' }),
  });

  const MULTIPLAYER_DEFAULT_SLOTS = Object.freeze([
    Object.freeze({ id: 'bottom', y: 0.92 }),
    Object.freeze({ id: 'middle', y: 0.82 }),
    Object.freeze({ id: 'top', y: 0.72 }),
  ]);

  const MULTIPLAYER_TEXT_MAX_LENGTH = 64;

  const SLOT_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/u;

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function multiplayerGroupId(index) {
    return `g${String(index + 1).padStart(2, '0')}`;
  }

  function multiplayerGroupIndex(groupId) {
    const match = /^g(\d{2})$/u.exec(String(groupId ?? ''));
    if (!match) return -1;
    const index = Number(match[1]) - 1;
    return index >= 0 && index < MULTIPLAYER_GROUP_COUNT ? index : -1;
  }

  function multiplayerGroupIndexForKey(key) {
    return MULTIPLAYER_GROUP_KEYS.indexOf(String(key ?? ''));
  }

  function normalizeMultiplayerText(value, fallback = '') {
    if (typeof value !== 'string') return fallback;
    const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
    return normalized.slice(0, MULTIPLAYER_TEXT_MAX_LENGTH);
  }

  function multiplayerDefaultGroupStyle(index) {
    const color = MULTIPLAYER_DEFAULT_GROUP_COLORS[index] || '#ffffff';
    return normalizeAssStyle({
      ...ASS_DEFAULT_ASS_STYLE,
      name: `分组 ${index + 1}`,
      primaryColor: color,
      secondaryColor: color,
      backColor: '#000000',
      backOpacity: 60,
    }, { ...ASS_DEFAULT_ASS_STYLE, builtin: false }, `mp-${multiplayerGroupId(index)}`);
  }

  function normalizeMultiplayerGroup(raw, index) {
    const source = isPlainObject(raw) ? raw : {};
    const id = multiplayerGroupId(index);
    const name = normalizeMultiplayerText(source.name) || `分组 ${index + 1}`;
    const fallback = multiplayerDefaultGroupStyle(index);
    const style = normalizeAssStyle(isPlainObject(source.style) ? { ...source.style, name } : { ...fallback, name },
      fallback, `mp-${id}`);
    style.builtin = false;
    style.name = name;
    const group = {
      ...source,
      id,
      name,
      speaker: normalizeMultiplayerText(source.speaker),
      avatar: stableId(source.avatar) || null,
      style,
    };
    if (source.avatar_style !== undefined && !isPlainObject(source.avatar_style)) delete group.avatar_style;
    return group;
  }

  function normalizeGroupReferenceMap(value, fallback = {}) {
    const source = isPlainObject(value) ? value : fallback;
    const result = {};
    Object.entries(source).forEach(([key, groupId]) => {
      const name = stableId(key);
      if (name && multiplayerGroupIndex(groupId) >= 0) result[name] = groupId;
    });
    return result;
  }

  function normalizeMultiplayerSlots(value) {
    const source = Array.isArray(value) ? value : MULTIPLAYER_DEFAULT_SLOTS;
    const seen = new Set();
    const slots = [];
    source.forEach((raw) => {
      if (!isPlainObject(raw) || slots.length >= MULTIPLAYER_MAX_SLOTS) return;
      const id = String(raw.id ?? '').trim().toLowerCase();
      const y = Number(raw.y);
      if (!SLOT_ID_RE.test(id) || seen.has(id) || !Number.isFinite(y)) return;
      seen.add(id);
      slots.push({ ...raw, id, y: Math.min(1, Math.max(0, y)) });
    });
    return slots.length ? slots : MULTIPLAYER_DEFAULT_SLOTS.map((slot) => ({ ...slot }));
  }

  function normalizeMultiplayerTracks(value, slots) {
    const source = isPlainObject(value) ? value : {};
    const slotIds = new Set(slots.map((slot) => slot.id));
    const result = { ...source };
    MULTIPLAYER_TRACK_KEYS.forEach((key, index) => {
      const raw = isPlainObject(source[key]) ? source[key] : {};
      const fallback = MULTIPLAYER_DEFAULT_TRACKS[key];
      const slot = slotIds.has(raw.slot) ? raw.slot
        : slotIds.has(fallback.slot) ? fallback.slot : slots[Math.min(index, slots.length - 1)].id;
      result[key] = { ...raw, label: normalizeMultiplayerText(raw.label) || fallback.label, slot };
    });
    return result;
  }

  function normalizeMultiplayerOffset(value) {
    if (!isPlainObject(value)) return null;
    const x = Number(value.x);
    const y = Number(value.y);
    const clamp = (number) => (Number.isFinite(number) ? Math.min(1, Math.max(-1, number)) : 0);
    const offset = { x: clamp(x), y: clamp(y) };
    return offset.x === 0 && offset.y === 0 ? null : offset;
  }

  function normalizeMultiplayerCues(value, slotIds) {
    const source = isPlainObject(value) ? value : {};
    const result = {};
    Object.entries(source).forEach(([key, raw]) => {
      if (!parseMultiplayerCueKey(key) || !isPlainObject(raw)) return;
      const entry = { ...raw };
      if (multiplayerGroupIndex(entry.group) < 0) delete entry.group;
      if (entry.slot !== undefined && !slotIds.has(entry.slot)) delete entry.slot;
      const offset = normalizeMultiplayerOffset(entry.offset);
      if (offset) entry.offset = offset;
      else delete entry.offset;
      if (Object.keys(entry).length) result[key] = entry;
    });
    return result;
  }

  // 返回规范化后的新对象；未知子字段原样保留，越界值钳制而不是报错。
  // 无法识别的 schema 返回 null：调用方保留原对象、不启用模式。
  function normalizeMultiplayer(value) {
    const source = isPlainObject(value) ? value : {};
    if (source.schema !== undefined && source.schema !== MULTIPLAYER_SCHEMA) return null;
    const rawGroups = Array.isArray(source.groups) ? source.groups : [];
    const groups = Array.from({ length: MULTIPLAYER_GROUP_COUNT },
      (_, index) => normalizeMultiplayerGroup(rawGroups[index], index));
    const slots = normalizeMultiplayerSlots(source.slots);
    const slotIds = new Set(slots.map((slot) => slot.id));
    return {
      ...source,
      schema: MULTIPLAYER_SCHEMA,
      enabled: source.enabled === true,
      groups,
      color_map: normalizeGroupReferenceMap(source.color_map, MULTIPLAYER_DEFAULT_COLOR_MAP),
      speaker_map: normalizeGroupReferenceMap(source.speaker_map),
      tracks: normalizeMultiplayerTracks(source.tracks, slots),
      slots,
      cues: normalizeMultiplayerCues(source.cues, slotIds),
    };
  }

  function multiplayerCueKey(track, segmentId) {
    const id = stableId(segmentId);
    return MULTIPLAYER_TRACK_KEYS.includes(track) && id ? `${track}/${id}` : '';
  }

  function parseMultiplayerCueKey(key) {
    const text = String(key ?? '');
    const slash = text.indexOf('/');
    if (slash <= 0) return null;
    const track = text.slice(0, slash);
    const id = stableId(text.slice(slash + 1));
    return MULTIPLAYER_TRACK_KEYS.includes(track) && id ? { track, id } : null;
  }

  // 分组解析优先级：cue 表显式分组 → ASR 说话人 → 字幕颜色 → 第 1 组。
  // 说话人先于颜色：ASR 超过 5 人时颜色会回绕，说话人映射才是精确来源。
  function resolveMultiplayerGroupIndex(data, track, segment, trackSegments) {
    if (!data || !segment) return 0;
    const cue = data.cues?.[multiplayerCueKey(track, segment.id)];
    const explicit = multiplayerGroupIndex(cue?.group);
    if (explicit >= 0) return explicit;
    const speaker = typeof segment.speaker === 'string' ? segment.speaker : '';
    const bySpeaker = speaker ? multiplayerGroupIndex(data.speaker_map?.[speaker]) : -1;
    if (bySpeaker >= 0) return bySpeaker;
    const colorName = effectiveColorName(segment, trackSegments);
    const byColor = colorName ? multiplayerGroupIndex(data.color_map?.[colorName]) : -1;
    return byColor >= 0 ? byColor : 0;
  }

  function resolveMultiplayerGroup(data, track, segment, trackSegments) {
    return data?.groups?.[resolveMultiplayerGroupIndex(data, track, segment, trackSegments)] || null;
  }

  // 给一组字幕写入显式分组；返回新的 cues 对象，不修改输入。
  function assignMultiplayerGroup(cues, targets, groupId) {
    const next = { ...(isPlainObject(cues) ? cues : {}) };
    if (multiplayerGroupIndex(groupId) < 0) return next;
    (Array.isArray(targets) ? targets : []).forEach(({ track, id }) => {
      const key = multiplayerCueKey(track, id);
      if (key) next[key] = { ...(next[key] || {}), group: groupId };
    });
    return next;
  }

  function clearMultiplayerGroup(cues, targets) {
    const next = { ...(isPlainObject(cues) ? cues : {}) };
    (Array.isArray(targets) ? targets : []).forEach(({ track, id }) => {
      const key = multiplayerCueKey(track, id);
      if (!key || !next[key]) return;
      const { group: _removed, ...rest } = next[key];
      if (Object.keys(rest).length) next[key] = rest;
      else delete next[key];
    });
    return next;
  }

  // 按说话人首次出现顺序分配到第 1–12 组；已有映射保留。返回 { speaker_map, overflow }。
  function autoAssignMultiplayerSpeakers(speakerMap, segmentLists) {
    const next = normalizeGroupReferenceMap(speakerMap);
    const used = new Set(Object.values(next));
    const order = [];
    (Array.isArray(segmentLists) ? segmentLists : []).forEach((segments) => {
      (Array.isArray(segments) ? segments : []).forEach((segment) => {
        const speaker = stableId(segment?.speaker);
        if (speaker && !order.includes(speaker)) order.push(speaker);
      });
    });
    let overflow = 0;
    order.forEach((speaker) => {
      if (next[speaker]) return;
      let index = 0;
      while (index < MULTIPLAYER_GROUP_COUNT && used.has(multiplayerGroupId(index))) index++;
      if (index >= MULTIPLAYER_GROUP_COUNT) { overflow++; return; }
      next[speaker] = multiplayerGroupId(index);
      used.add(next[speaker]);
    });
    return { speaker_map: next, overflow, speakers: order };
  }

  function trackSegmentsFromProject(project) {
    const extension = Array.isArray(project?.multi_subtitle?.tracks) ? project.multi_subtitle.tracks[0] : null;
    return {
      main: Array.isArray(project?.segments) ? project.segments : [],
      overlay: Array.isArray(project?.overlay_track?.segments) ? project.overlay_track.segments : [],
      extension: Array.isArray(extension?.segments) ? extension.segments : [],
    };
  }

  // 命令提交后的 cue 表对账（一个挂钩覆盖所有编辑操作）：
  // 1. 段 id 换轨（叠加轨 ↔ 主轨）→ 条目随段迁移；
  // 2. 同轨出现的新段（拆分出的右半段、合并结果）→ 继承「编辑前与它时间重叠、
  //    且有条目」的最早一段（拆分时左半段保留原 id，合并时取最早一段）；
  // 3. 仍不存在的段 → 删除条目。返回新 cues；无变化时返回原对象。
  function reconcileMultiplayerCues(cues, before, after) {
    const source = isPlainObject(cues) ? cues : {};
    if (!Object.keys(source).length) return source;
    const index = (lists) => Object.fromEntries(MULTIPLAYER_TRACK_KEYS.map((track) => [track,
      new Map((lists?.[track] || []).filter(Boolean).map((segment) => [stableId(segment.id), segment]))]));
    const beforeIds = index(before);
    const afterIds = index(after);
    const trackOfAfterId = new Map();
    MULTIPLAYER_TRACK_KEYS.forEach((track) => afterIds[track].forEach((_, id) => trackOfAfterId.set(id, track)));
    const next = {};
    let changed = false;
    const donors = Object.fromEntries(MULTIPLAYER_TRACK_KEYS.map((track) => [track, []]));
    const moved = new Set();
    Object.entries(source).forEach(([key, entry]) => {
      const parsed = parseMultiplayerCueKey(key);
      if (!parsed) { changed = true; return; }
      const previous = beforeIds[parsed.track].get(parsed.id);
      if (previous) donors[parsed.track].push({ segment: previous, entry });
      if (afterIds[parsed.track].has(parsed.id)) { next[key] = entry; return; }
      changed = true;
      const movedTrack = trackOfAfterId.get(parsed.id);
      if (movedTrack) {
        const movedKey = multiplayerCueKey(movedTrack, parsed.id);
        if (!source[movedKey]) next[movedKey] = entry;
        moved.add(movedKey);
      }
    });
    MULTIPLAYER_TRACK_KEYS.forEach((track) => {
      if (!donors[track].length) return;
      donors[track].sort((left, right) => Number(left.segment.start) - Number(right.segment.start));
      afterIds[track].forEach((segment, id) => {
        if (beforeIds[track].has(id)) return;
        const key = multiplayerCueKey(track, id);
        if (!key || next[key] || moved.has(key)) return;
        const start = Number(segment.start);
        const end = Number(segment.end);
        const donor = donors[track].find(({ segment: old }) => Number(old.start) < end && Number(old.end) > start);
        if (donor) {
          next[key] = cloneJsonValue(donor.entry);
          changed = true;
        }
      });
    });
    return changed ? next : source;
  }

  // 在三条多人轨之间移动字幕（原地修改 tracks 中的数组）：
  // - 目标轨保持按 start 升序且互不重叠；任一冲突则整体放弃，不做部分移动；
  // - 颜色 / 表情包 ref 只能引用所在数组：被移走段的 ref 物化为自持 head，
  //   留下的组成员按原 head 的对象身份重新定位，head 被移走时由组内首个成员接任；
  // - 移入副轨（轨 3）的段不携带表情包；目标轨 id 冲突时改用不重复的新 id。
  // 返回 { ok, reason?, conflictId?, moved: [{ from, to, id, newId }] }。
  function moveMultiplayerSegments(tracks, targets, targetTrack) {
    if (!MULTIPLAYER_TRACK_KEYS.includes(targetTrack) || !Array.isArray(tracks?.[targetTrack])) {
      return { ok: false, reason: 'invalid-target', moved: [] };
    }
    const lists = Object.fromEntries(MULTIPLAYER_TRACK_KEYS.map((track) => [track, Array.isArray(tracks?.[track]) ? tracks[track] : []]));
    const moving = [];
    const seen = new Set();
    (Array.isArray(targets) ? targets : []).forEach(({ track, id }) => {
      if (track === targetTrack || !lists[track]) return;
      const segment = lists[track].find((item) => stableId(item?.id) === stableId(id));
      if (segment && !seen.has(segment)) {
        seen.add(segment);
        moving.push({ track, segment });
      }
    });
    if (!moving.length) return { ok: false, reason: 'nothing', moved: [] };
    const candidates = [...lists[targetTrack].map((segment) => ({ segment, moving: false })),
      ...moving.map(({ segment }) => ({ segment, moving: true }))]
      .sort((left, right) => Number(left.segment.start) - Number(right.segment.start));
    for (let index = 1; index < candidates.length; index += 1) {
      const previous = candidates[index - 1];
      const current = candidates[index];
      if ((previous.moving || current.moving) && Number(previous.segment.end) > Number(current.segment.start)) {
        return { ok: false, reason: 'overlap', conflictId: (current.moving ? current : previous).segment.id, moved: [] };
      }
    }
    // 记录编辑前每个组成员指向的 head 对象。
    const groupFields = [['color', 'color_ref'], ['sticker', 'sticker_ref']];
    const headOf = new Map(groupFields.map(([, refField]) => [refField, new Map()]));
    MULTIPLAYER_TRACK_KEYS.forEach((track) => {
      lists[track].forEach((segment) => {
        groupFields.forEach(([headField, refField]) => {
          const headIdx = segment?.[refField]?.headIdx;
          const head = Number.isInteger(headIdx) ? lists[track][headIdx] : null;
          if (head?.[headField]) headOf.get(refField).set(segment, head);
        });
      });
    });
    const movingSet = new Set(moving.map(({ segment }) => segment));
    moving.forEach(({ segment }) => {
      const colorHead = headOf.get('color_ref').get(segment);
      if (colorHead && !segment.color) {
        segment.color = { ...cloneJsonValue(colorHead.color), start: segment.start, end: segment.end };
      }
      segment.color_ref = null;
      segment.sticker_ref = null;
      if (targetTrack === 'extension') segment.sticker = null;
    });
    MULTIPLAYER_TRACK_KEYS.forEach((track) => {
      if (track === targetTrack) return;
      for (let index = lists[track].length - 1; index >= 0; index -= 1) {
        if (movingSet.has(lists[track][index])) lists[track].splice(index, 1);
      }
    });
    const moved = [];
    moving.forEach(({ track, segment }) => {
      const target = lists[targetTrack];
      const oldId = stableId(segment.id);
      if (target.some((item) => stableId(item?.id) === oldId)) segment.id = uniqueStableSegmentId(target, oldId, targetTrack);
      let insertAt = target.length;
      for (let index = 0; index < target.length; index += 1) {
        if (Number(target[index].start) > Number(segment.start)) { insertAt = index; break; }
      }
      target.splice(insertAt, 0, segment);
      moved.push({ from: track, to: targetTrack, id: oldId, newId: segment.id });
    });
    // 按 head 对象身份重新定位留下的组成员；head 已移走时由组内首个成员接任。
    MULTIPLAYER_TRACK_KEYS.forEach((track) => {
      const list = lists[track];
      const indexOf = new Map(list.map((segment, index) => [segment, index]));
      groupFields.forEach(([headField, refField]) => {
        const refs = headOf.get(refField);
        const orphanGroups = new Map();
        list.forEach((segment, index) => {
          if (movingSet.has(segment) || !segment[refField]) return;
          const head = refs.get(segment);
          if (!head) return;
          if (indexOf.has(head)) segment[refField].headIdx = indexOf.get(head);
          else {
            if (!orphanGroups.has(head)) orphanGroups.set(head, []);
            orphanGroups.get(head).push(index);
          }
        });
        orphanGroups.forEach((members, head) => {
          const [first, ...rest] = members;
          const leader = list[first];
          const last = list[members[members.length - 1]];
          leader[headField] = { ...cloneJsonValue(head[headField]), start: leader.start, end: last.end };
          leader[refField] = null;
          rest.forEach((index) => { list[index][refField] = { ...list[index][refField], headIdx: first }; });
        });
      });
    });
    return { ok: true, moved };
  }

  return Object.freeze({
    MULTIPLAYER_DEFAULT_COLOR_MAP,
    MULTIPLAYER_DEFAULT_GROUP_COLORS,
    MULTIPLAYER_DEFAULT_SLOTS,
    MULTIPLAYER_DEFAULT_TRACKS,
    MULTIPLAYER_GROUP_COUNT,
    MULTIPLAYER_GROUP_KEYS,
    MULTIPLAYER_MAX_SLOTS,
    MULTIPLAYER_SCHEMA,
    MULTIPLAYER_TRACK_KEYS,
    assignMultiplayerGroup,
    autoAssignMultiplayerSpeakers,
    clearMultiplayerGroup,
    multiplayerCueKey,
    multiplayerDefaultGroupStyle,
    multiplayerGroupId,
    multiplayerGroupIndex,
    multiplayerGroupIndexForKey,
    moveMultiplayerSegments,
    normalizeMultiplayer,
    parseMultiplayerCueKey,
    reconcileMultiplayerCues,
    resolveMultiplayerGroup,
    resolveMultiplayerGroupIndex,
    trackSegmentsFromProject,
  });
}
