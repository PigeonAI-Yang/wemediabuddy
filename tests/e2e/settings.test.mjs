// 设置 surface Electron E2E scenarios (WMB-5243, journey matrix STG-001..STG-008).
//
// Covers: 全分区导航与 sessionStorage 深链、主题持久化、Pi 配置保存与非法配置可见错误、
// 数据与存储（数据根/工作空间列表）、浏览器绑定空态、系统诊断三卡、关于版本、Pi Skills 列表。
// Real Electron + isolated workspace.

import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { helpers } from './harness.mjs';
import { openDb, seedSourceFeed, seedXListBinding, seedXListIndex } from './lib/seed.mjs';

const { assert, step, waitForAppReady, navigateTo, openReadOnlyDb, captureEvidence } = helpers;

const SECTION_NAV = [
  ['常规', '常规'],
  ['AI 与模型', 'AI 与模型'],
  ['Pi Skills', 'Pi Skills'],
  ['数据与存储', '数据与存储'],
  ['浏览器与账号', '浏览器与账号'],
  ['情报渠道', '情报渠道'],
  ['智能体接入', '智能体与角色'],
  ['系统诊断', '系统诊断']
];

export default [
  {
    id: 'STG-001-settings-sections-nav',
    journeyIds: ['STG-001-settings-sections-nav'],
    run: async ({ app, page, workspace, evidence, artifactsDir }) => {
      await step(evidence, '启动就绪', () => waitForAppReady(page));
      await step(evidence, '全分区切换且标题正确，Pi dock 隐藏', async () => {
        await navigateTo(page, 'settings');
        const db = openDb(workspace.dataRoot);
        try {
          seedXListIndex(db, {
            accountKey: 'settings-e2e',
            lists: [
              { listId: 'settings-owned', canonicalUrl: 'https://x.com/i/lists/101', name: 'AI 观察', ownerHandle: 'owner', kind: 'owned' },
              { listId: 'settings-following', canonicalUrl: 'https://x.com/i/lists/102', name: '产品信号', ownerHandle: 'curator', kind: 'following' },
            ],
          });
          seedSourceFeed(db, { id: 'settings-list-feed', name: 'AI 观察', url: 'https://x.com/i/lists/101' });
          seedXListBinding(db, {
            id: 'settings-list-binding', accountKey: 'settings-e2e', listId: 'settings-owned',
            canonicalUrl: 'https://x.com/i/lists/101', ownerHandle: 'owner', name: 'AI 观察', kind: 'owned',
            sourceFeedId: 'settings-list-feed', enabled: 1,
          });
        } finally {
          db.close();
        }
        assert(await page.locator('.settings-nav-group').count() === 3, '设置菜单应按基础、采集与账号、系统分组');
        assert(await page.locator('.pi-dock').count() === 0, '设置视图应隐藏 Pi dock');
        assert(await page.locator('.app-shell').getAttribute('class').then((c) => c.includes('settings-mode')), 'app-shell 应有 settings-mode');
        const navigationIcons = await page.locator('.settings-nav button b').evaluateAll((nodes) => nodes.map((node) => ({ svg: node.querySelectorAll('svg').length, text: node.textContent?.trim() ?? '' })));
        assert(navigationIcons.length === 10 && navigationIcons.every((icon) => icon.svg === 1 && icon.text === ''), `设置导航与返回应全部使用 SVG 图标，实际 ${JSON.stringify(navigationIcons)}`);
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1100, 800));
        await page.waitForTimeout(250);
        await page.locator('.settings-nav nav button[title="常规"]').click();
        assert(await page.locator('.settings-theme-options button').count() === 2, '常规页应提供两个真实主题选项');
        assert(await page.locator('.settings-general-grid .settings-preference-group').count() === 2, '常规页应为两个紧凑偏好分组');
        assert(await page.locator('.settings-theme-options button svg').count() === 2, '深浅主题应使用两个 SVG 图形图标');
        assert(await page.locator('.settings-theme-options button').evaluateAll((buttons) => buttons.every((button) => !/[☀☾]/u.test(button.textContent ?? ''))), '主题控件不应残留文字图标');
        await captureEvidence({ app, page, evidence, artifactsDir, name: 'settings-general-1100' });
        const generalCopy = await page.locator('.settings-content-inner').innerText();
        assert(!/设置工作区外观|当前版本的基础工作区偏好|直接进入今日工作台|当前全部界面文案/u.test(generalCopy), `常规页不应重复标题、固定值或当前状态，实际 ${JSON.stringify(generalCopy)}`);
        await page.locator('.settings-nav nav button[title="Pi Skills"]').click();
        assert(await page.locator('.pi-skills-layout').count() === 1, 'Pi Skills 应为清单与编辑器主从布局');
        await page.locator('.pi-skill-instructions').waitFor({ state: 'visible', timeout: 15_000 });
        const skillTextGeometry = await page.locator('.pi-skill-editor').evaluate((editor) => {
          const description = editor.querySelector('.pi-skill-fields textarea');
          const instructions = editor.querySelector('.pi-skill-instructions');
          return {
            descriptionHeight: description?.clientHeight ?? 0,
            descriptionOverflowX: (description?.scrollWidth ?? 0) - (description?.clientWidth ?? 0),
            instructionsOverflowX: (instructions?.scrollWidth ?? 0) - (instructions?.clientWidth ?? 0),
            instructionsScrollable: instructions ? instructions.scrollHeight <= instructions.clientHeight || (() => { instructions.scrollTop = instructions.scrollHeight; return instructions.scrollTop > 0; })() : false,
          };
        });
        assert(skillTextGeometry.descriptionHeight >= 70, `触发描述应有可读高度，实际 ${skillTextGeometry.descriptionHeight}px`);
        assert(skillTextGeometry.descriptionOverflowX <= 1 && skillTextGeometry.instructionsOverflowX <= 1, `Skill 文本域不应横向裁切，实际 ${JSON.stringify(skillTextGeometry)}`);
        assert(skillTextGeometry.instructionsScrollable, `Skill 指令全文应可滚动到达，实际 ${JSON.stringify(skillTextGeometry)}`);
        await captureEvidence({ app, page, evidence, artifactsDir, name: 'settings-skills-1100' });
        const skillsCopy = await page.locator('.pi-skill-editor').innerText();
        assert(!skillsCopy.includes('只读 Skill 不会显示保存或删除操作'), '只读状态不应在编辑器页脚再次解释');
        await page.locator('.settings-nav nav button[title="浏览器与账号"]').click();
        assert(await page.locator('.browser-settings-step').count() === 2, '浏览器页应按登录环境与平台账号组织两步工作流');
        assert(await page.locator('.browser-settings-workflow').count() === 1, '浏览器两步操作应收口到一个连续工作流');
        const browserLayout = await page.locator('.browser-settings-workflow').evaluate((workflow) => {
          const steps = [...workflow.querySelectorAll('.browser-settings-step')];
          const commands = [...workflow.querySelectorAll('.browser-step-command')];
          const actionRows = [...workflow.querySelectorAll('.browser-step-actions')];
          return {
            stepEdges: steps.map((step) => { const rect = step.getBoundingClientRect(); return [Math.round(rect.left), Math.round(rect.right)]; }),
            commandOverflow: commands.map((command) => command.scrollWidth - command.clientWidth),
            actionRows: actionRows.map((row) => [...row.children].map((child) => Math.round(child.getBoundingClientRect().top))),
            controlHeights: commands.map((command) => [...command.querySelectorAll('select, .browser-account-summary, .browser-step-actions button')].map((node) => Math.round(node.getBoundingClientRect().height))),
          };
        });
        assert(browserLayout.stepEdges.length === 2 && browserLayout.stepEdges[0][0] === browserLayout.stepEdges[1][0] && browserLayout.stepEdges[0][1] === browserLayout.stepEdges[1][1], `两步工作流边界应对齐，实际 ${JSON.stringify(browserLayout)}`);
        assert(browserLayout.commandOverflow.every((value) => value <= 1), `菜单与按钮行不应横向溢出，实际 ${JSON.stringify(browserLayout)}`);
        assert(browserLayout.actionRows.every((tops) => tops.length < 2 || Math.max(...tops) - Math.min(...tops) <= 2), `同一步骤按钮应稳定成组，实际 ${JSON.stringify(browserLayout)}`);
        assert(browserLayout.controlHeights.every((heights) => heights.length >= 2 && Math.max(...heights) - Math.min(...heights) <= 1), `同排菜单、账号摘要与按钮必须等高，实际 ${JSON.stringify(browserLayout.controlHeights)}`);
        assert(await page.locator('.browser-step-heading p').count() === 0, '步骤标题下不应重复解释当前操作');
        assert(await page.locator('.browser-settings .primary-button:enabled').count() === 1, '浏览器工作流应只有一个可用主操作');
        const browserVisibleCopy = await page.locator('.browser-settings').evaluate((surface) => surface.innerText);
        assert(!/工作区登录环境|登录态识别|当前绑定|预期账号|bindingRevision/u.test(browserVisibleCopy), `浏览器主路径不应暴露内部实现语义，实际 ${JSON.stringify(browserVisibleCopy)}`);
        assert(await page.locator('.settings-disclosure').getAttribute('open') === null, '技术详情默认应渐进披露');
        assert(await page.locator('.settings-status-card .settings-provider-mark svg').count() === 1, '浏览器状态应使用 SVG 图形标识');
        await captureEvidence({ app, page, evidence, artifactsDir, name: 'settings-browser-1100' });
        await page.locator('.settings-nav nav button[title="AI 与模型"]').click();
        assert(await page.locator('.settings-profile .settings-provider-mark svg').count() > 0, 'AI 配置预设应使用 SVG 图形标识');
        assert(await page.locator('.settings-icon-text-button svg').count() >= 2, '新增配置动作应使用 SVG 加号图标');
        await captureEvidence({ app, page, evidence, artifactsDir, name: 'settings-ai-icons-1100' });
        assert(await page.locator('.role-policy-row').count() === 5, '角色分配应完整展示主管、情报员、策划、写手、资料员');
        assert(await page.locator('.role-policy-chain').count() === 5, '每个角色应有独立且有序的模型候选链');
        const rolePolicySnapshot = await page.evaluate(async () => {
          const snapshot = await window.wmb.getSettings();
          const roleIds = ['desk', 'reporter', 'planner', 'writer', 'librarian'];
          const profiles = new Map((snapshot?.pi?.profiles ?? []).map((profile) => [profile.id, profile.name]));
          return roleIds.map((roleId) => (snapshot?.pi?.roleModelPolicies?.[roleId]?.candidates ?? []).map((candidate) => ({ provider: profiles.get(candidate.profileId) ?? candidate.profileId, model: candidate.model })));
        });
        const renderedRolePairs = await page.locator('.role-policy-chain').evaluateAll((chains) => chains.map((chain) => [...chain.querySelectorAll('li')].map((item) => ({ provider: item.querySelector('.role-policy-copy strong')?.textContent?.trim() ?? '', model: item.querySelector('[data-role-model]')?.getAttribute('data-role-model') ?? '' }))));
        assert(JSON.stringify(renderedRolePairs) === JSON.stringify(rolePolicySnapshot), `保存的 Provider + 模型组合应完整显示，实际 ${JSON.stringify({ renderedRolePairs, rolePolicySnapshot })}`);
        const roleCatalog = await page.locator('.role-policy-add select').evaluateAll((selects) => selects.map((select) => [...select.options].slice(1).map((option) => ({ providerId: option.dataset.profileId ?? '', model: option.dataset.model ?? '', label: option.textContent?.trim() ?? '' }))));
        assert(roleCatalog.length === 5 && roleCatalog.every((options) => options.every((option) => option.providerId && option.model && option.label.endsWith(`· ${option.model}`))), `角色新增选项应带 Provider 与精确模型，实际 ${JSON.stringify(roleCatalog)}`);
        assert(roleCatalog.every((options) => {
          const identities = options.map((option) => `${option.providerId}\u0000${option.model}`);
          return new Set(identities).size === identities.length;
        }), '每个角色的新增目录不应重复 Provider + 模型组合');
        assert(await page.locator('.role-policy-save-actions .primary-button').isDisabled(), '未修改角色分配时不应允许重复保存');
        assert(/当前策略版本\s+\d+/u.test(await page.locator('.role-policy-save-actions').innerText()), '角色分配应显示当前策略版本');
        assert(await page.locator('.settings-nav nav button[title="X Lists"]').count() === 0, '设置侧栏不应保留独立 X Lists');
        await page.locator('.settings-nav nav button[title="情报渠道"]').click();
        await page.locator('.channel-settings-tabs').waitFor({ state: 'visible', timeout: 15_000 });
        assert(await page.locator('.channel-settings-tabs button').count() === 2, '情报渠道应提供来源与 X Lists 两个二级入口');
        assert(await page.locator('.channel-settings-tabs button.active').textContent() === '来源与扫描', '情报渠道默认应显示来源与扫描');
        const channelScroll = await page.locator('.settings-content').evaluate((content) => {
          content.scrollTop = content.scrollHeight;
          const bottomGap = content.scrollHeight - content.clientHeight - content.scrollTop;
          const reachedBottom = bottomGap <= 1;
          const scrollTop = content.scrollTop;
          content.scrollTop = 0;
          return { reachedBottom, scrollTop, bottomGap };
        });
        assert(channelScroll.reachedBottom && channelScroll.scrollTop > 0, `情报渠道长内容应可滚动到底部，实际 ${JSON.stringify(channelScroll)}`);
        await captureEvidence({ app, page, evidence, artifactsDir, name: 'settings-channels-sources-1100' });
        assert(await page.locator('.settings-heading p').count() === 0, '情报渠道标题下不应复述页面内两个入口');
        await page.locator('.channel-settings-tabs button', { hasText: 'X Lists 管理' }).click();
        await page.locator('.x-list-display-settings').waitFor({ state: 'visible', timeout: 15_000 });
        assert(await page.locator('.settings-heading h2').textContent() === '情报渠道', 'X Lists 管理应保留在情报渠道页面内');
        assert(await page.locator('.x-list-display-settings', { hasText: 'List 工作台显示' }).count() === 1, '合并页应保留 List 工作台显示能力');
        await page.locator('.x-list-settings-management').waitFor({ state: 'visible', timeout: 15_000 });
        assert(await page.locator('.settings-list-choices label').count() === 2, '合并页应读取并展示账号 List 工作台选项');
        assert(await page.locator('.x-list-settings-management > .settings-inline-actions select option').count() === 2, '合并页应保留已有 List 管理选择器');
        assert(await page.locator('.x-list-composer').count() === 1, '合并页应保留受确认保护的 List 操作区');
        await captureEvidence({ app, page, evidence, artifactsDir, name: 'settings-channels-x-lists-1100' });
        assert(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) === 0, '设置页不应产生横向溢出');
        await page.locator('.settings-nav nav button[title="智能体接入"]').click();
        await page.locator('.agents-settings').waitFor({ state: 'visible', timeout: 15_000 });
        assert(await page.locator('.agents-settings-skill-line').count() === 0, '角色卡不应暴露不可操作的内部 Skill 清单');
        assert(!(await page.locator('.settings-section-agent').innerText()).includes('配方 '), '智能体接入主路径不应显示内部配方标识');
        await captureEvidence({ app, page, evidence, artifactsDir, name: 'settings-agent-1100' });
        await page.locator('.settings-nav nav button[title="数据与存储"]').click();
        await page.locator('.settings-row', { hasText: '数据目录' }).waitFor({ state: 'visible', timeout: 15_000 });
        const dataCopy = await page.locator('.settings-content-inner').innerText();
        assert(!/数据库版本|内容指纹去重/u.test(dataCopy), `数据页不应默认展示无决策价值的实现细节，实际 ${JSON.stringify(dataCopy)}`);
        await captureEvidence({ app, page, evidence, artifactsDir, name: 'settings-data-1100' });
        await page.locator('.settings-nav nav button[title="系统诊断"]').click();
        await page.locator('.diagnostic-list').waitFor({ state: 'visible', timeout: 15_000 });
        await captureEvidence({ app, page, evidence, artifactsDir, name: 'settings-diagnostics-1100' });
        await page.locator('.settings-nav-foot button', { hasText: '关于 WMB' }).click();
        await page.locator('.app-update-block').waitFor({ state: 'visible', timeout: 15_000 });
        assert(await page.locator('.app-update-block .settings-row h3', { hasText: '应用版本' }).count() === 1, '关于页应以信息维度而非重复品牌名标记版本行');
        assert(!(await page.locator('.settings-content-inner').innerText()).includes('unknown'), '关于页不应显示内部英文回退值');
        await captureEvidence({ app, page, evidence, artifactsDir, name: 'settings-about-1100' });
        await page.locator('.settings-nav nav button[title="常规"]').click();
        await page.locator('.settings-theme-options button', { hasText: '白昼紫罗兰' }).click();
        await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
        await page.locator('.settings-nav nav button[title="浏览器与账号"]').click();
        await captureEvidence({ app, page, evidence, artifactsDir, name: 'settings-browser-light-1100' });
        assert(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) === 0, '浅色浏览器设置不应横向溢出');
        await page.locator('.settings-nav nav button[title="情报渠道"]').click();
        await page.locator('.channel-settings-tabs button', { hasText: 'X Lists 管理' }).click();
        await page.locator('.x-list-settings-management').waitFor({ state: 'visible', timeout: 15_000 });
        await captureEvidence({ app, page, evidence, artifactsDir, name: 'settings-channels-x-lists-light-1100' });
        assert(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) === 0, '浅色情报渠道不应产生横向溢出');
        const lightAuditPages = [
          ['常规', '常规', 'general'],
          ['AI 与模型', 'AI 与模型', 'ai'],
          ['Pi Skills', 'Pi Skills', 'skills'],
          ['智能体接入', '智能体与角色', 'agent'],
          ['数据与存储', '数据与存储', 'data'],
          ['系统诊断', '系统诊断', 'diagnostics'],
        ];
        for (const [navTitle, heading, slug] of lightAuditPages) {
          await page.locator(`.settings-nav nav button[title="${navTitle}"]`).click();
          await page.waitForFunction((expected) => document.querySelector('.settings-heading h2')?.textContent === expected, heading);
          await page.locator('.settings-content').evaluate((content) => { content.scrollTop = 0; });
          await captureEvidence({ app, page, evidence, artifactsDir, name: `settings-${slug}-light-1100` });
        }
        await page.locator('.settings-nav-foot button', { hasText: '关于 WMB' }).click();
        await page.locator('.app-update-block').waitFor({ state: 'visible', timeout: 15_000 });
        await captureEvidence({ app, page, evidence, artifactsDir, name: 'settings-about-light-1100' });
        await page.locator('.settings-nav nav button[title="常规"]').click();
        await page.locator('.settings-theme-options button', { hasText: '黑夜紫罗兰' }).click();
        await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
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
        await page.evaluate(() => sessionStorage.setItem('wmb.settingsSection', 'lists'));
        await navigateTo(page, 'today');
        await navigateTo(page, 'settings');
        await page.waitForFunction(() => document.querySelector('.settings-nav nav button.active')?.getAttribute('title') === '情报渠道', null, { timeout: 15_000 });
        assert(await page.locator('.settings-heading h2').textContent() === '情报渠道', '旧 lists 深链应进入合并后的情报渠道');
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
    run: async ({ app, page, evidence, artifactsDir }) => {
      await step(evidence, '启动就绪', () => waitForAppReady(page));
      await step(evidence, '常规页主题切换更新 data-theme 与 localStorage 并重载保持', async () => {
        await navigateTo(page, 'settings');
        await page.locator('.settings-nav nav button[title="常规"]').click();
        const lightTheme = page.locator('.settings-theme-options button', { hasText: '白昼紫罗兰' });
        const darkTheme = page.locator('.settings-theme-options button', { hasText: '黑夜紫罗兰' });
        assert(await darkTheme.getAttribute('aria-pressed') === 'true', '常规页初始应选中黑夜紫罗兰');
        const before = await page.evaluate(() => document.documentElement.dataset.theme);
        await lightTheme.click();
        await page.waitForFunction((prev) => document.documentElement.dataset.theme !== prev, before);
        const after = await page.evaluate(() => document.documentElement.dataset.theme);
        assert(after === 'light', `data-theme 应为 light，实际 ${after}`);
        assert(await page.evaluate(() => localStorage.getItem('wmb.theme')) === 'light', 'localStorage wmb.theme 应为 light');
        assert(await lightTheme.getAttribute('aria-pressed') === 'true', '常规页应显示白昼紫罗兰已选中');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await waitForAppReady(page);
        await navigateTo(page, 'settings');
        await page.locator('.settings-nav nav button[title="常规"]').click();
        assert(await page.locator('.settings-theme-options button', { hasText: '白昼紫罗兰' }).getAttribute('aria-pressed') === 'true', '重载后常规页主题选择应保持');
        assert(await page.locator('.status-theme').getAttribute('aria-label') === '切换到黑夜紫罗兰', '状态栏主题入口应与常规页同步');
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1100, 800));
        await page.waitForTimeout(150);
        await captureEvidence({ app, page, evidence, artifactsDir, name: 'settings-general-light-1100' });
        assert(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) === 0, '浅色常规设置不应横向溢出');
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
        const nameInput = page.locator('.settings-form label', { hasText: '预设名称' }).locator('input');
        await nameInput.fill('E2E 本地配置');
        await page.locator('.settings-form-actions button.primary-button', { hasText: '保存预设修改' }).click();
        await page.waitForFunction(() => document.querySelector('.pi-config-note')?.textContent?.includes('预设已保存') === true, null, { timeout: 15_000 });
        const settings = await page.evaluate(() => window.wmb.getSettings());
        const profile = settings?.pi?.profiles?.find((p) => p.name === 'E2E 本地配置');
        assert(Boolean(profile), '保存后 getSettings 应读回新配置名');
        assert(settings?.pi?.activeId === profile.id, '保存后应为当前配置');
      });
      await step(evidence, '非法配置保存显示可见错误不假成功', async () => {
        const baseUrlInput = page.locator('.settings-form label', { hasText: 'Base URL' }).locator('input');
        await baseUrlInput.fill('ftp://example.com/v1');
        await page.locator('.settings-form-actions button.primary-button', { hasText: '保存预设修改' }).click();
        await page.waitForFunction(() => /必须使用 HTTP|保存失败/.test(document.querySelector('.pi-config-note')?.textContent ?? ''), null, { timeout: 15_000 });
        const note = await page.locator('.pi-config-note').textContent();
        assert(!note.includes('已保存'), '非法配置不应显示成功');
      });
      await step(evidence, '通用 Provider 协议、凭证来源和本机发现入口可用', async () => {
        assert(await page.locator('select option[value="anthropic-messages"]').count() === 1, '应支持 Anthropic Messages');
        assert(await page.locator('select option[value="environment"]').count() === 1, '应支持环境变量凭证');
        assert(await page.locator('select option[value="command"]').count() === 1, '应支持命令凭证');
        await page.locator('button', { hasText: '查找本机配置' }).click();
        await page.waitForFunction(() => /从本机配置文件找到 \d+ 项|没有找到/.test(document.querySelector('.settings-discovery-note')?.textContent ?? ''), null, { timeout: 15_000 });
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
        assert(statusText.includes('尚未设置登录环境'), `空状态应显示 尚未设置登录环境，实际 ${JSON.stringify(statusText.slice(0, 60))}`);
        assert(await page.locator('.browser-settings-step').count() === 2, '浏览器页应显示两步任务流');
        assert(await page.locator('.browser-settings-workflow').count() === 1, '两步任务应位于同一连续工作流容器');
        assert(await page.locator('.browser-step-command').count() === 2, '登录环境和平台账号各应有一个对齐的菜单动作行');
        assert(await page.locator('.browser-settings .primary-button:enabled').count() === 1, '未绑定态应只有一个可用主操作');
        assert((await page.locator('.browser-settings-step').last().textContent()).includes('请先设置登录环境'), '账号验证不可用原因应就地使用产品语言说明');
        assert(await page.locator('.settings-disclosure').getAttribute('open') === null, '环境路径和维护信息默认应折叠');
        assert(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) === 0, '浏览器设置不应横向溢出');
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
    id: 'STG-005B-settings-browser-bound-layout',
    launch: {
      seedFixture: async (workspace) => {
        const profileId = '12345678-1234-4123-8123-123456789abc';
        const profileDir = path.join(workspace.userDataDir, 'browser-profiles', profileId);
        mkdirSync(profileDir, { recursive: true });
        writeFileSync(path.join(workspace.userDataDir, 'browser-config.json'), `${JSON.stringify({
          version: 2,
          revision: 1,
          defaultProfileId: profileId,
          profiles: [{
            id: profileId,
            label: 'E2E 日常登录环境',
            executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
            userDataDir: profileDir,
            profileDirectory: 'Default',
            origin: 'installation',
            createdAt: new Date().toISOString(),
          }],
        }, null, 2)}\n`);
        const db = openDb(workspace.dataRoot);
        try {
          const now = new Date().toISOString();
          db.prepare(`INSERT INTO workspace_browser_bindings (id, profile_id, binding_revision, state, expected_account_snapshot_json, created_at, updated_at)
            VALUES ('effective', ?, 1, 'verified', ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET profile_id = excluded.profile_id, binding_revision = excluded.binding_revision,
              state = excluded.state, expected_account_snapshot_json = excluded.expected_account_snapshot_json, updated_at = excluded.updated_at`)
            .run(profileId, JSON.stringify({ x: { accountKey: '@e2e-bound', displayName: 'E2E X', verifiedAt: now, browserProfileId: profileId, browserBindingRevision: 1, accountRevision: 1 } }), now, now);
        } finally {
          db.close();
        }
      },
    },
    run: async ({ app, page, evidence, artifactsDir }) => {
      await step(evidence, '启动就绪', () => waitForAppReady(page));
      await step(evidence, '已设置环境时菜单、账号和动作保持单一工作流', async () => {
        await navigateTo(page, 'settings');
        await page.locator('.settings-nav nav button[title="浏览器与账号"]').click();
        await page.locator('.browser-settings-workflow').waitFor({ state: 'visible', timeout: 15_000 });
        assert((await page.locator('.settings-status-card').textContent()).includes('E2E 日常登录环境'), '状态摘要应显示正在使用的登录环境');
        assert((await page.locator('.browser-account-summary').textContent()).includes('E2E X'), '账号摘要应显示已验证账号');
        assert(await page.locator('.browser-settings .primary-button:enabled').count() === 1, '已设置态也应只有一个可用主操作');
        assert(await page.locator('.browser-step-actions .primary-button', { hasText: '验证 X' }).count() === 1, '已设置态主操作应是验证当前平台');
        assert(await page.locator('.browser-step-actions .secondary-button', { hasText: '切换登录环境' }).isDisabled(), '当前环境不应允许重复切换');
        const boundControlHeights = await page.locator('.browser-step-command').evaluateAll((commands) => commands.map((command) => [...command.querySelectorAll('select, .browser-account-summary, .browser-step-actions button')].map((node) => Math.round(node.getBoundingClientRect().height))));
        assert(boundControlHeights.every((heights) => heights.length >= 2 && Math.max(...heights) - Math.min(...heights) <= 1), `已设置态同排组件与按钮必须等高，实际 ${JSON.stringify(boundControlHeights)}`);
        assert(!(await page.locator('.browser-settings-workflow').innerText()).includes('当前正在使用此环境'), '当前环境重复切换提示应删除');
        assert(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) === 0, '已设置态不应横向溢出');
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1100, 800));
        await captureEvidence({ app, page, evidence, artifactsDir, name: 'settings-browser-bound-1100' });
      });
      return { surface: 'settings', journey: 'STG-005B', binding: 'verified', layout: 'unified' };
    },
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
        assert(await page.locator('.pi-skills-toolbar button.add', { hasText: '新建 Skill' }).count() === 1, '应有 新建 Skill 入口');
        const settings = await page.evaluate(() => window.wmb.listPiSkills());
        assert(Array.isArray(settings), 'listPiSkills 应返回数组');
        // 技能编辑表单可交互（新建空表单）
        await page.locator('.pi-skills-toolbar button.add').click();
        await page.locator('.pi-skill-editor input').first().waitFor({ state: 'visible' });
        assert(await page.locator('.pi-skill-editor input').count() >= 1, '新建表单应有名称输入');
        assert(await page.locator('.pi-skill-editor button.primary-button', { hasText: '保存 Skill' }).count() === 1, '空表单应有保存入口');
        assert(await page.locator('.pi-skills-search input[type="search"]').count() === 1, '应有 Skill 搜索入口');
        assert(await page.locator('.pi-skill-editor-head', { hasText: '新建 Skill' }).count() === 1, '编辑器头部应明确当前对象');
        assert(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) === 0, 'Pi Skills 不应横向溢出');
      });
      return { surface: 'settings', journey: 'STG-008', skillsRendered: true };
    }
  },
  {
    id: 'STG-009-settings-role-provider-models',
    journeyIds: ['STG-009-settings-role-provider-models'],
    run: async ({ app, page, evidence, artifactsDir }) => {
      const server = createServer((request, response) => {
        if (request.method === 'GET' && request.url?.endsWith('/models')) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ data: [
            { id: 'muse-spark-1.3-contributor' },
            { id: 'role-model-alpha', reasoning: false },
            { id: 'role-model-beta', reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: null } }
          ] }));
          return;
        }
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'not found' } }));
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      try {
        await step(evidence, '启动就绪', () => waitForAppReady(page));
        const address = server.address();
        assert(address && typeof address === 'object', '模型目录服务应取得监听地址');
        const baseUrl = `http://127.0.0.1:${address.port}/v1`;
        await page.evaluate((url) => window.wmb.savePiConfig({
          id: 'role-multi', name: '多模型 Provider', baseUrl: url, model: 'role-model-alpha', api: 'openai-responses', thinking: 'off', apiKey: 'e2e-role-model-key'
        }), baseUrl);
        await page.reload();
        await waitForAppReady(page);
        await navigateTo(page, 'settings');
        await page.locator('.settings-nav nav button[title="AI 与模型"]').click();
        const modelInput = page.locator('.model-picker input[list="pi-model-options"]');
        await page.locator('.model-picker button', { hasText: '获取模型' }).click();
        await page.locator('#pi-model-options option[value="role-model-beta"]').waitFor({ state: 'attached', timeout: 15_000 });
        await modelInput.fill('role-model-beta');
        await page.evaluate(() => window.wmb.saveDiscoveredSource({
          requestId: `settings-model-picker-refresh-${Date.now()}`,
          title: '设置页模型选择刷新回归',
          originalUrl: `https://example.com/settings-model-picker-refresh-${Date.now()}`
        }));
        await page.waitForTimeout(500);
        assert(await modelInput.inputValue() === 'role-model-beta', '资料变化触发 settings 刷新后，已选择模型不应被旧配置覆盖');
        assert(await page.locator('#pi-model-options option').count() === 3, 'settings 刷新后，已获取的模型目录应继续可选');
        await modelInput.fill('muse-spark-1.3-contributor');
        await page.evaluate(() => window.wmb.saveDiscoveredSource({
          requestId: `settings-model-picker-manual-${Date.now()}`,
          title: '设置页手填模型刷新回归',
          originalUrl: `https://example.com/settings-model-picker-manual-${Date.now()}`
        }));
        await page.waitForTimeout(500);
        assert(await modelInput.inputValue() === 'muse-spark-1.3-contributor', '手动填写的模型名不应被后台 settings 刷新覆盖');
        const unknownThinking = page.locator('.settings-form label', { hasText: '思考等级' }).locator('select');
        assert(JSON.stringify(await unknownThinking.locator('option').evaluateAll((options) => options.map((option) => option.value))) === JSON.stringify(['auto']), '无能力元数据的模型在设置页应只显示自动');
        assert(await unknownThinking.inputValue() === 'auto', '无能力元数据的模型不得继续显示旧的 MAX 设置');
        await page.locator('.settings-form-actions button.primary-button', { hasText: '保存预设修改' }).click();
        await page.waitForFunction(() => document.querySelector('.pi-config-note')?.textContent?.includes('预设已保存') === true, null, { timeout: 15_000 });
        await captureEvidence({ app, page, evidence, artifactsDir, name: 'settings-model-picker-refresh-1100' });
        await modelInput.fill('role-model-alpha');
        const profileThinkingOptions = await page.locator('.settings-form label', { hasText: '思考等级' }).locator('select option').evaluateAll((options) => options.map((option) => option.value));
        assert(JSON.stringify(profileThinkingOptions) === JSON.stringify(['auto', 'off']), `非推理模型只应显示自动和关闭，实际 ${JSON.stringify(profileThinkingOptions)}`);
        const deskSelect = page.locator('.role-policy-row').first().locator('.role-policy-add select');
        await deskSelect.locator('option[data-profile-id="role-multi"][data-model="role-model-beta"]').waitFor({ state: 'attached', timeout: 15_000 });
        const providerModels = await deskSelect.locator('option[data-profile-id="role-multi"]').evaluateAll((options) => options.map((option) => option.dataset.model));
        assert(JSON.stringify(providerModels) === JSON.stringify(['muse-spark-1.3-contributor', 'role-model-alpha', 'role-model-beta']), `同一 Provider 应列出全部可用模型，实际 ${JSON.stringify(providerModels)}`);
        await deskSelect.selectOption({ label: '多模型 Provider · role-model-beta' });
        const candidateRows = page.locator('.role-policy-chain > li');
        const candidateThinkingSelects = page.locator('.role-policy-chain > li .role-policy-thinking select');
        const candidateSelectLabels = await candidateThinkingSelects.evaluateAll((selects) => selects.map((select) => select.getAttribute('aria-label') ?? ''));
        assert(await candidateThinkingSelects.count() === await candidateRows.count() && candidateSelectLabels.every(Boolean), '每个角色候选都应有一个可访问的思考等级选择器');
        const betaCandidate = page.locator('.role-policy-row').first().locator('li[data-profile-id="role-multi"][data-model="role-model-beta"]');
        await betaCandidate.waitFor({ state: 'visible', timeout: 15_000 });
        assert((await betaCandidate.locator('.role-policy-copy small').textContent()).includes('继承 Provider 默认'), '未设置候选覆盖时应明确显示继承 Provider 默认');
        const betaThinkingOptions = await betaCandidate.locator('.role-policy-thinking select option').evaluateAll((options) => options.map((option) => option.value));
        assert(JSON.stringify(betaThinkingOptions) === JSON.stringify(['', 'low', 'high']), `候选模型只应显示实际支持的思考等级，实际 ${JSON.stringify(betaThinkingOptions)}`);
        await betaCandidate.locator('.role-policy-thinking select').selectOption('high');
        assert((await betaCandidate.locator('.role-policy-copy small').textContent()).includes('候选覆盖：高'), '候选覆盖应在摘要中明确显示');
        const save = page.locator('.role-policy-save-actions .primary-button');
        assert(!(await save.isDisabled()), '新增明确模型候选后应允许保存');
        await save.click();
        await page.locator('.role-policy-save-actions', { hasText: '当前策略版本' }).waitFor({ state: 'visible', timeout: 15_000 });
        const saved = await page.evaluate(() => window.wmb.getSettings());
        const savedCandidate = saved.pi.roleModelPolicies.desk.candidates.find((candidate) => candidate.profileId === 'role-multi' && candidate.model === 'role-model-beta');
        assert(savedCandidate?.thinking === 'high', '保存读回应保留候选思考覆盖');
        await page.reload();
        await waitForAppReady(page);
        await navigateTo(page, 'settings');
        await page.locator('.settings-nav nav button[title="AI 与模型"]').click();
        const reloadedBeta = page.locator('.role-policy-row').first().locator('li[data-profile-id="role-multi"][data-model="role-model-beta"]');
        await reloadedBeta.waitFor({ state: 'visible', timeout: 15_000 });
        assert(await reloadedBeta.locator('.role-policy-thinking select').inputValue() === 'high', 'Electron 保存后重新加载应读回候选思考覆盖');
        assert((await reloadedBeta.locator('.role-policy-copy small').textContent()).includes('候选覆盖：高'), '重新加载后的候选摘要应保留覆盖语义');
        const management = reloadedBeta.locator('.role-policy-management');
        await management.locator('summary').click();
        assert(await management.locator('.role-policy-management-menu button').count() === 3, '候选排序与移除应收进单一管理菜单');
        await reloadedBeta.scrollIntoViewIfNeeded();
        await captureEvidence({ app, page, evidence, artifactsDir, name: 'settings-role-provider-models-1100' });
        await navigateTo(page, 'today');
        await page.locator('.pi-model-trigger').click();
        await page.locator('.pi-model-menu').waitFor({ state: 'visible', timeout: 15_000 });
        await page.waitForFunction(() => document.querySelector('.pi-model-menu button.primary-button')?.textContent?.includes('应用到新回复') === true, null, { timeout: 15_000 });
        assert(await page.locator('.pi-model-menu label').nth(0).locator('select').inputValue() === 'muse-spark-1.3-contributor', 'Pi 对话框应读取当前 Muse 模型');
        const dockThinkingOptions = await page.locator('.pi-model-menu label').nth(1).locator('select option').evaluateAll((options) => options.map((option) => option.value));
        assert(JSON.stringify(dockThinkingOptions) === JSON.stringify(['auto']), `Pi 对话框的未知模型也应只显示自动，实际 ${JSON.stringify(dockThinkingOptions)}`);
        await captureEvidence({ app, page, evidence, artifactsDir, name: 'pi-model-reasoning-unknown-1100' });
        return { surface: 'settings', journey: 'STG-009', providerModels, savedModel: 'role-model-beta', savedThinking: 'high' };
      } finally {
        await new Promise((resolve) => server.close(() => resolve(undefined)));
      }
    }
  }
];
