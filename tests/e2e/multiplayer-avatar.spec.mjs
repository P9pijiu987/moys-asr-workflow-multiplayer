// [multiplayer] 多人联机模式第 4 阶段：分组头像导入（缩放到 ≤512px）、头像样式窗口
// （全局默认 + 分组覆盖）、整体框排版，以及撤销不丢头像资源。
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
  tempDir = makeTempDir('multiplayer-avatar');
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
    name: 'multiplayer-avatar.mosp',
    base64: Buffer.from(JSON.stringify(project), 'utf8').toString('base64'),
  });
  await page.dispatchEvent('body', 'drop', { dataTransfer });
  await dataTransfer.dispose();
}

const project = {
  media_metadata: { video_width: 1920, video_height: 1080 },
  segments: [{ id: 'main-001', start: 0, end: 2000, text: 'alpha' }],
  waveform: generateWaveformPayload(4000),
};

// 在页面里画一张 800×400 的 PNG，经真实的文件选择框导入。
async function choosePng(page) {
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 400;
    const g = canvas.getContext('2d');
    g.fillStyle = '#d9534f';
    g.fillRect(0, 0, 800, 400);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  await page.locator('#mp-avatar-file').setInputFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: Buffer.from(bytes) });
}

const avatarsAt = (page, time) => page.evaluate((t) => {
  let plan = null;
  MaweExportSrt.buildAss({ preview: true, allowAssPlanDiagnostics: true, onAssPlan: (value) => { plan = value; } });
  const frame = window.AsrEditorUtils.assStackFrame(plan, t).items;
  return { avatars: plan.avatars.filter((avatar) => avatar.start <= t && avatar.end > t),
    text: frame.map((item) => ({ an: item.alignment, x: item.anchor.x, y: item.anchor.y })) };
}, time);

test('group avatars import, follow default and per-group styles, and survive undo', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await dropProject(page, project);
  await expect(page.locator('.waveform-row').first()).toBeVisible();
  await openSettingsPage(page, 'project-tracks');
  await page.locator('#multiplayer-toggle').check();
  await expect(page.locator('#multiplayer-open-avatars')).toBeVisible();
  await page.locator('#multiplayer-open-avatars').click();
  await closeSettingsPanels(page);
  const panel = page.locator('#mp-avatar-window');
  await expect(panel).toBeVisible();

  // 选择分组 1，导入头像：最长边缩放到 512。
  await panel.locator('[data-avatar-scope="g01"]').click();
  await choosePng(page);
  await expect.poll(() => page.evaluate(() => MaweMultiplayer.data().groups[0].avatar)).toBeTruthy();
  const asset = await page.evaluate(() => {
    const data = MaweMultiplayer.data();
    const value = data.assets[data.groups[0].avatar];
    return { width: value.width, height: value.height, mime: value.mime };
  });
  expect(asset).toEqual({ width: 512, height: 256, mime: 'image/png' });

  // 默认头像在左：文字 \an1，整体框居中。
  let state = await avatarsAt(page, 1000);
  expect(state.avatars).toHaveLength(1);
  expect(state.text[0].an).toBe(1);
  expect(state.avatars[0].x + state.avatars[0].size).toBeLessThan(state.text[0].x);

  // 全局默认改为「上」，分组 1 单独覆盖为「右」。
  await panel.locator('[data-avatar-scope="defaults"]').click();
  await panel.locator('select[data-avatar-field="position"]').selectOption('top');
  state = await avatarsAt(page, 1000);
  expect(state.text[0].an).toBe(2);
  await panel.locator('[data-avatar-scope="g01"]').click();
  await expect(panel.locator('select[data-avatar-field="position"]')).toBeDisabled();
  await panel.locator('input[data-avatar-override="position"]').check();
  await panel.locator('select[data-avatar-field="position"]').selectOption('right');
  state = await avatarsAt(page, 1000);
  expect(state.text[0].an).toBe(3);
  expect(state.avatars[0].x).toBeGreaterThan(state.text[0].x);

  // 移除头像、关闭窗口清理未用资源后，撤销仍能找回同一张头像。
  const assetId = await page.evaluate(() => MaweMultiplayer.data().groups[0].avatar);
  await panel.locator('#mp-avatar-remove').click();
  await expect.poll(() => page.evaluate(() => MaweMultiplayer.data().groups[0].avatar)).toBeNull();
  await panel.locator('#mp-avatar-close').click();
  expect(await page.evaluate(() => Object.keys(MaweMultiplayer.data().assets).length)).toBe(0);
  await page.evaluate(() => MaweHistory.performUndo());
  await expect.poll(() => page.evaluate(() => MaweMultiplayer.data().groups[0].avatar)).toBe(assetId);
  expect((await avatarsAt(page, 1000)).avatars).toHaveLength(1);
});
