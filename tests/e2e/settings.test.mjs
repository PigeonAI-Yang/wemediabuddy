// 设置 surface Electron E2E scenarios (WMB-5243, journey matrix STG-001..STG-008).
//
// Covers: 全分区导航与 sessionStorage 深链、主题持久化、Pi 配置保存与非法配置可见错误、
// 数据与存储（数据根/工作空间列表）、浏览器绑定空态、系统诊断三卡、关于版本、Pi Skills 列表。
// Real Electron + isolated workspace.

import { helpers } from './harness.mjs';

const { assert, step, waitForAppReady, navigateTo, openReadOnlyDb } = helpers;

const SECTION_NAV = [
  ['常规', '常规'],
  ['AI 与模型', 'AI 与模型'],
  ['Pi Skills', 'Pi Skills'],
  ['数据与存储', '数据与存储'],
  ['浏览器与账号', '浏览器与账号'],
  ['情报渠道', '情报渠道'],
  ['X Lists', 'X Lists'],
  ['智能体接入', '智能体与角色'],
  ['系统诊断', '系统诊断']
];

export default [
  {
    id: 'STG-001-settings-sections-nav',
    journeyIds: ['STG-001-settings-sections-nav'],
    run: async ({ page, evidence }) => {
      await step(evidence, '启动就绪', () => waitForAppReady(page));
      await step(evidence, '全分区切换且标题正确，Pi dock 隐藏', async () => {
        await navigateTo(page, 'settings');
        assert(await page.locator('.settings-nav h1').textContent() === '设置', '设置页标题错误');
        assert(await page.locator('.pi-dock').count() === 0, '设置视图应隐藏 Pi dock');
        assert(await page.locator('.app-shell').getAttribute('class').then((c) => c.includes('settings-mode')), 'app-shell 应有 settings-mode');
        for (const [navTitle, heading] of SECTION_NAV) {
          await page.locator(`.settings-nav nav button[title="${navTitle}"]`).click();
          await page.waitForFunction((h) => document.querySelector('.settings-heading h2')?.textContent === h, heading);
        }
        await page.locator('.settings-nav-foot button', { hasText: '关于 WMB' }).click();
        await page.waitForFunction(() => document.querySelector('.settings-heading h2')?.textContent === '关于 WMB');
      });
      await step(evidence, 'sessionStorage 深链直达分区', async () => {
        await navigateTo(page, 'agents');
        await page.locator('.agents-config-entry', { hasText: '角色与能力配置' }).click();
        await page.waitForFunction(() => document.querySelector('.settings-nav nav button.active')?.getAttribute('title') === '智能体接入', null, { timeout: 15_000 });
        assert(await page.locator('.settings-heading h2').textContent() === '智能体与角色', '深链应直达智能体接入分区');
      });
      await step(evidence, '返回按钮回到今日', async () => {
        await page.locator('.settings-back').click();
        await page.waitForFunction(() => document.querySelector('nav button.active')?.getAttribute('title') === '今日', null, { timeout: 15_000 });
      });
      return { surface: 'settings', journey: 'STG-001', sections: SECTION_NAV.length + 1 };
    }
  },
  {
    id: 'STG-002-settings-theme-persist',
    journeyIds: ['STG-002-settings-theme-persist'],
    run: async ({ page, evidence }) => {
      await step(evidence, '启动就绪', () => waitForAppReady(page));
      await step(evidence, '主题切换更新 data-theme 与 localStorage 并重载保持', async () => {
        await waitForAppReady(page);
        const themeBtn = page.locator('.status-theme');
        assert(await themeBtn.getAttribute('aria-label') === '切换到白昼紫罗兰', '初始深色主题按钮 aria-label 应为 切换到白昼紫罗兰');
        const before = await page.evaluate(() => document.documentElement.dataset.theme);
        await themeBtn.click();
        await page.waitForFunction((prev) => document.documentElement.dataset.theme !== prev, before);
        const after = await page.evaluate(() => document.documentElement.dataset.theme);
        assert(after === 'light', `data-theme 应为 light，实际 ${after}`);
        const stored = await page.evaluate(() => localStorage.getItem('wmb.theme'));
        assert(stored === 'light', `localStorage wmb.theme 应为 light，实际 ${stored}`);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await waitForAppReady(page);
        const persisted = await page.evaluate(() => document.documentElement.dataset.theme);
        assert(persisted === 'light', `重载后主题应保持 light，实际 ${persisted}`);
        assert(await page.locator('.status-theme').getAttribute('aria-label') === '切换到黑夜紫罗兰', '浅色主题按钮 aria-label 应为 切换到黑夜紫罗兰');
      });
      return { surface: 'settings', journey: 'STG-002', theme: 'light', persisted: true };
    }
  },
  {
    id: 'STG-003-settings-pi-config-save',
    journeyIds: ['STG-003-settings-pi-config-save'],
    run: async ({ page, evidence }) => {
      await step(evidence, '启动就绪', () => waitForAppReady(page));
      await step(evidence, '保存 Pi profile 配置并读回一致', async () => {
        await navigateTo(page, 'settings');
        await page.locator('.settings-nav nav button[title="AI 与模型"]').click();
        await page.locator('.settings-profile-list .settings-profile.selected').waitFor({ state: 'visible' });
        const nameInput = page.locator('.settings-form label', { hasText: '配置名称' }).locator('input');
        await nameInput.fill('E2E 本地配置');
        await page.locator('.settings-form-actions button.primary-button', { hasText: '保存修改' }).click();
        await page.waitForFunction(() => document.querySelector('.pi-config-note')?.textContent?.includes('已保存并切换到此配置') === true, null, { timeout: 15_000 });
        const settings = await page.evaluate(() => window.wmb.getSettings());
        const profile = settings?.pi?.profiles?.find((p) => p.name === 'E2E 本地配置');
        assert(Boolean(profile), '保存后 getSettings 应读回新配置名');
        assert(settings?.pi?.activeId === profile.id, '保存后应为当前配置');
      });
      await step(evidence, '非法配置保存显示可见错误不假成功', async () => {
        const baseUrlInput = page.locator('.settings-form label', { hasText: 'Base URL' }).locator('input');
        await baseUrlInput.fill('ftp://example.com/v1');
        await page.locator('.settings-form-actions button.primary-button', { hasText: '保存修改' }).click();
        await page.waitForFunction(() => /必须使用 HTTP|保存失败/.test(document.querySelector('.pi-config-note')?.textContent ?? ''), null, { timeout: 15_000 });
        const note = await page.locator('.pi-config-note').textContent();
        assert(!note.includes('已保存'), '非法配置不应显示成功');
      });
      await step(evidence, '不可达 provider 获取模型显示错误', async () => {
        const baseUrlInput = page.locator('.settings-form label', { hasText: 'Base URL' }).locator('input');
        await baseUrlInput.fill('http://127.0.0.1:9/v1');
        await page.locator('button', { hasText: '获取模型' }).click();
        await page.waitForFunction(() => /获取模型失败|仍可手动填写模型/.test(document.querySelector('.pi-config-note')?.textContent ?? ''), null, { timeout: 30_000 });
      });
      return { surface: 'settings', journey: 'STG-003', saved: true, errorShown: true };
    }
  },
  {
    id: 'STG-004-settings-data-workspace',
    journeyIds: ['STG-004-settings-data-workspace'],
    run: async ({ page, workspace, evidence }) => {
      await step(evidence, '启动就绪', () => waitForAppReady(page));
      await step(evidence, '数据目录与工作空间列表', async () => {
        await navigateTo(page, 'settings');
        await page.locator('.settings-nav nav button[title="数据与存储"]').click();
        await page.locator('.path-chip').waitFor({ state: 'visible' });
        const chip = await page.locator('.path-chip').textContent();
        assert(chip.includes('data-root'), `数据目录 chip 应显示当前路径，实际 ${JSON.stringify(chip)}`);
        // 工作空间列表异步加载：等待当前项「当前」标记出现（而非仅等待任一 h3 行）
        await page.waitForFunction((name) => [...document.querySelectorAll('.settings-row')].some((row) => row.textContent?.includes(name) && row.textContent?.includes('当前')), workspace.displayName, { timeout: 15_000 });
        const currentPill = await page.locator('.pill-status.green', { hasText: '当前' }).count();
        assert(currentPill >= 1, '当前工作空间应标记 当前');
        const rowText = await page.locator('.settings-row', { hasText: workspace.displayName }).first().textContent();
        assert(rowText.includes('当前'), `工作空间行应标记 当前：${rowText}`);
        assert(await page.locator('.settings-row', { hasText: '数据库' }).count() >= 1, '应有数据库行');
      });
      return { surface: 'settings', journey: 'STG-004', dataRootShown: true, workspaceCurrent: true };
    }
  },
  {
    id: 'STG-005-settings-browser-bind',
    journeyIds: ['STG-005-settings-browser-bind'],
    run: async ({ page, evidence }) => {
      await step(evidence, '启动就绪', () => waitForAppReady(page));
      await step(evidence, '浏览器分区空绑定态与设置读回一致', async () => {
        await navigateTo(page, 'settings');
        await page.locator('.settings-nav nav button[title="浏览器与账号"]').click();
        await page.locator('.settings-status-card').waitFor({ state: 'visible', timeout: 15_000 });
        const statusText = await page.locator('.settings-status-card').textContent();
        assert(statusText.includes('尚未绑定登录环境'), `空绑定态应显示 尚未绑定登录环境，实际 ${JSON.stringify(statusText.slice(0, 60))}`);
        const settings = await page.evaluate(() => window.wmb.getSettings());
        assert(!settings?.boundBrowserProfile, `boundBrowserProfile 应为空，实际 ${JSON.stringify(settings?.boundBrowserProfile)}`);
        // 状态栏浏览器状态诚实：未启动
        const statusBar = await page.locator('.status-bar').textContent();
        assert(statusBar.includes('浏览器未启动'), '状态栏应显示浏览器未启动');
      });
      return { surface: 'settings', journey: 'STG-005', binding: 'unbound', honest: true };
    }
  },
  {
    id: 'STG-006-settings-diagnostics',
    journeyIds: ['STG-006-settings-diagnostics'],
    run: async ({ page, evidence }) => {
      await step(evidence, '启动就绪', () => waitForAppReady(page));
      await step(evidence, '系统诊断三张健康卡真实状态', async () => {
        await navigateTo(page, 'settings');
        await page.locator('.settings-nav nav button[title="系统诊断"]').click();
        await page.locator('.diagnostic-list').waitFor({ state: 'visible' });
        const cards = page.locator('.diagnostic-list article');
        assert(await cards.count() === 3, `应有三张健康卡，实际 ${await cards.count()}`);
        const texts = await cards.allTextContents();
        assert(texts.some((t) => t.includes('本地数据')), '应有 本地数据 卡');
        assert(texts.some((t) => t.includes('创作助手连接')), '应有 创作助手连接 卡');
        assert(texts.some((t) => t.includes('专用浏览器')), '应有 专用浏览器 卡');
        const dbCard = texts.find((t) => t.includes('本地数据'));
        assert(dbCard.includes('健康'), '本地数据应健康');
        assert(texts.find((t) => t.includes('专用浏览器')).includes('未启动'), '浏览器应如实显示未启动');
      });
      return { surface: 'settings', journey: 'STG-006', cards: 3 };
    }
  },
  {
    id: 'STG-007-settings-app-update',
    journeyIds: ['STG-007-settings-app-update'],
    run: async ({ page, evidence }) => {
      await step(evidence, '启动就绪', () => waitForAppReady(page));
      await step(evidence, '关于分区渲染版本信息', async () => {
        await navigateTo(page, 'settings');
        await page.locator('.settings-nav-foot button', { hasText: '关于 WMB' }).click();
        await page.locator('.settings-section', { hasText: 'Pi 运行组件' }).waitFor({ state: 'visible', timeout: 15_000 });
        const runtime = await page.locator('.settings-row', { hasText: 'Pi 运行组件' }).textContent();
        assert(/随应用安装|数据目录版本/.test(runtime ?? ''), '应显示 Pi 运行组件来源');
        const version = await page.locator('.settings-row', { hasText: 'Pi 运行组件' }).locator('.settings-row-actions strong').textContent();
        assert(version && version !== 'unknown' && version.trim().length > 0, `应显示真实版本号，实际 ${JSON.stringify(version)}`);
        assert(await page.locator('button', { hasText: '刷新版本' }).count() >= 1, '应有检查/刷新版本入口');
      });
      return { surface: 'settings', journey: 'STG-007', versionShown: true };
    }
  },
  {
    id: 'STG-008-settings-skills',
    journeyIds: ['STG-008-settings-skills'],
    run: async ({ page, evidence }) => {
      await step(evidence, '启动就绪', () => waitForAppReady(page));
      await step(evidence, 'Pi Skills 分区渲染不崩溃', async () => {
        await navigateTo(page, 'settings');
        await page.locator('.settings-nav nav button[title="Pi Skills"]').click();
        await page.locator('.pi-skills-settings').waitFor({ state: 'visible', timeout: 15_000 });
        assert(await page.locator('.pi-skills-settings h3', { hasText: 'Skill 清单' }).count() === 1, '应显示 Skill 清单');
        assert(await page.locator('.pi-skills-list button.add', { hasText: '新建 Skill' }).count() === 1, '应有 新建 Skill 入口');
        const settings = await page.evaluate(() => window.wmb.listPiSkills());
        assert(Array.isArray(settings), 'listPiSkills 应返回数组');
        // 技能编辑表单可交互（新建空表单）
        await page.locator('.pi-skills-list button.add').click();
        await page.locator('.pi-skill-editor input').first().waitFor({ state: 'visible' });
        assert(await page.locator('.pi-skill-editor input').count() >= 1, '新建表单应有名称输入');
        assert(await page.locator('.pi-skill-editor button.primary-button', { hasText: '保存 Skill' }).count() === 1, '空表单应有保存入口');
      });
      return { surface: 'settings', journey: 'STG-008', skillsRendered: true };
    }
  }
];
