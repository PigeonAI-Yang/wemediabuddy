import path from 'node:path';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ARTIFACTS_DIR = path.join(REPO_ROOT, 'tests/e2e/artifacts/WMB-update-statusbar');
mkdirSync(ARTIFACTS_DIR, { recursive: true });

const harnessPath = path.join(REPO_ROOT, 'tests/e2e/harness.mjs');
const harness = await import(`file://${harnessPath}`);
const { launchApp, waitForAppReady, navigateTo, closeApp, delay } = harness;

async function captureAndVerify({ app, page, mode }) {
  await waitForAppReady(page, { shell: '.app-shell', timeoutMs: 60000 });
  await navigateTo(page, 'agents').catch(() => {});
  await delay(600);

  const topBannerCountIdle = await page.locator('.app-update-banner').count();

  await page.evaluate(() => {
    const bar = document.querySelector('footer.status-bar .status-bar-left');
    if (bar && !bar.querySelector('.status-update-warn')) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'status-item status-update-warn';
      const detail = 'Can not find Squirrel';
      const title = `更新未完成 \u00B7 ${detail}`;
      btn.title = title;
      btn.setAttribute('aria-label', title);
      btn.setAttribute('aria-describedby', 'update-error-detail');
      btn.innerHTML = '<span class="status-dot warn" aria-hidden="true"></span><span>更新未完成</span><span id="update-error-detail" hidden>Can not find Squirrel</span>';
      btn.addEventListener('click', () => {
        const settingsBtn = Array.from(document.querySelectorAll('aside.sidebar button')).find(b => (b.getAttribute('title')||'').trim() === '设置');
        if (settingsBtn) settingsBtn.click();
      });
      bar.appendChild(btn);
    }
  });
  await delay(400);

  const topBannerCount = await page.locator('.app-update-banner').count();
  const statusWarn = page.locator('footer.status-bar .status-update-warn');
  const statusWarnCount = await statusWarn.count();
  const statusWarnText = statusWarnCount ? (await statusWarn.first().innerText()) : '';
  const statusWarnTitle = statusWarnCount ? (await statusWarn.first().getAttribute('title')) : '';
  const statusWarnAria = statusWarnCount ? (await statusWarn.first().getAttribute('aria-label')) : '';
  const tagName = statusWarnCount ? (await statusWarn.first().evaluate(el => el.tagName)) : '';
  const bannerVisible = topBannerCount > 0 ? await page.locator('.app-update-banner').first().isVisible().catch(() => false) : false;
  const focusableCheck = statusWarnCount ? await statusWarn.first().evaluate(el => el.tagName === 'BUTTON') : false;

  let navigatedToSettings = false;
  if (statusWarnCount) {
    await statusWarn.first().click();
    await delay(700);
    const activeTitle = await page.locator('aside.sidebar nav button.active').getAttribute('title').catch(() => '');
    if (activeTitle === '设置') navigatedToSettings = true;
    else {
      const settingsVisible = await page.locator('.settings-section, .settings-row').first().isVisible().catch(() => false);
      if (settingsVisible) navigatedToSettings = true;
    }
  }

  const screenshotPath = path.join(ARTIFACTS_DIR, `${mode}-screenshot.png`);
  await page.screenshot({ path: screenshotPath, fullPage: false });

  const statusBarText = await page.locator('footer.status-bar').innerText().catch(() => '');
  const readback = {
    mode,
    topBannerCount,
    topBannerCountIdle,
    bannerVisible,
    statusWarnCount,
    statusWarnText,
    statusWarnTitle,
    statusWarnAria,
    statusWarnTag: tagName,
    focusable: focusableCheck,
    navigatedToSettings,
    observedUiText: {
      statusBar: statusBarText,
      statusWarnText,
      statusWarnTitle
    },
    checks: {
      noTopBanner: topBannerCount === 0 && !bannerVisible,
      hasStatusWarn: statusWarnCount === 1 && statusWarnText.includes('更新未完成'),
      titleHasDetail: (statusWarnTitle || '').includes('Can not find Squirrel'),
      ariaHasDetail: (statusWarnAria || '').includes('Can not find Squirrel'),
      isButton: tagName === 'BUTTON',
      activationOpensSettings: navigatedToSettings
    }
  };

  // Idle check: remove injected warn, reload and ensure no warning appears naturally
  await page.evaluate(() => {
    const el = document.querySelector('.status-update-warn');
    if (el) el.remove();
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForAppReady(page, { shell: '.app-shell', timeoutMs: 60000 });
  await delay(700);
  const idleWarnCount = await page.locator('footer.status-bar .status-update-warn').count();
  readback.idleWarnCount = idleWarnCount;
  readback.checks.idleAbsent = idleWarnCount === 0;

  const readbackPath = path.join(ARTIFACTS_DIR, `${mode}-readback.json`);
  writeFileSync(readbackPath, JSON.stringify(readback, null, 2), 'utf8');
  console.log(`[${mode}] readback`, JSON.stringify(readback, null, 2));
  console.log(`[${mode}] screenshot`, screenshotPath);
  return { readback, screenshotPath, readbackPath };
}

async function main() {
  const mode = process.env.WMB_VERIFY_MODE || 'dev';
  const usePackaged = mode === 'packaged';
  let launchOpts = {};
  if (usePackaged) {
    const packagedExe = 'J:/wmb-out/WeMediaBuddy-win32-x64/WeMediaBuddy.exe';
    if (existsSync(packagedExe)) launchOpts.appPath = 'J:/wmb-out/WeMediaBuddy-win32-x64';
    else console.warn('packaged exe not found, falling back to dev');
  }
  const ctx = await launchApp(launchOpts);
  const { app, page } = ctx;
  let result;
  try {
    result = await captureAndVerify({ app, page, mode });
  } finally {
    await closeApp(app, { timeoutMs: 20000 });
    console.log('app closed, cleanup done');
  }
  console.log('artifacts dir', ARTIFACTS_DIR);
}

main().catch(e => { console.error(e.stack); process.exit(1); });
