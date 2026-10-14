// [multiplayer] ASS 分组样式导出，以及「关闭态与上游逐字节一致」的等价性回归（约束 C1）。
import { loadEditorModule } from './helpers/editor-module-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

const context = { window: {} };
loadEditorModule(context, 'shared/editor-utils.js');
const h = context.window.AsrEditorUtils;
const m = context.window.AsrMultiplayerUtils;

const profile = h.normalizeAssProfile({ animations: {} });
const main = [
  { id: 'main-001', start: 0, end: 1500, text: '左边有人', color: { name: 'green', value: '#66bb6a', start: 0, end: 1500 } },
  { id: 'main-002', start: 1500, end: 3000, text: '我来了', speaker: '2' },
  { id: 'main-003', start: 3000, end: 4000, text: '**撤**', color_ref: { name: 'green', headIdx: 0 } },
];
const overlay = [{ id: 'overlay-001', start: 500, end: 2000, text: '叠加' }];
const extension = [{ id: 'tr-segment-001', start: 200, end: 1200, text: 'Extension' }];
const fullData = m.normalizeMultiplayer({
  enabled: true,
  groups: [{ name: '阿明', speaker: '阿明' }, { name: '小红', speaker: '小红', style: { primaryColor: '#ff0000', fontSize: 54 } }],
  speaker_map: { 2: 'g07' },
  cues: { 'overlay/overlay-001': { group: 'g12' }, 'extension/tr-segment-001': { group: 'g01' } },
});
const dialogues = (ass) => ass.split('\n').filter((line) => line.startsWith('Dialogue:'));
const styles = (ass) => ass.split('\n').filter((line) => line.startsWith('Style:'));

const optionSets = {
  assBasic: { assProfile: profile, assStyle: h.ASS_DEFAULT_ASS_STYLE },
  assTracks: {
    assProfile: profile, assStyle: h.ASS_DEFAULT_ASS_STYLE, assExtensionStyle: h.ASS_DEFAULT_EXTENSION_STYLE,
    overlaySegments: overlay, extensionSegments: extension, playResX: 3840, playResY: 2160,
  },
  assSpeakers: {
    assProfile: profile, assStyle: h.ASS_DEFAULT_ASS_STYLE, speakerLabelsEnabled: true,
    speakerLabels: { green: '绿队' }, appearance: { ass_color_style: 'stroke' }, overlaySegments: overlay,
  },
  assFade: {
    assProfile: h.normalizeAssProfile({ animations: { fad: { enabled: true, inMs: 200, outMs: 200 } } }),
    assStyle: h.ASS_DEFAULT_ASS_STYLE, appearance: { ass_color_style: 'speaker' },
  },
  legacy: { appearance: { font_size: 20, color: '#ffeeaa' }, overlaySegments: overlay },
  legacyMultiplayerOn: { appearance: { font_size: 20 }, multiplayer: fullData },
};

test('disabled or absent multiplayer data leaves ASS export byte-identical (C1)', () => {
  const disabled = { ...fullData, enabled: false };
  for (const [name, options] of Object.entries(optionSets)) {
    if (name === 'legacyMultiplayerOn') continue;
    const upstream = h.buildAssPayload(main, options);
    assert.equal(h.buildAssPayload(main, { ...options, multiplayer: disabled }), upstream, `${name}: enabled=false`);
    assert.equal(h.buildAssPayload(main, { ...options, multiplayer: null }), upstream, `${name}: null`);
  }
  // 非 ASS 方案（旧 CSS 外观导出）即使多人开启也不受影响：多人模式只作用于 ASS 方案。
  assert.equal(h.buildAssPayload(main, optionSets.legacyMultiplayerOn),
    h.buildAssPayload(main, { appearance: { font_size: 20 } }));
});

test('every group exports its own MPxx style line, scaled to PlayResY', () => {
  const ass = h.buildAssPayload(main, { ...optionSets.assTracks, multiplayer: fullData });
  const mpStyles = styles(ass).filter((line) => /^Style: MP\d\d,/.test(line));
  assert.equal(mpStyles.length, 12);
  assert.deepEqual(mpStyles.map((line) => line.slice(7, 11)), Array.from({ length: 12 }, (_, i) => `MP${String(i + 1).padStart(2, '0')}`));
  // 第 2 组字号 54（1080p 参考）在 2160p 下导出为 108，文字色 #ff0000 → &H000000FF。
  const mp02 = mpStyles[1].split(',');
  assert.equal(mp02[2], '108');
  assert.equal(mp02[3], '&H000000FF');
  // 原有样式行仍然保留。
  assert.ok(styles(ass).some((line) => line.startsWith('Style: Default,')));
});

test('cues use their group style on all three borrowed tracks, with the group speaker in Name', () => {
  const ass = h.buildAssPayload(main, { ...optionSets.assTracks, multiplayer: fullData });
  const byText = (text) => dialogues(ass).filter((line) => line.endsWith(text) || line.includes(`}${text}`));
  // main-001 绿色 → 第 2 组；main-002 说话人 2 → 第 7 组；main-003 颜色引用 → 第 2 组。
  assert.ok(byText('左边有人').every((line) => line.split(',')[3] === 'MP02' && line.split(',')[4] === '小红'));
  assert.ok(byText('我来了').every((line) => line.split(',')[3] === 'MP07'));
  assert.ok(byText('叠加').every((line) => line.split(',')[3] === 'MP12'));
  assert.ok(byText('Extension').every((line) => line.split(',')[3] === 'MP01' && line.split(',')[4] === '阿明'));
  assert.ok(byText('Extension').length && byText('叠加').length);
  // 原有 Extension / Overlay 角色样式不再被事件引用。
  assert.ok(!dialogues(ass).some((line) => /,(Extension|Overlay[^,]*),/.test(line.split(',').slice(3, 4).join(','))));
});

test('phase 1 keeps role positions: extension stays at its own style anchor', () => {
  const upstream = h.buildAssPayload(main, optionSets.assTracks);
  const grouped = h.buildAssPayload(main, { ...optionSets.assTracks, multiplayer: fullData });
  const pos = (ass, text) => dialogues(ass).find((line) => line.endsWith(text))?.match(/\\pos\(([^)]+)\)/)?.[1];
  assert.equal(pos(grouped, 'Extension'), pos(upstream, 'Extension'));
});

test('speaker labels use the group speaker and the group text colour', () => {
  const ass = h.buildAssPayload(main, { ...optionSets.assSpeakers, multiplayer: fullData });
  const first = dialogues(ass).find((line) => line.includes('左边有人'));
  assert.match(first, /小红：/);
  assert.doesNotMatch(first, /绿队/);
});
