// 探测:1) /hot 是否同构卡片 2) /trending 内嵌转义 JSON 里有几组榜单数据
const hot = await fetch('https://www.skills.sh/hot', { redirect: 'follow', headers: { 'user-agent': 'WeMediaBuddy/0.1' } });
const hotHtml = await hot.text();
const cardRe = /href="\/([^"]+\/[^"]+\/[^"]+)"[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>[\s\S]*?<span class="font-mono text-sm text-foreground">([\d.]+[KM]?)<\/span>/g;
const hotCards = [...hotHtml.matchAll(cardRe)].map((m) => `${m[2]}|${m[4]}`);
console.log('hot cards:', hotCards.length, hotCards.slice(0, 3));

const tr = await fetch('https://www.skills.sh/trending', { redirect: 'follow', headers: { 'user-agent': 'WeMediaBuddy/0.1' } });
const trHtml = await tr.text();
const trCards = [...trHtml.matchAll(cardRe)].map((m) => `${m[2]}|${m[4]}`);
console.log('trending cards:', trCards.length, trCards.slice(0, 3));

// 转义 JSON 里的 skill 数组组
const groups = [];
const re = /\\"source\\":\\"([^\\"]+)\\",\\"skillId\\":\\"([^\\"]+)\\",\\"name\\":\\"([^\\"]+)\\",\\"installs\\":(\d+)/g;
let current = [];
let lastIndex = -1;
for (const match of trHtml.matchAll(re)) {
  if (lastIndex !== -1 && match.index - lastIndex > 500) { if (current.length >= 5) groups.push(current); current = []; }
  current.push(`${match[1]}/${match[3]}:${match[4]}`);
  lastIndex = match.index;
}
if (current.length >= 5) groups.push(current);
groups.forEach((group, i) => console.log(`group${i}: n=${group.length} first=${group[0]} last=${group[group.length - 1]}`));
