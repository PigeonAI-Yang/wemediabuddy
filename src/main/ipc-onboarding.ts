import type { IpcMain } from 'electron';
import type { OnboardingAiSaveInput, OnboardingAiTestRecord, OnboardingAiTestSettings, OnboardingManager, OnboardingStep, PlatformCheckStatus } from './onboarding.ts';

export function registerOnboardingIpc(ipcMain: Pick<IpcMain, 'handle'>, manager: OnboardingManager): void {
  ipcMain.handle('onboarding:status', () => manager.inspectStatus());
  ipcMain.handle('onboarding:record-step', (_event, step: OnboardingStep) => manager.recordStep(step));
  ipcMain.handle('onboarding:create-default-workspace', () => manager.createDefaultWorkspace());
  ipcMain.handle('onboarding:choose-workspace', () => manager.chooseCustomWorkspace());
  ipcMain.handle('onboarding:test-ai', (_event, input: OnboardingAiTestSettings) => manager.testAiConnection(input));
  ipcMain.handle('onboarding:save-ai', (_event, input: OnboardingAiSaveInput, testResult: OnboardingAiTestRecord) => manager.saveAiConfig(input, testResult));
  ipcMain.handle('onboarding:set-platform', (_event, platformId: string, status: PlatformCheckStatus) => manager.recordPlatformStatus(platformId, status));
  ipcMain.handle('onboarding:complete', () => manager.completeOnboarding());
}
