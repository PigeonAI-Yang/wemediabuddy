const cardRe = /href="\/([^"]+\/[^"]+\/[^"]+)"[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>[\s\S]*?<span class="font-mono text-sm text-foreground">([\d.]+[KM]?)<\/span>/g;
for (const url of ['https://www.skills.sh/hot?range=week', 'https://www.skills.sh/hot?t=week', 'https://www.skills.sh/hot?time=7d', 'https://www.skills.sh/hot?period=week']) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'WeMediaBuddy/0.1' } });
  const html = await res.text();
  const first = [...html.matchAll(cardRe)].map((m) => `${m[2]}|${m[4]}`)[0];
  const words = [...new Set([...html.matchAll(/(24h|7d|30d|all time|this week)/gi)].map((m) => m[1].toLowerCase()))];
  console.log(url, '→', first, '| range words:', words.join(','));
}
