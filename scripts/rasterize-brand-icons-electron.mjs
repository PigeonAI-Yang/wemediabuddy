import { app, BrowserWindow } from 'electron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const jobsPath = process.argv[2];
if (!jobsPath) {
  console.error('usage: electron rasterize-brand-icons-electron.mjs <jobs.json>');
  process.exit(2);
}

app.disableHardwareAcceleration();

async function rasterize(win, job) {
  const master = await readFile(job.masterAbs);
  const ext = path.extname(job.masterAbs).toLowerCase();
  let dataUrl;
  if (ext === '.svg') {
    // force black glyph into a square transparent canvas via object-fit contain
    const svg = master.toString('utf8');
    const encoded = Buffer.from(svg, 'utf8').toString('base64');
    dataUrl = `data:image/svg+xml;base64,${encoded}`;
  } else {
    const mime = ext === '.ico' ? 'image/x-icon'
      : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
        : ext === '.webp' ? 'image/webp'
          : ext === '.gif' ? 'image/gif'
            : 'image/png';
    dataUrl = `data:${mime};base64,${master.toString('base64')}`;
  }

  const html = `<!doctype html><html><body style="margin:0;background:transparent">
<canvas id="c" width="${job.size}" height="${job.size}"></canvas>
<script>
const img = new Image();
img.onload = () => {
  const c = document.getElementById('c');
  const ctx = c.getContext('2d');
  ctx.clearRect(0,0,c.width,c.height);
  // contain fit with small padding so glyphs don't clip
  const pad = Math.round(c.width * 0.12);
  const box = c.width - pad * 2;
  const scale = Math.min(box / img.width, box / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  const x = (c.width - w) / 2;
  const y = (c.height - h) / 2;
  ctx.drawImage(img, x, y, w, h);
  window.__png = c.toDataURL('image/png');
};
img.onerror = () => { window.__png = 'ERROR'; };
img.src = ${JSON.stringify(dataUrl)};
</script></body></html>`;

  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  const pngDataUrl = await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (window.__png) return resolve(window.__png);
        if (Date.now() - start > 8000) return resolve('TIMEOUT');
        setTimeout(tick, 20);
      };
      tick();
    })
  `);
  if (!pngDataUrl || pngDataUrl === 'ERROR' || pngDataUrl === 'TIMEOUT') {
    throw new Error(`raster failed for ${job.id}: ${pngDataUrl}`);
  }
  const base64 = pngDataUrl.replace(/^data:image\/png;base64,/, '');
  await mkdir(path.dirname(job.outAbs), { recursive: true });
  await writeFile(job.outAbs, Buffer.from(base64, 'base64'));
  console.log(`png ${job.id}`);
}

app.whenReady().then(async () => {
  try {
    const jobs = JSON.parse(await readFile(jobsPath, 'utf8'));
    const win = new BrowserWindow({
      show: false,
      width: 160,
      height: 160,
      webPreferences: {
        offscreen: true,
        sandbox: true,
        contextIsolation: true
      }
    });
    for (const job of jobs) {
      await rasterize(win, job);
    }
    win.destroy();
    app.quit();
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
