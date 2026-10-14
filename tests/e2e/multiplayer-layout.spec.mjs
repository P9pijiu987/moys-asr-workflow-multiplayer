// [multiplayer] 多人联机模式第 3 阶段：槽位排版、Alt+↑/↓ 切换槽位、当前字幕面板的槽位与数值偏移。
// 预览拖动依赖真实视频画面，已在浏览器手测；这里验证数据与导出的 \pos。
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
  tempDir = makeTempDir('multiplayer-layout');
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
    name: 'multiplayer-layout.mosp',
    base64: Buffer.from(JSON.stringify(project), 'utf8').toString('base64'),
  });
  await page.dispatchEvent('body', 'drop', { dataTransfer });
  await dataTransfer.dispose();
}

const project = {
  media_metadata: { video_width: 1920, video_height: 1080 },
  segments: [{ id: 'main-001', start: 0, end: 2000, text: 'alpha' }],
  overlay_track: { enabled: true, segments: [{ id: 'overlay-001', start: 0, end: 2000, text: 'over' }] },
  waveform: generateWaveformPayload(4000),
};

const posOf = (ass, text) => {
  const line = ass.split('\n').find((value) => value.startsWith('Dialogue:') && value.endsWith(text));
  const [x, y] = /\\pos\(([^)]+)\)/u.exec(line)[1].split(',').map(Number);
  return { x, y };
};

test('slots drive ASS positions; Alt+Up/Down and the cue panel adjust one block', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await dropProject(page, project);
  await expect(page.locator('.waveform-row').first()).toBeVisible();
  await openSettingsPage(page, 'project-tracks');
  await page.locator('#multiplayer-toggle').check();
  await closeSettingsPanels(page);

  const buildAss = () => page.evaluate(() => MaweExportSrt.buildAss());
  let ass = await buildAss();
  expect(posOf(ass, 'alpha')).toEqual({ x: 960, y: 993.6 });
  expect(posOf(ass, 'over')).toEqual({ x: 960, y: 885.6 });

  // Alt+↑：轨 1 的字幕移到「中」槽位，与轨 2 同槽时按开始顺序向上让位。
  await page.evaluate(() => { document.activeElement?.blur(); MaweSelection.selectOnly(0); });
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(() => page.evaluate(() => MaweMultiplayer.data().cues['main/main-001']?.slot)).toBe('middle');
  ass = await buildAss();
  const alpha = posOf(ass, 'alpha');
  const over = posOf(ass, 'over');
  expect([alpha.y, over.y].sort((a, b) => b - a)[0]).toBe(885.6);
  expect(Math.abs(alpha.y - over.y)).toBeGreaterThan(40);
  await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(() => page.evaluate(() => MaweMultiplayer.data().cues['main/main-001'] ?? null)).toBeNull();

  // 当前字幕面板：数值偏移（百分比）与复位。
  await page.evaluate(() => MaweCuePanel.setCuePanelTarget('main', 0));
  const row = page.locator('#mp-placement-row');
  await expect(row).toBeVisible();
  await expect(page.locator('#mp-placement-slot')).toHaveValue('bottom');
  await page.locator('#mp-placement-x').fill('10');
  await page.locator('#mp-placement-x').press('Enter');
  await page.locator('#mp-placement-y').fill('-5');
  await page.locator('#mp-placement-y').press('Enter');
  await expect.poll(async () => posOf(await buildAss(), 'alpha')).toEqual({ x: 1152, y: 939.6 });
  const spacing = await row.evaluate((element) => element.getBoundingClientRect().top
    - element.previousElementSibling.getBoundingClientRect().bottom);
  expect(spacing).toBeGreaterThanOrEqual(8);
  // 输入框内 Ctrl+Z 归浏览器原生撤销；先移开焦点再撤销上一次偏移。
  await page.locator('#mp-placement-y').blur();
  await page.keyboard.press('Control+z');
  await expect.poll(async () => posOf(await buildAss(), 'alpha')).toEqual({ x: 1152, y: 993.6 });
  // 撤销会清空当前字幕面板目标（上游行为），复位前重新选中该条字幕。
  await page.evaluate(() => MaweCuePanel.setCuePanelTarget('main', 0));
  await page.locator('#mp-placement-reset').click();
  await expect.poll(async () => posOf(await buildAss(), 'alpha')).toEqual({ x: 960, y: 993.6 });
});
