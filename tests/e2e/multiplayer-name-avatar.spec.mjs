// [multiplayer] 名字叠头像：在字幕文本框里选中名字，叠一层半透明头像在文字下方；
// 拆段导出、默认样式调整、移除与撤销。
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
  tempDir = makeTempDir('multiplayer-name-avatar');
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
    name: 'multiplayer-name-avatar.mosp',
    base64: Buffer.from(JSON.stringify(project), 'utf8').toString('base64'),
  });
  await page.dispatchEvent('body', 'drop', { dataTransfer });
  await dataTransfer.dispose();
}

const project = {
  media_metadata: { video_width: 1920, video_height: 1080 },
  segments: [{ id: 'main-001', start: 0, end: 2000, text: '快看阿明在那边' }],
  waveform: generateWaveformPayload(4000),
};

const planAt = (page, time) => page.evaluate((t) => {
  let plan = null;
  const ass = MaweExportSrt.buildAss({ preview: true });
  MaweExportSrt.buildAss({ preview: true, allowAssPlanDiagnostics: true, onAssPlan: (value) => { plan = value; } });
  const fragments = window.AsrEditorUtils.assStackFrame(plan, t).items.map((item) => ({
    text: item.runs.map((run) => run.text).join(''), an: item.alignment, x: item.anchor.x }));
  const below = plan.avatars.filter((avatar) => avatar.layer === 'below' && avatar.start <= t && avatar.end > t);
  return { fragments, below, events: ass.split('\n').filter((line) => line.startsWith('Dialogue:')).length };
}, time);

test('select a name in the cue text and lay a translucent avatar under it', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await dropProject(page, project);
  await expect(page.locator('.waveform-row').first()).toBeVisible();
  await openSettingsPage(page, 'project-tracks');
  await page.locator('#multiplayer-toggle').check();
  await page.locator('#multiplayer-open-avatars').click();
  await closeSettingsPanels(page);

  // 给分组 2 设置头像。
  const panel = page.locator('#mp-avatar-window');
  await panel.locator('[data-avatar-scope="g02"]').click();
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    canvas.getContext('2d').fillRect(0, 0, 64, 64);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  await page.locator('#mp-avatar-file').setInputFiles({ name: 'b.png', mimeType: 'image/png', buffer: Buffer.from(bytes) });
  await expect.poll(() => page.evaluate(() => MaweMultiplayer.data().groups[1].avatar)).toBeTruthy();

  // 名字头像默认样式：不透明度改为 30%。
  await panel.locator('[data-avatar-scope="defaults"]').click();
  await panel.locator('input[data-avatar-field="mark.opacity"]').fill('30');
  await panel.locator('input[data-avatar-field="mark.opacity"]').press('Enter');
  await expect.poll(() => page.evaluate(() => MaweMultiplayer.data().mark_defaults.opacity)).toBe(30);
  await panel.locator('#mp-avatar-close').click();

  // 在字幕文本框选中「阿明」，选分组 2，叠头像。
  await page.evaluate(() => MaweCuePanel.setCuePanelTarget('main', 0));
  const markRow = page.locator('#mp-mark-row');
  await expect(markRow).toBeVisible();
  await page.locator('#cue-panel-text').evaluate((element) => { element.focus(); element.setSelectionRange(2, 4); });
  await page.locator('#mp-mark-group').selectOption('g02');
  await page.locator('#mp-mark-add').click();
  await expect(page.locator('.mp-mark-chip')).toHaveCount(1);
  await expect(page.locator('.mp-mark-chip')).toContainText('阿明');

  let state = await planAt(page, 1000);
  expect(state.fragments.map((entry) => [entry.text, entry.an])).toEqual([['快看', 3], ['阿明', 2], ['在那边', 1]]);
  expect(state.events).toBe(3);
  expect(state.below).toHaveLength(1);
  expect(state.below[0].opacity).toBe(30);
  expect(state.below[0].x + state.below[0].size / 2).toBeCloseTo(state.fragments[1].x, 5);

  // 改字幕文字使名字消失：标记自动失效，不叠错位置。
  await page.evaluate(() => MaweCommands.run('改字', () => { MaweBoot.DATA.segments[0].text = '快看在那边'; }));
  state = await planAt(page, 1000);
  expect(state.below).toHaveLength(0);
  expect(state.fragments).toHaveLength(1);
  await page.evaluate(() => MaweHistory.performUndo());
  await expect.poll(async () => (await planAt(page, 1000)).below.length).toBe(1);

  // 点击标记移除，再撤销恢复。
  await page.evaluate(() => MaweCuePanel.setCuePanelTarget('main', 0));
  await page.locator('.mp-mark-chip').click();
  await expect.poll(async () => (await planAt(page, 1000)).below.length).toBe(0);
  await page.evaluate(() => MaweHistory.performUndo());
  await expect.poll(async () => (await planAt(page, 1000)).below.length).toBe(1);
});
