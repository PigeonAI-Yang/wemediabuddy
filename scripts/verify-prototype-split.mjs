import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve('prototype');
const names = ['today', 'knowledge', 'library', 'canvas', 'studio', 'publish', 'results', 'settings'];
const index = await readFile(path.join(root, 'index.html'), 'utf8');
const context = vm.createContext({ window: {} });

for (const name of names) {
  const relative = `views/${name}.js`;
  if (!index.includes(`<script src="${relative}"></script>`)) throw new Error(`Prototype is missing ${relative}.`);
  vm.runInContext(await readFile(path.join(root, relative), 'utf8'), context);
}

const views = context.window.prototypeViews;
const markup = Object.values(views).join('');
for (const name of names) {
  if (!markup.includes(`id="view-${name}"`)) throw new Error(`Prototype fragment is missing view-${name}.`);
}
if (!index.includes('id="prototype-viewport"')) throw new Error('Prototype viewport is missing.');

console.log(JSON.stringify({ fragments: names.length, viewIds: names.map((name) => `view-${name}`) }));
