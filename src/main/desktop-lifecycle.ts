import { app, autoUpdater, dialog, ipcMain, type Event } from 'electron';
import path from 'node:path';
import type { DataRoot } from './data-root';
import { openDataRoot } from './data-root';
import { createOnboardingManager } from './onboarding';
import { registerOnboardingIpc } from './ipc-onboarding';
import { enrollAiWorkspace, readWorkspaceRegistry } from './workspaces';
import { readPiConfig, savePiConfig } from './pi-config';
import { createUpdateManager } from './app-update';
import { registerAppUpdateIpc } from './ipc-app-update';
import { buildAcceptanceFeedUrl } from './release-feed';
import type { ActiveWorkspaceRuntime } from './workspace-runtime';

type DesktopLifecycleInput = {
  refreshRuntime(dataRoot: DataRoot): Promise<void>;
  defaultBrowserProfileId(): string;
  getActiveRuntime(): ActiveWorkspaceRuntime | null;
  clearActiveRuntime(runtime: ActiveWorkspaceRuntime | null): void;
  stopBackgroundWork(): Promise<void>;
  abortPi(): Promise<void>;
  setShuttingDown(value: boolean): void;
  restoreWindow(): void;
  isShuttingDown(): boolean;
};

export type DesktopLifecycle = {
  registerIpcAndStartUpdater(): void;
  handleBeforeQuit(event: Event): void;
};
export function createDesktopLifecycle(input: DesktopLifecycleInput): DesktopLifecycle {
  const configPath = (name: string) => path.join(app.getPath('userData'), name);
  const chooseWorkspaceDirectory = async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  };
  const onboardingManager = createOnboardingManager({
    userDataPath: () => app.getPath('userData'),
    documentsPath: () => app.getPath('documents'),
    readWorkspaceRegistry: () => readWorkspaceRegistry(configPath('workspace-registry.json')),
    readPiConfig: () => readPiConfig(configPath('pi-api-config.json')),
    openDataRoot,
    enroll: ({ rootPath, displayName }) => enrollAiWorkspace({ registryPath: configPath('workspace-registry.json'), rootPath, displayName, defaultProfileId: input.defaultBrowserProfileId() }),
    refresh: input.refreshRuntime,
    chooseWorkspaceDirectory,
    savePiConfig: (settings) => savePiConfig(settings, configPath('pi-api-config.json'))
  });
  const acceptanceFeedUrl = process.env.WMB_ACCEPTANCE_USER_DATA
    ? buildAcceptanceFeedUrl(process.env.WMB_ACCEPTANCE_UPDATE_TAG)
    : undefined;
  let updateHandoff = false;
  const updateManager = createUpdateManager({
    autoUpdater,
    getVersion: () => app.getVersion(),
    getPlatform: () => process.platform,
    getArch: () => process.arch,
    getUserDataPath: () => app.getPath('userData'),
    getDataRootPath: () => input.getActiveRuntime()?.identity.rootPath ?? null,
    feedUrl: acceptanceFeedUrl,
    updateIntervalMs: 60 * 60 * 1_000,
    prepareForInstall: async () => {
      const runtime = input.getActiveRuntime();
      if (!runtime) throw new Error('当前工作空间未就绪。');
      await runtime.closeClaimsAndDrain();
      runtime.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    },
    cancelPrepareForInstall: () => input.getActiveRuntime()?.reopenClaims(),
    beforeQuitAndInstall: async () => {
      await input.stopBackgroundWork();
      await input.abortPi();
      const runtime = input.getActiveRuntime();
      await runtime?.stop({ drain: false });
      input.clearActiveRuntime(runtime);
      updateHandoff = true;
      input.setShuttingDown(true);
    }
  });

  return {
    registerIpcAndStartUpdater() {
      registerOnboardingIpc(ipcMain, onboardingManager);
      registerAppUpdateIpc(ipcMain, updateManager);
      // 非打包形态（dev / dev-E2E）没有 Squirrel 更新器：启动 autoUpdater 只会报
      // 「Can not find Squirrel」并在界面常驻错误横幅（还会遮住内容点击）。
      // 打包形态（含 packaged E2E 的 acceptance feed）才启动自动更新检查。
      if (!app.isPackaged) return;
      try {
        updateManager.start();
        setTimeout(() => void updateManager.checkForUpdates().catch((error) => console.error('[app-update-check]', error)), 10_000);
      } catch (error) {
        console.error('[app-update-start]', error);
      }
    },
    handleBeforeQuit(event) {
      if (updateHandoff || input.isShuttingDown()) return;
      event.preventDefault();
      input.setShuttingDown(true);
      if (updateManager.shouldInstallOnQuit()) {
        void updateManager.performQuitInstall().then((result) => {
          if (result.installed) return;
          input.setShuttingDown(false);
          input.restoreWindow();
        });
        return;
      }
      void (async () => {
        const runtime = input.getActiveRuntime();
        try {
          await input.stopBackgroundWork();
          await input.abortPi().catch(() => {});
          await runtime?.closeClaimsAndDrain().catch(() => {});
          await runtime?.stop({ drain: false }).catch(() => {});
        } finally {
          input.clearActiveRuntime(runtime);
          app.exit(0);
        }
      })();
    }
  };
}
