import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { PublisherGithub } from '@electron-forge/publisher-github';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { execFileSync } from 'node:child_process';
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
  // WMB-5167/WMB-5240：打包镜像 freshness 门禁——makers/publish 之前逐 outputPath 校验
  // resources/skills/wemedia-buddy-operator 与 canonical 逐字节一致（--require-existing：缺失即失败）。
  // WMB-5245：打包媒体运行时门禁——逐 outputPath 校验 resources/.r/media-runtime 字节哈希，
  // 并实际执行 ffprobe -version / whisper-cli --help / tesseract --version（无 PATH 回退）。
  hooks: {
    async postPackage(_forgeConfig, options) {
      const workspace = process.cwd();
      const installSkillsScript = path.join(workspace, 'scripts', 'install-packaged-skills.mjs');
      const skillScript = path.join(workspace, 'scripts', 'check-skill-mirrors.mjs');
      const mediaRuntimeScript = path.join(workspace, 'scripts', 'verify-packaged-media-runtime.mjs');
      const outputPaths = options.outputPaths?.length ? options.outputPaths : [];
      for (const outputPath of outputPaths) {
        execFileSync(process.execPath, [installSkillsScript, '--output', outputPath], { stdio: 'inherit', cwd: workspace });
        execFileSync(process.execPath, [
          skillScript,
          '--canonical', path.join(workspace, 'skills', 'wemedia-buddy-operator'),
          '--mirror', path.join(outputPath, 'resources', 'skills', 'wemedia-buddy-operator'),
          '--require-existing'
        ], { stdio: 'inherit', cwd: workspace });
        execFileSync(process.execPath, [mediaRuntimeScript, '--output', outputPath], { stdio: 'inherit', cwd: workspace });
      }
    }
  }
};

export default config;
