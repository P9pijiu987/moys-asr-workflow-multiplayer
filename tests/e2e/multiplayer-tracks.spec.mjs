// [multiplayer] 多人联机模式第 2 阶段：三条轨（主轨 / 叠加轨 / 副轨）同时显示、轨间移动、
// 绑定屏蔽，以及关闭模式后恢复上游叠加轨与双语开关。
import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import {
  buildPortableBlankEditor,
  cleanupTempDir,
  closeSettingsPanels,
  disableOnboarding,
  findFreePort,
  generateWaveformPayload,
  makeTempDir,
  openSettingsPage,
  startStaticServer,
} from './helpers.mjs';

let tempDir;
let server;

test.beforeAll(async () => {
  tempDir = makeTempDir('multiplayer-tracks');
  const blankPath = buildPortableBlankEditor(join(tempDir, 'blank-editor.html'));
  server = await startStaticServer(blankPath, await findFreePort());
});

test.afterAll(async () => {
  await server?.stop();
  cleanupTempDir(tempDir);
});

async function dropProject(page, project) {
  const dataTransfer = await page.evaluateHandle((spec) => {
    const bytes = Uint8Array.from(atob(spec.base64), (char) => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], spec.name, { type: 'application/json' }));
    return transfer;
  }, {
    name: 'multiplayer-tracks.mosp',
    base64: Buffer.from(JSON.stringify(project), 'utf8').toString('base64'),
  });
  await page.dispatchEvent('body', 'drop', { dataTransfer });
  await dataTransfer.dispose();
}

const project = {
  segments: [
    { id: 'main-001', start: 0, end: 2000, text: 'alpha' },
    { id: 'main-002', start: 2000, end: 4000, text: 'bravo' },
    { id: 'main-003', start: 4000, end: 6000, text: 'charlie' },
  ],
  overlay_track: { enabled: false, segments: [{ id: 'overlay-001', start: 500, end: 1500, text: 'over' }] },
  multi_subtitle: {
    enabled: true,
    tracks: [{ id: 'tr', segments: [{ id: 'tr-segment-001', start: 0, end: 2000, text: 'ext' }] }],
    bindings: [{ id: 'b1', track_id: 'tr', main_segment_ids: ['main-001'], extension_segment_ids: ['tr-segment-001'],
      start_offset_ms: 0, end_offset_ms: 0 }],
  },
  waveform: generateWaveformPayload(8000),
};

const state = (page) => page.evaluate(() => ({
  mp: MaweMultiplayer.isEnabled(),
  multi: MaweMultiSubtitleCore.getMultiSubtitleState().enabled,
  bindings: MaweMultiSubtitleCore.getMultiSubtitleState().bindings.length,
  overlay: MaweBoot.DATA.overlay_track.enabled,
  main: MaweBoot.DATA.segments.map((segment) => segment.id),
  overlayIds: MaweBoot.DATA.overlay_track.segments.map((segment) => segment.id),
  extension: MaweMultiSubtitleCore.getActiveExtensionTrack().segments.map((segment) => segment.id),
}));

async function setMultiplayer(page, enabled) {
  await openSettingsPage(page, 'project-tracks');
  const toggle = page.locator('#multiplayer-toggle');
  if (enabled) await toggle.check();
  else await toggle.uncheck();
  await closeSettingsPanels(page);
}

test('three tracks display together, cues move between tracks and upstream flags are restored', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await dropProject(page, project);
  await expect(page.locator('.waveform-row').first()).toBeVisible();
  const initialAss = await page.evaluate(() => MaweExportSrt.buildAss());

  // 开启：确认解除双语绑定，叠加轨与双语轨自动显示，三格 lane 带 1/2/3 标签。
  page.once('dialog', (dialog) => dialog.accept());
  await setMultiplayer(page, true);
  expect(await state(page)).toMatchObject({ mp: true, multi: true, bindings: 0, overlay: true });
  const firstRow = page.locator('.waveform-row.multi-subtitle-row').first();
  await expect(firstRow.locator('.mp-lane-label')).toHaveCount(3);
  await expect(firstRow.locator('.waveform-overlay-block')).toHaveCount(1);
  await expect(firstRow.locator('.waveform-cue-block[data-track="extension"]')).toHaveCount(1);
  await expect(page.locator('.mp-group-chip').first()).toBeVisible();

  // 叠加轨 / 双语开关在多人模式下不能被关闭。
  await openSettingsPage(page, 'project-tracks');
  await page.locator('#multi-subtitle-toggle').click();
  await expect(page.locator('#multi-subtitle-toggle')).toBeChecked();
  await closeSettingsPanels(page);

  // 绑定入口被拦截。
  await page.evaluate(() => { MaweSelection.selectOnly(1); MaweSelection.selectOnlyExtension(0, undefined, true, true); });
  await page.evaluate(() => MaweBindingAlign.bindSelectedSubtitlePair());
  expect((await state(page)).bindings).toBe(0);

  // Alt+3：主轨第 3 条移到轨 3；与目标轨重叠的移动被整体拒绝。
  await page.evaluate(() => { document.activeElement?.blur(); MaweSelection.selectOnly(2); });
  await page.keyboard.press('Alt+3');
  await expect.poll(async () => (await state(page)).extension).toEqual(['tr-segment-001', 'main-003']);
  expect((await state(page)).main).toEqual(['main-001', 'main-002']);
  await page.evaluate(() => { document.activeElement?.blur(); MaweState.selection.replace('overlay', [0]); });
  await page.keyboard.press('Alt+1');
  expect((await state(page)).overlayIds).toEqual(['overlay-001']);

  // 撤销移动。
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await state(page)).main).toEqual(['main-001', 'main-002', 'main-003']);

  // 关闭：叠加轨开关恢复为关闭，双语开关恢复为开启；导出与开启前一致。
  await setMultiplayer(page, false);
  expect(await state(page)).toMatchObject({ mp: false, multi: true, overlay: false });
  await expect(page.locator('.mp-lane-label')).toHaveCount(0);
  expect(await page.evaluate(() => MaweExportSrt.buildAss())).toBe(initialAss);
});
