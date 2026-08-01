const res = await fetch('https://www.skills.sh/trending', { redirect: 'follow', headers: { 'user-agent': 'WeMediaBuddy/0.1' } });
const html = await res.text();
// 找 24h/week/30d/all time 这些 tab 词附近的数据结构
for (const word of ['24h', 'thisWeek', 'this_week', '30d', 'allTime', 'all_time', 'weekly', 'monthly']) {
  const index = html.indexOf(word);
  if (index !== -1) console.log(`--- ${word} @${index}:`, html.slice(Math.max(0, index - 120), index + 160).replace(/\s+/g, ' '));
}
// next 数据脚本
const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.){0,200}(?:24h|week|month|all)(?:[^"\\]|\\.){0,200})"\]\)/gi)];
console.log('next chunks with range words:', chunks.length);
for (const c of chunks.slice(0, 3)) console.log(c[1].slice(0, 300));
