const res = await fetch('https://skills.sh/trending', { redirect: 'follow', headers: { 'user-agent': 'WeMediaBuddy/0.1' } });
const html = await res.text();
console.log('final:', res.url, 'status:', res.status, 'len:', html.length);
const links = [...new Set([...html.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1]).filter((h) => /trending|hot|week|month|leader|time|range|since/.test(h)))];
console.log('links:', links.join(' | '));
const matches = [...html.matchAll(/(24h|24 hours|7d|30d|weekly|monthly|all[- ]time|today|this week|this month|past week|past month)/gi)].map((m) => m[1].toLowerCase());
const words = [...new Set(matches)];
console.log('tabwords:', words.join(', '));
