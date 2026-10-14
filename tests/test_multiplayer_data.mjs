// [multiplayer] 多人联机模式纯数据规则：规范化、分组解析优先级、按键映射与 cue 表对账。
import { loadEditorModule } from './helpers/editor-module-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

const context = { window: {} };
loadEditorModule(context, 'shared/editor-utils.js');
const m = context.window.AsrMultiplayerUtils;
const plain = (value) => JSON.parse(JSON.stringify(value));

test('normalize fills 12 groups, default maps, tracks and slots without inventing cues', () => {
  const data = m.normalizeMultiplayer({});
  assert.equal(data.schema, 'maw.multiplayer.v1');
  assert.equal(data.enabled, false);
  assert.equal(data.groups.length, 12);
  assert.deepEqual(plain(data.groups.map((group) => group.id).slice(0, 3)), ['g01', 'g02', 'g03']);
  assert.deepEqual(plain(data.color_map), { yellow: 'g01', green: 'g02', red: 'g03', purple: 'g04', blue: 'g05' });
  assert.deepEqual(plain(data.tracks).main, { label: '轨 1', slot: 'bottom' });
  assert.deepEqual(plain(data.slots).map((slot) => slot.id), ['bottom', 'middle', 'top']);
  assert.deepEqual(plain(data.cues), {});
  // 前 5 组默认文字色与五色调色板一致。
  assert.equal(data.groups[1].style.primaryColor, '#66bb6a');
});

test('normalize keeps unknown fields and rejects unknown schema versions', () => {
  const data = m.normalizeMultiplayer({
    enabled: true,
    future_field: { keep: 1 },
    groups: [{ name: '阿明', speaker: '阿明', extra: 'x', style: { fontSize: 60 } }],
  });
  assert.deepEqual(plain(data.future_field), { keep: 1 });
  assert.equal(data.groups[0].extra, 'x');
  assert.equal(data.groups[0].style.fontSize, 60);
  assert.equal(data.groups[0].style.name, '阿明');
  assert.equal(m.normalizeMultiplayer({ schema: 'maw.multiplayer.v9' }), null);
});

test('normalize clamps offsets, drops invalid cue keys, groups and slots', () => {
  const data = m.normalizeMultiplayer({
    slots: [{ id: 'bottom', y: 2 }, { id: 'BAD id', y: 0.5 }, { id: 'bottom', y: 0.1 }],
    cues: {
      'main/main-001': { group: 'g07', slot: 'bottom', offset: { x: 3, y: -0.5 } },
      'main/main-002': { group: 'g99', slot: 'nowhere', offset: { x: 0, y: 0 } },
      'nope/main-003': { group: 'g01' },
    },
  });
  assert.deepEqual(plain(data.slots), [{ id: 'bottom', y: 1 }]);
  assert.deepEqual(plain(data.cues), { 'main/main-001': { group: 'g07', slot: 'bottom', offset: { x: 1, y: -0.5 } } });
  assert.equal(data.tracks.overlay.slot, 'bottom');
});

test('group keys map 1–9, 0, -, = to groups 1–12', () => {
  assert.deepEqual(['1', '9', '0', '-', '='].map(m.multiplayerGroupIndexForKey), [0, 8, 9, 10, 11]);
  assert.equal(m.multiplayerGroupIndexForKey('a'), -1);
});

test('group resolution prefers explicit cue, then ASR speaker, then colour, then group 1', () => {
  const data = m.normalizeMultiplayer({
    speaker_map: { 7: 'g08' },
    cues: { 'overlay/overlay-001': { group: 'g12' } },
  });
  const segments = [
    { id: 'main-001', color: { name: 'red' } },
    { id: 'main-002', color_ref: { name: 'red', headIdx: 0 } },
    { id: 'main-003', speaker: '7', color: { name: 'blue' } },
    { id: 'main-004' },
  ];
  assert.equal(m.resolveMultiplayerGroupIndex(data, 'main', segments[0], segments), 2);
  assert.equal(m.resolveMultiplayerGroupIndex(data, 'main', segments[1], segments), 2);
  assert.equal(m.resolveMultiplayerGroupIndex(data, 'main', segments[2], segments), 7);
  assert.equal(m.resolveMultiplayerGroupIndex(data, 'main', segments[3], segments), 0);
  assert.equal(m.resolveMultiplayerGroupIndex(data, 'overlay', { id: 'overlay-001' }, []), 11);
  // 同 id 在另一条轨上不会误用 cue 条目。
  assert.equal(m.resolveMultiplayerGroupIndex(data, 'main', { id: 'overlay-001' }, []), 0);
});

test('assign and clear write only the cue table', () => {
  const targets = [{ track: 'main', id: 'main-001' }, { track: 'extension', id: 'tr-segment-001' }];
  const assigned = m.assignMultiplayerGroup({ 'main/main-001': { slot: 'top' } }, targets, 'g03');
  assert.deepEqual(plain(assigned), {
    'main/main-001': { slot: 'top', group: 'g03' },
    'extension/tr-segment-001': { group: 'g03' },
  });
  assert.deepEqual(plain(m.clearMultiplayerGroup(assigned, targets)), { 'main/main-001': { slot: 'top' } });
  assert.deepEqual(plain(m.assignMultiplayerGroup({}, targets, 'g13')), {});
});

test('speaker auto-assignment follows first appearance, keeps existing entries and reports overflow', () => {
  const segments = Array.from({ length: 14 }, (_, index) => ({ speaker: `s${index}` }));
  const result = m.autoAssignMultiplayerSpeakers({ s5: 'g01' }, [segments.slice(0, 7), segments.slice(7)]);
  assert.equal(result.speaker_map.s5, 'g01');
  assert.equal(result.speaker_map.s0, 'g02');
  assert.equal(result.speakers.length, 14);
  assert.equal(result.overflow, 2);
  assert.equal(Object.keys(result.speaker_map).length, 12);
});

test('reconcile inherits entries on split, merge and track moves, and drops deleted cues', () => {
  const cues = {
    'main/a': { group: 'g02' },
    'main/b': { group: 'g03' },
    'main/c': { group: 'g04' },
    'overlay/o': { group: 'g05' },
    'main/gone': { group: 'g06' },
  };
  const before = {
    main: [
      { id: 'a', start: 0, end: 1000 }, { id: 'b', start: 1000, end: 2000 },
      { id: 'c', start: 2000, end: 3000 }, { id: 'gone', start: 5000, end: 6000 },
    ],
    overlay: [{ id: 'o', start: 0, end: 500 }],
    extension: [],
  };
  const after = {
    main: [
      // a 被拆成 a + a2；b、c 合并成 bc；o 从叠加轨移到主轨；gone 被删除。
      { id: 'a', start: 0, end: 600 }, { id: 'a2', start: 600, end: 1000 },
      { id: 'bc', start: 1000, end: 3000 }, { id: 'o', start: 0, end: 500 },
    ],
    overlay: [],
    extension: [],
  };
  assert.deepEqual(plain(m.reconcileMultiplayerCues(cues, before, after)), {
    'main/a': { group: 'g02' },
    'main/a2': { group: 'g02' },
    'main/bc': { group: 'g03' },
    'main/o': { group: 'g05' },
  });
  const unchanged = { 'main/a': { group: 'g02' } };
  assert.equal(m.reconcileMultiplayerCues(unchanged, before, before), unchanged);
});

test('trackSegmentsFromProject maps the three borrowed arrays (scheme A)', () => {
  const tracks = m.trackSegmentsFromProject({
    segments: [{ id: 'm' }],
    overlay_track: { segments: [{ id: 'o' }] },
    multi_subtitle: { tracks: [{ segments: [{ id: 'e' }] }] },
  });
  assert.deepEqual(plain(tracks), { main: [{ id: 'm' }], overlay: [{ id: 'o' }], extension: [{ id: 'e' }] });
  assert.deepEqual(plain(m.trackSegmentsFromProject({})), { main: [], overlay: [], extension: [] });
});
