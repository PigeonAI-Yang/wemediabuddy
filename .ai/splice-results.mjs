// 把 ResultsView 的旧 return 块替换为设计稿版本(按锚点剪切)
import { readFileSync, writeFileSync } from 'node:fs';

const file = 'src/renderer/publishing-results-view.tsx';
const source = readFileSync(file, 'utf8');
const block = readFileSync('.ai/results-return-block.txt', 'utf8').replace(/\n$/, '');

const startMarker = '  return <section className="workflow-page">\n    <header className="page-heading">\n      <div><span>内容结果</span>';
const endMarker = '  </section>;\n}\n\nfunction publicationStatus';
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker);
if (start === -1 || end === -1 || end < start) throw new Error(`markers not found: start=${start} end=${end}`);
const next = source.slice(0, start) + block + '  </section>;\n}\n\nfunction publicationStatus' + source.slice(end + endMarker.length);
writeFileSync(file, next);
console.log('spliced ok, new length:', next.length);
