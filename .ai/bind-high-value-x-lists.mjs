import { migrateDatabase } from '../src/main/db/migrations.ts';
import { bindXList, listXListBindings } from '../src/main/x-lists.ts';

const DB = 'J:/PigeonYang/WeMediaBuddyData/wmb.db';
const ACCOUNT = '@KimbomArtist';
const TARGETS = [
  { listId: '2082177169078251627', name: 'AI博主' },
  { listId: '2083262800521224237', name: 'AI测评榜' },
  { listId: '2082167563086151821', name: 'AI薅羊毛博主' },
  { listId: '2082167416352579643', name: '赚钱信息差博主' },
  { listId: '2082851520417255750', name: 'AI前沿' }
];

const database = migrateDatabase(DB);
try {
  const results = [];
  for (const target of TARGETS) {
    const bound = bindXList(database, {
      accountKey: ACCOUNT,
      list: {
        listId: target.listId,
        canonicalUrl: `https://x.com/i/lists/${target.listId}`,
        ownerHandle: ACCOUNT,
        name: target.name,
        kind: 'owned'
      },
      observation: { boundBy: 'source-expansion', at: new Date().toISOString() }
    });
    results.push({
      target: target.name,
      ok: bound.ok,
      error: bound.ok ? null : bound.error,
      binding: bound.ok ? {
        listId: bound.data.listId,
        name: bound.data.name,
        enabled: bound.data.enabled,
        sourceFeedId: bound.data.sourceFeedId,
        revision: bound.data.revision
      } : null
    });
  }
  const bindings = listXListBindings(database, ACCOUNT).map((b) => ({
    name: b.name,
    listId: b.listId,
    enabled: b.enabled,
    sourceFeedId: b.sourceFeedId
  }));
  console.log(JSON.stringify({ results, bindings }, null, 2));
  if (results.some((r) => !r.ok)) process.exitCode = 2;
} finally {
  database.close();
}
