for (const page of ['trending', 'hot']) {
  const res = await fetch(`https://www.skills.sh/${page}`, { redirect: 'follow', headers: { 'user-agent': 'WeMediaBuddy/0.1' } });
  const html = await res.text();
  // 每个 "installs" 数组前的 key 名
  const datasets = [];
  for (const match of html.matchAll(/"(\w+)":\[(?:\{"source")/g)) datasets.push(`${match[1]}@${match.index}`);
  console.log(page, 'datasets:', datasets.join(' | '));
  // 每处 "installs" 数值采样判断不同窗口
  const installsSamples = [...html.matchAll(/"installs":(\d+)/g)].map((m) => Number(m[1]));
  console.log(page, 'installs max/min/count:', Math.max(...installsSamples), Math.min(...installsSamples), installsSamples.length);
}
