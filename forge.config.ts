import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { PublisherGithub } from '@electron-forge/publisher-github';
import { VitePlugin } from '@electron-forge/plugin-vite';
import path from 'node:path';

const releaseOutDir = process.env.WMB_OUT_DIR || (process.platform === 'win32' ? path.join(path.parse(process.cwd()).root, 'wmb-out') : 'out');
const certificateFile = process.env.WMB_WINDOWS_CERTIFICATE_FILE?.trim();
const certificatePassword = process.env.WMB_WINDOWS_CERTIFICATE_PASSWORD;
const windowsSign = certificateFile && certificatePassword
  ? { certificateFile, certificatePassword }
  : undefined;

const config: ForgeConfig = {
  outDir: releaseOutDir,
  packagerConfig: {
    asar: true,
    icon: 'images/icon',
    ...(windowsSign ? { windowsSign } : {}),
    extraResource: ['node_modules/playwright-core', '.r', '.pi/extensions', 'skills', 'resources/xiaohongshu-mcp']
  },
  makers: [
    new MakerSquirrel({
      name: 'WeMediaBuddy',
      setupExe: 'WeMediaBuddy Setup.exe',
      noMsi: true,
      iconUrl: 'https://raw.githubusercontent.com/PigeonAI-Yang/wemediabuddy/master/images/icon.ico',
      setupIcon: 'images/icon.ico',
      ...(windowsSign ? { certificateFile, certificatePassword } : {})
    })
  ],
  publishers: [
    new PublisherGithub({
      repository: { owner: 'PigeonAI-Yang', name: 'wemediabuddy' },
      draft: true,
      prerelease: false
    })
  ],
  plugins: [
    new VitePlugin({
      build: [
        { entry: 'src/main/index.ts', config: 'vite.main.config.ts', target: 'main' },
        { entry: 'src/preload/preload.ts', config: 'vite.preload.config.ts', target: 'preload' }
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.ts' }]
    })
  ],
};

export default config;
