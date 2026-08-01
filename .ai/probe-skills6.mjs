const res = await fetch('https://www.skills.sh/trending', { redirect: 'follow', headers: { 'user-agent': 'WeMediaBuddy/0.1' } });
const html = await res.text();
// 看 24h tab 词到 skills 数据之间的结构
const tabAt = html.indexOf('Trending (24h)');
const dataAt = html.indexOf('"totalSkills"');
console.log(html.slice(dataAt - 2000, dataAt + 300).replace(/\s+/g, ' '));
