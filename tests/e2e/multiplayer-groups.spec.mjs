// [multiplayer] 多人联机模式第 1 阶段：开关、分组快捷键、撤销、样式库分组编辑与 ASS 分组导出。
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
  tempDir = makeTempDir('multiplayer-groups');
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
    name: 'multiplayer.mosp',
    base64: Buffer.from(JSON.stringify(project), 'utf8').toString('base64'),
  });
  await page.dispatchEvent('body', 'drop', { dataTransfer });
  await dataTransfer.dispose();
}

const project = {
  segments: [
    { id: 'main-001', start: 0, end: 1000, text: 'alpha', speaker: 'A' },
    { id: 'main-002', start: 1000, end: 2000, text: 'bravo', speaker: 'B' },
    { id: 'main-003', start: 2000, end: 3000, text: 'charlie', color: { name: 'red', value: '#f07f6f', start: 2000, end: 3000 } },
  ],
  waveform: generateWaveformPayload(4000),
};

const mainColumn = (page, index) => page.locator(`.multi-cue-column.main[data-main-idx="${index}"]`);
const assStyleOf = (ass, text) => ass.split('\n').find((line) => line.startsWith('Dialogue:') && line.endsWith(text))?.split(',')[3];

test('multiplayer mode assigns 12 groups by key, exports MPxx styles and stays upstream-identical when off', async ({ page }) => {
  await disableOnboarding(page);
  await page.goto(server.url);
  await dropProject(page, project);
  await expect(page.locator('.cue[data-idx="2"]')).toHaveCount(1);

  // 关闭态：没有分组徽标，1 键仍是颜色，导出不含 MP 样式。
  await expect(page.locator('.cue[data-mp-group]')).toHaveCount(0);
  const offAss = await page.evaluate(() => MaweExportSrt.buildAss());
  expect(offAss).not.toContain('Style: MP01');

  await openSettingsPage(page, 'project-tracks');
  const toggle = page.locator('#multiplayer-toggle');
  await expect(toggle).toBeVisible();
  await toggle.check();
  await closeSettingsPanels(page);
  // 开启后轨 3（副轨）显示，列表切到双列视图：分组标识挂在主轨列上。
  await expect(page.locator('.multi-cue-column[data-mp-group]')).toHaveCount(3);
  expect(await page.evaluate(() => MaweSettings.EDITOR_SETTINGS.assMode)).toBe(true);
  // 说话人 A/B 按出现顺序分到第 1、2 组；红色字幕映射到第 3 组。
  await expect(mainColumn(page, 0)).toHaveAttribute('data-mp-group', 'g01');
  await expect(mainColumn(page, 1)).toHaveAttribute('data-mp-group', 'g02');
  await expect(mainColumn(page, 2)).toHaveAttribute('data-mp-group', 'g03');

  await page.evaluate(() => { document.activeElement?.blur(); MaweSelection.selectOnly(0); });
  await page.keyboard.press('=');
  await expect(mainColumn(page, 0)).toHaveAttribute('data-mp-group', 'g12');
  await page.keyboard.press('-');
  await expect(mainColumn(page, 0)).toHaveAttribute('data-mp-group', 'g11');
  // 多人模式下 1 键是分组，不再写入颜色。
  await page.keyboard.press('1');
  await expect(mainColumn(page, 0)).toHaveAttribute('data-mp-group', 'g01');
  expect(await page.evaluate(() => MaweBoot.DATA.segments[0].color ?? null)).toBeNull();
  await page.keyboard.press('7');

  let ass = await page.evaluate(() => MaweExportSrt.buildAss());
  expect(ass.split('\n').filter((line) => /^Style: MP\d\d,/.test(line))).toHaveLength(12);
  expect(assStyleOf(ass, 'alpha')).toBe('MP07');
  expect(assStyleOf(ass, 'charlie')).toBe('MP03');

  // 撤销一次回到上一个分组。
  await page.keyboard.press('Control+z');
  await expect(mainColumn(page, 0)).toHaveAttribute('data-mp-group', 'g01');

  // 样式库窗口中的分组：改说话人后导出事件 Name 跟随。
  await page.evaluate(() => MaweMultiplayerGroupsPanel.openGroupStyles('g03'));
  await expect(page.locator('#mp-group-list button')).toHaveCount(12);
  await expect(page.locator('#mp-group-extra')).toBeVisible();
  await page.locator('#mp-group-speaker').fill('红队');
  await page.locator('#mp-group-speaker').press('Enter');
  await page.locator('#mp-group-speaker').blur();
  await expect.poll(() => page.evaluate(() => MaweMultiplayer.group('g03').speaker)).toBe('红队');
  ass = await page.evaluate(() => MaweExportSrt.buildAss());
  expect(ass.split('\n').find((line) => line.startsWith('Dialogue:') && line.endsWith('charlie')).split(',')[4]).toBe('红队');
  await page.locator('#ass-style-window-close').click();

  // 关闭模式：数据保留，导出与开启前一致，1 键恢复颜色功能。
  await openSettingsPage(page, 'project-tracks');
  await toggle.uncheck();
  await closeSettingsPanels(page);
  await expect(page.locator('[data-mp-group]')).toHaveCount(0);
  expect(await page.evaluate(() => MaweMultiplayer.data().groups[2].speaker)).toBe('红队');
  expect(await page.evaluate(() => MaweExportSrt.buildAss())).toBe(offAss);
  await page.evaluate(() => { document.activeElement?.blur(); MaweSelection.selectOnly(1); });
  await page.keyboard.press('1');
  await expect.poll(() => page.evaluate(() => MaweBoot.DATA.segments[1].color?.name ?? null)).toBe('yellow');
});
