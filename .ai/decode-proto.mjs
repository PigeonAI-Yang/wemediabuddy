import fs from 'node:fs';
const dir = 'prototype/views/';
fs.mkdirSync('.ai/proto-html', { recursive: true });
for (const f of fs.readdirSync(dir)) {
  const src = fs.readFileSync(dir + f, 'utf8');
  const m = src.match(/=\s*"([\s\S]*)";?\s*$/);
  const html = JSON.parse('"' + m[1] + '"');
  fs.writeFileSync('.ai/proto-html/' + f.replace('.js', '.html'), html);
  console.log(f, '->', html.length);
}
