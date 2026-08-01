// 确认 skills.sh 各页面内嵌数据组的语义 + 找前端 tab 调用的 API
for (const page of ['trending', 'hot']) {
  const res = await fetch(`https://www.skills.sh/${page}`, { redirect: 'follow', headers: { 'user-agent': 'WeMediaBuddy/0.1' } });
  const html = await res.text();
  const re = /\\"source\\":\\"([^\\"]+)\\",\\"skillId\\":\\"([^\\"]+)\\",\\"name\\":\\"([^\\"]+)\\",\\"installs\\":(\d+)/g;
  const items = [...html.matchAll(re)].map((m) => `${m[1]}/${m[3]}:${m[4]}`);
  console.log(page, 'embedded n=', items.length, 'first3:', items.slice(0, 3).join(' | '), 'last:', items[items.length - 1]);
  // API 线索
  const apiHints = [...new Set([...html.matchAll(/(\/api\/[a-z0-9/_-]+)/gi)].map((m) => m[1]))];
  console.log(page, 'api hints:', apiHints.join(' | ') || '(none)');
}
