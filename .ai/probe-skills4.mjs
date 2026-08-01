for (const url of ['https://www.skills.sh/hot', 'https://www.skills.sh/new', 'https://www.skills.sh/trending']) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'WeMediaBuddy/0.1' } });
  const html = await res.text();
  const view = html.match(/"view":"([^"]+)"/)?.[1];
  const firstSkill = html.match(/"source":"([^"]+)","skillId":"([^"]+)"/);
  const tabs = [...new Set([...html.matchAll(/href="(\/(?:trending|hot|new|audits|newest)[^"]*)"/g)].map((m) => m[1]))];
  console.log(res.status, url, '| view:', view, '| first:', firstSkill ? `${firstSkill[1]}/${firstSkill[2]}` : '?', '| tabs:', tabs.join(' '));
}
