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
