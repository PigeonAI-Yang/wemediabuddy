const variants = [
  'https://www.skills.sh/trending',
  'https://www.skills.sh/hot',
  'https://www.skills.sh/trending?range=24h',
  'https://www.skills.sh/trending?range=week',
  'https://www.skills.sh/trending?range=month',
  'https://www.skills.sh/trending?t=30d',
  'https://www.skills.sh/trending?time=week',
  'https://www.skills.sh/trending?period=week'
];
for (const url of variants) {
  try {
    const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'WeMediaBuddy/0.1' } });
    const html = await res.text();
    const first = html.match(/href="\/([a-z0-9-]+\/(?:skills\/)?[a-z0-9-]+)"/i)?.[1] ?? '?';
    // 抓 tab 链接的真实 href(带参数的)
    const tabHrefs = [...new Set([...html.matchAll(/href="(\/(?:trending|hot)[^"]*)"/g)].map((m) => m[1]))];
    console.log(res.status, url, '→ first:', first, '| tabs:', tabHrefs.join(' '));
  } catch (error) {
    console.log('ERR', url, String(error).slice(0, 80));
  }
}
