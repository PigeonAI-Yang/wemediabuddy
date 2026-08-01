const res = await fetch('https://www.skills.sh/trending', { redirect: 'follow', headers: { 'user-agent': 'WeMediaBuddy/0.1' } });
const html = await res.text();
// 定位每个 range 词后跟着数组数据的 key
for (const match of html.matchAll(/"(24h|today|week|thisWeek|weekly|30d|month|monthly|allTime|all_time)":\s*\[/g)) {
  console.log('key:', match[1], '@', match.index, '→', html.slice(match.index, match.index + 140).replace(/\s+/g, ' '));
}
// skills 数据数组的顶层结构
const top = html.match(/"\w+":\[\{"source":"[^"]+","skillId"/g);
console.log('arrays with skills:', top ? top.length : 0, top?.map((m) => m[0].slice(0, 40)));
