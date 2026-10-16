// [multiplayer] 槽位排版纯函数：槽位、覆盖、偏移、同槽让位、出画钳制，以及导出 \pos 与预览帧锚点一致。
import { loadEditorModule } from './helpers/editor-module-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

const context = { window: {} };
loadEditorModule(context, 'shared/editor-utils.js');
const h = context.window.AsrEditorUtils;
const m = context.window.AsrMultiplayerUtils;
const plain = (value) => JSON.parse(JSON.stringify(value));
const profile = h.normalizeAssProfile({ animations: {} });
const style = h.normalizeAssStyle({ fontSize: 50, outline: 0, shadow: 0, marginL: 10, marginR: 10 });
const measure = (_style, fontSize, _run, text) => ({ width: [...text].length * fontSize, ascent: fontSize * 0.8, descent: fontSize * 0.2 });
const item = (role, id, start, end, text = 'ABCD', size = 50) => ({ role, index: 0, start, end,
  style: size === 50 ? style : { ...style, fontSize: size }, fontSize: size,
  segment: { id, start, end, text }, runs: [{ text }], styleName: 'MP01', fad: null });

function plan(items, cues = {}, extra = {}) {
  const data = m.normalizeMultiplayer({ enabled: true, cues, ...extra });
  return m.createMultiplayerLayoutPlan({ items, data, profile, width: 1000, height: 1000, measure });
}
const anchors = (result, time) => h.assStackFrame(result, time).items.map((entry) => ({
  id: entry.segment.id, x: entry.anchor.x, y: entry.anchor.y, an: entry.alignment }));

test('tracks sit on their default slots with bottom-centre anchors', () => {
  const result = plan([item('main', 'm', 0, 1000), item('overlay', 'o', 0, 1000), item('extension', 'e', 0, 1000)]);
  assert.deepEqual(plain(result.diagnostics), []);
  assert.deepEqual(plain(anchors(result, 500)).sort((a, b) => a.id.localeCompare(b.id)), [
    { id: 'e', x: 500, y: 720, an: 2 }, { id: 'm', x: 500, y: 920, an: 2 }, { id: 'o', x: 500, y: 820, an: 2 },
  ]);
  assert.ok(result.slices.every((slice) => !slice.legacy && slice.items.every((entry) => entry.absolute)));
});

test('slot overrides, custom slot heights and offsets move a single block', () => {
  const result = plan([item('main', 'm', 0, 1000), item('main', 'n', 1000, 2000)], {
    'main/m': { slot: 'top' },
    'main/n': { offset: { x: -0.1, y: -0.05 } },
  }, { slots: [{ id: 'bottom', y: 0.9 }, { id: 'middle', y: 0.8 }, { id: 'top', y: 0.5 }] });
  assert.deepEqual(plain(anchors(result, 500)), [{ id: 'm', x: 500, y: 500, an: 2 }]);
  assert.deepEqual(plain(anchors(result, 1500)), [{ id: 'n', x: 400, y: 850, an: 2 }]);
});

test('blocks sharing a slot stack upward in start order instead of overlapping', () => {
  const result = plan([item('main', 'm', 0, 2000), item('overlay', 'o', 500, 1500)], { 'overlay/o': { slot: 'bottom' } });
  const [first, second] = anchors(result, 1000);
  assert.equal(first.id, 'm');
  assert.equal(first.y, 920);
  const shared = result.slices.find((slice) => slice.start === 500);
  const mainRect = shared.items[0].rect;
  const overlayRect = shared.items[1].rect;
  assert.ok(second.y + overlayRect.bottom <= first.y + mainRect.top - 2, 'second block clears the first one');
  // 前后时段只有一块时仍回到槽位。
  assert.deepEqual(plain(anchors(result, 1800)), [{ id: 'm', x: 500, y: 920, an: 2 }]);
});

test('offsets are clamped so blocks stay inside the frame', () => {
  const result = plan([item('main', 'm', 0, 1000, 'ABCDEFGH')], { 'main/m': { offset: { x: 1, y: 1 } } });
  const [entry] = h.assStackFrame(result, 500).items;
  assert.ok(entry.anchor.x + entry.rect.right <= 1000);
  assert.ok(entry.anchor.y + entry.rect.bottom <= 1000);
});

test('an oversized block is reported instead of painting off-screen', () => {
  assert.equal(plan([item('main', 'm', 0, 1000, 'X\nX\nX')]).diagnostics.length, 0);
  const oversized = plan([item('main', 'h', 0, 1000, 'X\nX\nX\nX', 400)]);
  assert.match(oversized.diagnostics[0].message, /超出画面/);
  assert.equal(h.assStackFrame(oversized, 500).items.length, 0);
});

test('hit testing finds the block under a PlayRes point', () => {
  const result = plan([item('main', 'm', 0, 1000), item('extension', 'e', 0, 1000)]);
  const frame = h.assStackFrame(result, 500).items;
  assert.equal(m.multiplayerHitTest(frame, 500, 900)?.segment.id, 'm');
  assert.equal(m.multiplayerHitTest(frame, 500, 700)?.segment.id, 'e');
  assert.equal(m.multiplayerHitTest(frame, 20, 20), null);
});

test('exported \\pos equals the preview frame anchor (export / Canvas / libass share one plan)', () => {
  const data = m.normalizeMultiplayer({ enabled: true, cues: { 'overlay/o': { offset: { x: 0.05, y: 0 } } } });
  let captured = null;
  const ass = h.buildAssPayload([{ id: 'm', start: 0, end: 1000, text: 'MAIN' }], {
    assProfile: profile, assStyle: h.ASS_DEFAULT_ASS_STYLE, multiplayer: data, playResX: 1920, playResY: 1080,
    overlaySegments: [{ id: 'o', start: 0, end: 1000, text: 'OVER' }], onAssPlan: (value) => { captured = value; },
  });
  const frame = h.assStackFrame(captured, 500).items;
  assert.equal(frame.length, 2);
  for (const entry of frame) {
    const line = ass.split('\n').find((value) => value.startsWith('Dialogue:') && value.endsWith(entry.segment.text));
    const [x, y] = /\\pos\(([^)]+)\)/u.exec(line)[1].split(',').map(Number);
    assert.equal(x, Number(entry.anchor.x.toFixed(4)));
    assert.equal(y, Number(entry.anchor.y.toFixed(4)));
  }
});

test('slot helpers order bottom-to-top and placement writes drop defaults', () => {
  const data = m.normalizeMultiplayer({});
  assert.deepEqual(plain(m.multiplayerSlotOrder(data)), ['bottom', 'middle', 'top']);
  const cues = m.setMultiplayerCuePlacement(data, 'main', 'm', { slot: 'top', offset: { x: 0.1, y: 0 } });
  assert.deepEqual(plain(cues), { 'main/m': { slot: 'top', offset: { x: 0.1, y: 0 } } });
  const cleared = m.setMultiplayerCuePlacement({ ...data, cues }, 'main', 'm', { slot: 'bottom', offset: { x: 0, y: 0 } });
  assert.deepEqual(plain(cleared), {});
});

const avatarData = (style = {}) => m.normalizeMultiplayer({
  enabled: true,
  groups: [{ name: 'A', avatar: 'av1', avatar_style: style }],
  assets: { av1: { mime: 'image/png', width: 64, height: 64, data: 'iVBORw0KGgo=' } },
});
const avatarItem = (text = 'ABCD') => ({ ...item('main', 'm', 0, 1000, text), multiplayerGroup: 0 });
const planWith = (data, items) => m.createMultiplayerLayoutPlan({ items, data, profile, width: 1000, height: 1000, measure });

test('avatar on the left: whole box is centred and the text is left-anchored right after the gap', () => {
  // 默认：头像 1.2 × 字号（60px），间距 0.25 × 字号（12.5px）；文字宽 4 × 50 = 200。
  const result = planWith(avatarData({ position: 'left' }), [avatarItem()]);
  const [entry] = h.assStackFrame(result, 500).items;
  assert.equal(entry.alignment, 1);
  const avatarLeft = entry.anchor.x + entry.avatar.x;
  const avatarRight = avatarLeft + entry.avatar.size;
  assert.equal(entry.avatar.size, 60);
  assert.equal(entry.anchor.x - avatarRight, 12.5, 'gap between avatar and text is exact');
  const boxCentre = (avatarLeft + entry.anchor.x + 200) / 2;
  assert.equal(boxCentre, 500, 'avatar + gap + text is centred as one box');
  // 头像与文字块垂直居中对齐（文字高 50，底边在槽位 920）。
  assert.equal(entry.anchor.y + entry.avatar.y + 30, 920 - 25);
  assert.equal(result.avatars.length, 1);
  assert.equal(result.avatars[0].x, avatarLeft);
});

test('avatar on the right anchors the text by its right edge; avatar on top stacks above the text', () => {
  const right = h.assStackFrame(planWith(avatarData({ position: 'right' }), [avatarItem()]), 500).items[0];
  assert.equal(right.alignment, 3);
  assert.equal(right.anchor.x + right.avatar.x - right.anchor.x, 12.5);
  assert.equal(((right.anchor.x - 200) + (right.anchor.x + 12.5 + 60)) / 2, 500);
  const top = h.assStackFrame(planWith(avatarData({ position: 'top', gap_em: 0.5 }), [avatarItem()]), 500).items[0];
  assert.equal(top.alignment, 2);
  assert.equal(top.anchor.x, 500);
  assert.equal(top.anchor.y + top.avatar.y + top.avatar.size, 920 - 50 - 25);
  assert.equal(top.anchor.x + top.avatar.x, 500 - 30);
});

test('avatar style resolves defaults with per-group overrides and scales shadows with resolution', () => {
  const data = m.normalizeMultiplayer({
    enabled: true,
    avatar_defaults: { size_em: 2, layer: 'below', shadow: { enabled: true, blur: 10, x: 4, y: 4 } },
    groups: [{ avatar: 'av1', avatar_style: { size_em: 1, shape: 'rounded', bogus: 1 } }],
    assets: { av1: { mime: 'image/png', width: 8, height: 8, data: 'iVBORw0KGgo=' }, bad: { mime: 'text/plain', width: 1, height: 1, data: 'x' } },
  });
  assert.deepEqual(plain(Object.keys(data.assets)), ['av1']);
  assert.deepEqual(plain(data.groups[0].avatar_style), { size_em: 1, shape: 'rounded' });
  const resolved = m.resolveMultiplayerAvatar(data, 0);
  assert.equal(resolved.style.size_em, 1);
  assert.equal(resolved.style.layer, 'below');
  assert.equal(resolved.style.shadow.blur, 10);
  assert.equal(m.resolveMultiplayerAvatar(data, 1), null);
  const big = m.createMultiplayerLayoutPlan({ items: [avatarItem()], data, profile, width: 1920, height: 2160, measure });
  assert.equal(big.avatars[0].shadow.blur, 20);
  assert.deepEqual(plain(m.unusedMultiplayerAssets({ ...data, groups: [] })), ['av1']);
});

test('the avatar is part of the hit box so dragging it moves the whole block', () => {
  const result = planWith(avatarData({ position: 'left' }), [avatarItem()]);
  const frame = h.assStackFrame(result, 500).items;
  const avatar = result.avatars[0];
  assert.equal(m.multiplayerHitTest(frame, avatar.x + 5, avatar.y + avatar.size / 2)?.segment.id, 'm');
});

const markData = (marks, extra = {}) => m.normalizeMultiplayer({
  enabled: true,
  groups: [{ name: 'A' }, { name: 'B', avatar: 'av2' }],
  assets: { av2: { mime: 'image/png', width: 8, height: 8, data: 'iVBORw0KGgo=' } },
  cues: { 'main/m': { marks } },
  ...extra,
});
const fragmentsAt = (result, time) => h.assStackFrame(result, time).items.map((entry) => ({
  text: entry.runs.map((run) => run.text).join(''), an: entry.alignment, x: entry.anchor.x, y: entry.anchor.y }));

test('a name mark splits the line and centres a translucent avatar exactly under the name', () => {
  // ABCDEFGH（8 × 50 = 400 宽）居中于 500：行左缘 300；名字 CD 位于 400–500，中心 450。
  const data = markData([{ text: 'CD', occurrence: 0, group: 'g02' }]);
  const result = planWith(data, [item('main', 'm', 0, 1000, 'ABCDEFGH')]);
  assert.deepEqual(plain(fragmentsAt(result, 500)), [
    { text: 'AB', an: 3, x: 400, y: 920 },
    { text: 'CD', an: 2, x: 450, y: 920 },
    { text: 'EFGH', an: 1, x: 500, y: 920 },
  ]);
  const [avatar] = result.avatars;
  assert.equal(avatar.layer, 'below');
  assert.equal(avatar.opacity, 40);
  assert.equal(avatar.size, 70, 'default 1.4 × font size');
  assert.equal(avatar.x + avatar.size / 2, 450, 'avatar shares the name centre');
  assert.equal(avatar.y + avatar.size / 2, 920 - 25, 'vertically centred on the line');
  // 命中框仍是整条字幕：点在别的片段上也能拖动整条。
  assert.equal(m.multiplayerHitTest(h.assStackFrame(result, 500).items, 320, 900)?.segment.id, 'm');
});

test('marks pick the requested occurrence, handle several names, other lines and skip stale text', () => {
  const data = markData([
    { text: 'AB', occurrence: 1, group: 'g02' },
    { text: 'XY', occurrence: 0, group: 'g02' },
    { text: 'ZZ', occurrence: 0, group: 'g02' }, // 文字已不存在
    { text: 'CD', occurrence: 0, group: 'g01' }, // 分组没有头像
  ]);
  const result = planWith(data, [item('main', 'm', 0, 1000, 'ABxAB\nXYQ')]);
  const fragments = plain(fragmentsAt(result, 500));
  // 第一行 ABxAB：第二个 AB 被标记；第二行 XYQ：XY 被标记，Q 跟在后面。
  assert.deepEqual(fragments.map((entry) => [entry.text, entry.an]), [
    ['ABx', 3], ['AB', 2], ['XY', 2], ['Q', 1],
  ]);
  assert.equal(fragments[1].y, fragments[0].y);
  assert.equal(fragments[2].y, 920, 'last line sits on the slot');
  assert.equal(fragments[0].y, 870, 'first line is one line height above');
  assert.equal(result.avatars.length, 2);
});

test('the speaker prefix is not matched and stays on the first fragment', () => {
  const data = markData([{ text: 'B', occurrence: 0, group: 'g02' }]);
  const labelled = { ...item('main', 'm', 0, 1000, 'xByB'), runs: [{ text: 'B：', speakerColor: '#fff' }, { text: 'xByB' }] };
  const fragments = plain(fragmentsAt(planWith(data, [labelled]), 500));
  assert.deepEqual(fragments.map((entry) => [entry.text, entry.an]), [['B：x', 3], ['B', 2], ['yB', 1]]);
});

test('ASS export writes one positioned event per fragment and the mark avatar section', () => {
  const data = markData([{ text: 'CD', occurrence: 0, group: 'g02' }]);
  const ass = h.buildAssPayload([{ id: 'm', start: 0, end: 1000, text: 'ABCDEFGH' }], {
    assProfile: profile, assStyle: h.ASS_DEFAULT_ASS_STYLE, multiplayer: data, playResX: 1920, playResY: 1080,
  });
  const events = ass.split('\n').filter((line) => line.startsWith('Dialogue:'));
  assert.deepEqual(events.map((line) => /\\an(\d)/u.exec(line)[1] + line.slice(line.lastIndexOf('}') + 1)), ['3AB', '2CD', '1EFGH']);
  assert.match(ass, /\[MAW Multiplayer Avatars\]\n.*\nFormat:.*\nAvatar: 0,1000,av2,[^\n]*,40,circle,0\.2,below,/u);
});

test('marks from a textarea selection record text and occurrence', () => {
  assert.deepEqual(plain(m.multiplayerMarkFromSelection('阿明说阿明来了', 3, 5)), { text: '阿明', occurrence: 1 });
  assert.deepEqual(plain(m.multiplayerMarkFromSelection('阿明说', 0, 2)), { text: '阿明', occurrence: 0 });
  assert.deepEqual(plain(m.multiplayerMarkFromSelection(' 阿明 ', 0, 4)), { text: '阿明', occurrence: 0 });
  assert.equal(m.multiplayerMarkFromSelection('abc', 1, 1), null);
  const cues = m.setMultiplayerCueMarks(markData([]), 'main', 'm', [{ text: '阿明', occurrence: 0, group: 'g02' }, { text: '', group: 'g02' }]);
  assert.deepEqual(plain(cues), { 'main/m': { marks: [{ text: '阿明', occurrence: 0, group: 'g02' }] } });
  assert.deepEqual(plain(m.setMultiplayerCueMarks({ cues }, 'main', 'm', [])), {});
});

test('preview avatars on fragments match the plan avatars exactly (no duplicated cue avatar)', () => {
  const data = m.normalizeMultiplayer({
    enabled: true,
    groups: [{ name: 'A', avatar: 'av1' }, { name: 'B', avatar: 'av2' }],
    assets: { av1: { mime: 'image/png', width: 8, height: 8, data: 'iVBORw0KGgo=' }, av2: { mime: 'image/png', width: 8, height: 8, data: 'iVBORw0KGgo=' } },
    cues: { 'main/m': { marks: [{ text: 'CD', occurrence: 0, group: 'g02' }] } },
  });
  const result = planWith(data, [{ ...item('main', 'm', 0, 1000, 'ABCDEFGH'), multiplayerGroup: 0 }]);
  const frame = h.assStackFrame(result, 500).items;
  const fromFrame = frame.flatMap((entry) => (entry.avatars || (entry.avatar ? [entry.avatar] : []))
    .map((avatar) => ({ id: avatar.assetId, x: entry.anchor.x + avatar.x, y: entry.anchor.y + avatar.y, layer: avatar.layer })));
  const fromPlan = result.avatars.map((avatar) => ({ id: avatar.assetId, x: avatar.x, y: avatar.y, layer: avatar.layer }));
  const sort = (list) => plain(list).sort((a, b) => a.x - b.x);
  assert.equal(fromFrame.length, 2);
  assert.deepEqual(sort(fromFrame), sort(fromPlan));
});
