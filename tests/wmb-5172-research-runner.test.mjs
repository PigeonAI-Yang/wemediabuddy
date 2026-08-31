import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { register } from 'node:module';

// TS loader（与 wmb-5171 同款）：解析 .ts 相对导入。
const hook = "const p=process.getBuiltinModule('node:path'),f=process.getBuiltinModule('node:fs'),u=process.getBuiltinModule('node:url');export async function resolve(s,c,n){if((s.startsWith('./')||s.startsWith('../'))&&!p.extname(s)){const b=p.resolve(p.dirname(u.fileURLToPath(c.parentURL)),s);if(f.existsSync(b+'.ts'))return {url:u.pathToFileURL(b+'.ts').href,shortCircuit:true};}return n(s,c);}";
register('data:text/javascript,' + encodeURIComponent(hook), import.meta.url);

import {
  RESEARCH_DEFAULT_BUDGET,
  parseClaimProposals,
  parseResearchCandidates,
  researchSourceKeyFor,
  resolveResearchBudget,
  runResearchJob
} from '../src/main/research-job-runner.ts';
import {
  assessSupportThreshold,
  canonicalUrlKey,
  evidenceDomainOf,
  validateClaimProposal
} from '../src/main/research-claim-validation.ts';
import { canonicalizeUrl } from '../src/main/sources.ts';
import { parseResearchEvidencePack } from '../src/main/research-task-state.ts';
import { buildSaveSourcePayload, coreTools } from '../.pi/extensions/wmb-mcp/wmb-mcp-tools-core.ts';
import {
  researchDiscoveryPrompt,
  researchPiRuntimeArgs,
  researchProposalPrompt,
  researchSkillSourcePath,
  resolveResearchPromptTimeoutMs,
  researchToolDisciplineText
} from '../src/main/research-job-runtime.ts';


const BUDGET = { timeMinutes: 12, minValidSources: 15, maxCandidates: 40, maxParallelFetches: 3, maxRounds: 1 };

function makeGap(overrides = {}) {
  return { gapId: 'research-gap-1', parentJobId: 'job-parent-1', parentTaskId: 'task-parent-1', parentRoleId: 'writer',
    requiredClaims: [{ key: 'claim_a', text: '声明 A（事实）', type: 'fact' }, { key: 'claim_b', text: '声明 B（价格）', type: 'price' }],
    budget: { ...BUDGET }, channels: ['web'], ...overrides };
}

function makeTask(overrides = {}) {
  return { id: 'task-research-1', businessDate: '2026-08-11', contextRefs: {}, checkpoint: {}, progress: {}, ...overrides };
}

function candidate(key, claimKey, url, extra = {}) {
  return { key, claimKey, url, title: `Title ${key}`, author: 'Author', summary: 'Summary text', publishedAt: '2026-08-10', excerpt: '原文关键句摘录。', sourceKind: 'secondary', ...extra };
}

const T0 = Date.UTC(2026, 7, 11, 1, 0, 0); // 固定起点

function makeDeps(overrides = {}) {
  const state = {
    nowMs: overrides.nowMs ?? T0,
    candidates: overrides.candidates ?? [],
    fetch: overrides.fetch ?? (async () => ({ ok: true, text: 'body' })),
    proposals: overrides.proposals ?? [],
    writes: [],
    progress: [],
    claims: overrides.initialClaims ? overrides.initialClaims.map((claim) => ({ ...claim })) : [],
    writeReceipts: overrides.initialWriteReceipts ? overrides.initialWriteReceipts.map((receipt) => ({ ...receipt })) : [],
    fetchCalls: 0, fetchInFlight: 0, maxInFlight: 0, proposeCalls: 0, discoverCalls: 0,
    sourceSeq: 0,
    sourcesByUrl: overrides.sourcesByUrl ?? new Map(),
    ...overrides.state
  };
  const deps = {
    now: () => new Date(state.nowMs),
    discoverCandidates: async (gap, options) => { state.discoverCalls += 1; state.lastDiscoverOptions = options; return state.candidates; },
    fetchCandidate: async (candidate) => {
      state.fetchCalls += 1;
      state.fetchInFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.fetchInFlight);
      try { return await state.fetch(candidate, state); } finally { state.fetchInFlight -= 1; }
    },
    writeSource: async (input) => {
      state.writes.push({ ...input, evidenceSourceIds: undefined });
      const replay = state.writeReceipts.find((receipt) => receipt.requestId === input.requestId);
      if (replay) return { sourceId: replay.sourceId, created: replay.created };
      const key = canonicalizeUrl(input.url);
      const existing = state.sourcesByUrl.get(key);
      const sourceId = existing ?? `src-${++state.sourceSeq}`;
      state.sourcesByUrl.set(key, sourceId);
      const receipt = { requestId: input.requestId, sourceId, created: !existing };
      state.writeReceipts.push(receipt);
      return { sourceId, created: receipt.created };
    },
    listSourceWriteReceipts: async () => state.writeReceipts.map(({ sourceId, created }) => ({ sourceId, created })),
    proposeClaims: async () => { state.proposeCalls += 1; return state.proposals; },
    persistProgress: async (progressInput) => { state.progress.push(progressInput); },
    persistClaims: async (claims) => {
      for (const claim of claims) {
        const existing = state.claims.find((row) => row.claimKey === claim.claimKey);
        if (existing) Object.assign(existing, { status: claim.status, verdictReason: claim.verdictReason, evidenceSourceIds: [...claim.evidenceSourceIds] });
        else state.claims.push({ id: `claim-row-${claim.claimKey}`, claimKey: claim.claimKey, status: claim.status, verdictReason: claim.verdictReason, evidenceSourceIds: [...claim.evidenceSourceIds], needsTimeExcerpt: claim.claimType === 'price' || claim.claimType === 'policy' });
      }
    },
    listClaims: async () => state.claims.map((row) => ({ ...row, evidenceSourceIds: [...row.evidenceSourceIds] }))
  };
  return { deps, state };
}

function run(inputOverrides = {}, depsOverrides = {}) {
  const { deps, state } = makeDeps(depsOverrides);
  const input = { task: makeTask(), gap: makeGap(), signal: new AbortController().signal, ...inputOverrides };
  return { promise: runResearchJob(input, deps), deps, state };
}

function proposal(claimKey, status, evidenceSourceIds = [], verdictReason = null) {
  return { claimKey, status, evidenceSourceIds, verdictReason };
}


test('WMB-5172: time gate — fetch stops when budget exhausted, resume-seeded judged claims keep partial', async () => {
  const checkpoint = { round: 1, startedAt: new Date(T0).toISOString(), budgetLeftMs: 100_000, candidatesProcessed: 0, claimsSnapshot: { claim_a: 'supported' } };
  const progress = { planned: 40, processed: 0, verified: 1, saved: 1 };
  const initialClaims = [{ id: 'claim-row-a', claimKey: 'claim_a', status: 'supported', verdictReason: 'official_source', evidenceSourceIds: ['src-prev'], needsTimeExcerpt: false }];
  const candidates = Array.from({ length: 12 }, (_, i) => candidate(`c${i}`, 'claim_b', `https://b.example.com/${i}.html`));
  const { promise, state } = run(
    { task: makeTask({ checkpoint, progress }) },
    { candidates, nowMs: T0, initialClaims, fetch: async (_candidate, s) => { s.nowMs += 40_000; return { ok: true, text: 'body' }; } }
  );
  const result = await promise;
  assert.equal(result.terminal, 'partial');
  assert.equal(result.pack.terminalReason, 'budget_exhausted');
  // 每批 3 条、每批 +120s：首批后剩余 100s-120s=0 → 第二批不再抓取。
  assert.equal(state.fetchCalls, 3);
  assert.equal(result.progress.processed, 3);
  assert.equal(result.progress.verified, 4); // 1（恢复种子）+ 3
  assert.equal(result.progress.saved, 4);
  assert.equal(state.proposeCalls, 0, '预算耗尽后不得再执行建议阶段');
  assert.deepEqual([...result.pack.unresolvedRequiredClaims], ['claim_b']);
  assert.equal(result.pack.validSourceCount, 4);
  assert.equal(result.pack.candidateCount, 3);
  assert.deepEqual(result.pack.claims.map((claim) => claim.key), ['claim_a']);
  const last = state.progress.at(-1);
  assert.equal(last.checkpoint.candidatesProcessed, 3);
  assert.equal(last.checkpoint.budgetLeftMs, 0);
  // EvidencePack 可被严格解析器读回。
  assert.ok(parseResearchEvidencePack({ ...result.pack }));
});

test('WMB-5172: candidate cap — discovery beyond 40 is machine-truncated', async () => {
  const candidates = Array.from({ length: 45 }, (_, i) => candidate(`c${i}`, 'claim_a', `https://a${i}.example.com/p${i}`));
  const { promise, state } = run(
    { gap: makeGap({ requiredClaims: [{ key: 'claim_a', text: 'A', type: 'fact' }] }) },
    { candidates, proposals: [proposal('claim_a', 'supported', ['src-1', 'src-2'])] }
  );
  const result = await promise;
  assert.equal(state.lastDiscoverOptions.maxCandidates, 40);
  assert.equal(state.fetchCalls, 40, '只处理 40 候选');
  assert.equal(result.progress.processed, 40);
  assert.equal(result.terminal, 'succeeded');
  assert.equal(result.pack.terminalReason, 'claims_resolved');
  assert.equal(result.pack.candidateCount, 40);
  assert.equal(result.pack.validSourceCount, 40);
  assert.equal(result.pack.sourceIds.length, 40);
  assert.equal(result.pack.jobId, 'task-research-1');
  assert.equal(result.pack.round, 1);
  assert.equal(result.pack.kind, 'research_evidence');
  assert.equal(result.checkpoint.candidatesProcessed, 40);
  assert.equal(state.writes[0].requestId, `task-research-1:source:${researchSourceKeyFor('https://a0.example.com/p0')}`);
  assert.equal(state.writes[39].requestId, `task-research-1:source:${researchSourceKeyFor('https://a39.example.com/p39')}`);
  assert.equal(new Set(state.writes.map((w) => w.requestId)).size, 40, '互异 URL → 互异数字键');
});

test('WMB-5172: in-task fetch concurrency bounded by maxParallelFetches=3', async () => {
  const candidates = Array.from({ length: 6 }, (_, i) => candidate(`c${i}`, 'claim_a', `https://a.example.com/${i}`));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { promise, state } = run({}, { candidates, fetch: async () => { await gate; return { ok: true, text: 'body' }; } });
  const pending = promise;
  // 等首批 3 个抓取全部在飞后放行。
  await new Promise((resolve) => { const timer = setInterval(() => { if (state.fetchInFlight === 3) { clearInterval(timer); resolve(); } }, 1); });
  assert.equal(state.fetchInFlight, 3, '并发在飞不超过 3');
  release();
  const result = await pending;
  assert.ok(state.maxInFlight <= 3, `max in-flight ${state.maxInFlight} must not exceed 3`);
  assert.ok(state.maxInFlight >= 2, 'batching observed');
  assert.equal(result.progress.processed, 6);
});

test('WMB-5172: single round hard limit — resume never begins round 2', async () => {
  const checkpoint = { round: 2, startedAt: new Date(T0).toISOString(), budgetLeftMs: 600_000, candidatesProcessed: 20, claimsSnapshot: { claim_a: 'unresolved', claim_b: 'unresolved' } };
  const progress = { planned: 40, processed: 20, verified: 2, saved: 2 };
  const initialClaims = [
    { id: 'row-a', claimKey: 'claim_a', status: 'unresolved', verdictReason: 'threshold_not_met', evidenceSourceIds: [], needsTimeExcerpt: false },
    { id: 'row-b', claimKey: 'claim_b', status: 'unresolved', verdictReason: 'threshold_not_met', evidenceSourceIds: [], needsTimeExcerpt: true }
  ];
  const { promise, state } = run({ task: makeTask({ checkpoint, progress }) }, { candidates: [candidate('c0', 'claim_a', 'https://a.example.com/x')], initialClaims });
  const result = await promise;
  assert.equal(state.discoverCalls, 0, 'round=2 恢复点不得重新发现候选');
  assert.equal(state.fetchCalls, 0);
  assert.equal(result.terminal, 'partial');
  assert.equal(result.pack.terminalReason, 'budget_exhausted', '轮次预算耗尽语义');
  assert.equal(result.progress.processed, 20, '计数不得回退');
  assert.deepEqual([...result.pack.unresolvedRequiredClaims], ['claim_a', 'claim_b']);
  assert.equal(result.checkpoint.round, 2);
});

test('WMB-5172: zero judged claims → failed NO_CLAIMS_JUDGED (no fake success)', async () => {
  const candidates = Array.from({ length: 3 }, (_, i) => candidate(`c${i}`, 'claim_a', `https://${'abc'[i]}.example.com/${i}`));
  const { promise, state } = run({}, { candidates, fetch: async (_c, s) => { s.nowMs += 10 * 60_000; return { ok: true, text: 'body' }; } });
  const result = await promise;
  assert.equal(result.terminal, 'failed');
  assert.equal(result.failure.code, 'RESEARCH_NO_CLAIMS_JUDGED');
  assert.equal(result.pack, null);
  assert.equal(state.proposeCalls, 0);
});

test('WMB-5172: candidates exhausted with no verdicts → partial candidates_exhausted (all unresolved)', async () => {
  const candidates = [candidate('c0', 'claim_a', 'https://a.example.com/x')];
  const { promise, state } = run({}, { candidates, proposals: [] });
  const result = await promise;
  assert.equal(result.terminal, 'partial');
  assert.equal(result.pack.terminalReason, 'candidates_exhausted');
  assert.equal(state.proposeCalls, 1);
  assert.deepEqual([...result.pack.unresolvedRequiredClaims], ['claim_a', 'claim_b']);
  assert.equal(result.pack.claims[0].status, 'unresolved');
  assert.equal(result.pack.claims[0].verdictReason, 'no_proposal');
  assert.equal(result.pack.claims[0].needsTimeExcerpt, false);
  assert.equal(result.pack.claims[1].needsTimeExcerpt, true, 'price claim 带 needs_time_excerpt');
});

// ---------------------------------------------------------------------------
// 门槛矩阵 / 四态（validateClaimProposal 纯函数）
// ---------------------------------------------------------------------------

function validationCtx(claimKey, claimType, items, failures = { total: items.length ? items.length : 0, failed: 0, reason: null }) {
  return { claimKey, claimType, evidence: new Map(items.map((item) => [item.sourceId, item])), candidateTotal: failures.total, candidateFailed: failures.failed, failureReason: failures.reason };
}

function item(sourceId, url, extra = {}) {
  return { sourceId, claimKey: 'claim_a', url, title: 'T', author: 'A', summary: 'S', publishedAt: '2026-08-10', excerpt: 'quote', sourceKind: 'secondary', ...extra };
}

test('WMB-5172: threshold matrix — 1 official / 2 independent secondary pass, 1 secondary or same-domain fail', () => {
  const official = item('s1', 'https://official.example.com/p', { sourceKind: 'official' });
  const sec1 = item('s2', 'https://one.example.com/p');
  const sec2 = item('s3', 'https://two.example.com/p');
  const sameDomain = item('s4', 'https://one.example.com/q');

  assert.equal(validateClaimProposal(validationCtx('claim_a', 'fact', [official]), proposal('claim_a', 'supported', ['s1'])).status, 'supported');
  assert.equal(validateClaimProposal(validationCtx('claim_a', 'fact', [sec1, sec2]), proposal('claim_a', 'supported', ['s2', 's3'])).status, 'supported');
  assert.equal(validateClaimProposal(validationCtx('claim_a', 'fact', [sec1, sameDomain]), proposal('claim_a', 'supported', ['s2', 's4'])).status, 'unresolved');
  assert.equal(validateClaimProposal(validationCtx('claim_a', 'fact', [sec1]), proposal('claim_a', 'supported', ['s2'])).status, 'unresolved');
  // 伪造 supported（1 条二手）→ 降级 unresolved threshold_not_met
  const forged = validateClaimProposal(validationCtx('claim_a', 'fact', [sec1]), proposal('claim_a', 'supported', ['s2'], '官方确认'));
  assert.deepEqual(forged, { status: 'unresolved', verdictReason: 'threshold_not_met' });
  // 空证据 + supported 建议 → 降级
  assert.equal(validateClaimProposal(validationCtx('claim_a', 'fact', []), proposal('claim_a', 'supported', ['nope'])).verdictReason, 'threshold_not_met');
});

test('WMB-5172: price/policy evidence requires time + verbatim excerpt per item', () => {
  const noTime = item('s1', 'https://one.example.com/p', { publishedAt: null, collectedAt: null });
  const noExcerpt = item('s2', 'https://two.example.com/p', { excerpt: null });
  const complete = item('s3', 'https://three.example.com/p');
  const ctx = (items) => validationCtx('claim_b', 'price', items);
  const supported = (ids) => proposal('claim_b', 'supported', ids);
  assert.equal(validateClaimProposal(ctx([noTime, complete]), supported(['s1', 's3'])).verdictReason, 'threshold_not_met'); // 缺时间
  assert.equal(validateClaimProposal(ctx([noExcerpt, complete]), supported(['s2', 's3'])).verdictReason, 'threshold_not_met'); // 缺摘录
  assert.equal(validateClaimProposal(ctx([complete, item('s4', 'https://four.example.com/p')]), supported(['s3', 's4'])).status, 'supported'); // 齐备
});

test('WMB-5172: contradicted reaches same threshold or official overturn', () => {
  const official = item('s1', 'https://official.example.com/p', { sourceKind: 'official' });
  const sec1 = item('s2', 'https://one.example.com/p');
  const sec2 = item('s3', 'https://two.example.com/p');
  assert.equal(validateClaimProposal(validationCtx('claim_a', 'fact', [official]), proposal('claim_a', 'contradicted', ['s1'])).status, 'contradicted');
  assert.equal(validateClaimProposal(validationCtx('claim_a', 'fact', [sec1, sec2]), proposal('claim_a', 'contradicted', ['s2', 's3'])).status, 'contradicted');
  assert.equal(validateClaimProposal(validationCtx('claim_a', 'fact', [sec1]), proposal('claim_a', 'contradicted', ['s2'])).status, 'unresolved');
});

test('WMB-5172: unresolved proposal kept; source_unavailable only when all candidates failed read', () => {
  const sec1 = item('s1', 'https://one.example.com/p');
  const verdict = validateClaimProposal(validationCtx('claim_a', 'fact', [sec1]), proposal('claim_a', 'unresolved', ['s1'], '双方说法矛盾'));
  assert.deepEqual(verdict, { status: 'unresolved', verdictReason: '双方说法矛盾' });
  // 全部候选读取失败（auth_required）→ 机器推导 source_unavailable，不依赖建议。
  const allFailed = validateClaimProposal({ claimKey: 'claim_a', claimType: 'fact', evidence: new Map(), candidateTotal: 2, candidateFailed: 2, failureReason: 'auth_required' }, proposal('claim_a', 'supported', []));
  assert.deepEqual(allFailed, { status: 'source_unavailable', verdictReason: 'auth_required' });
  // 建议 source_unavailable 但候选并非全部失败 → 降级 unresolved。
  const fakeUnavailable = validateClaimProposal(validationCtx('claim_a', 'fact', [sec1], { total: 2, failed: 1, reason: 'auth_required' }), proposal('claim_a', 'source_unavailable', []));
  assert.deepEqual(fakeUnavailable, { status: 'unresolved', verdictReason: 'threshold_not_met' });
  // 无建议 → unresolved no_proposal。
  assert.deepEqual(validateClaimProposal(validationCtx('claim_a', 'fact', [sec1]), null), { status: 'unresolved', verdictReason: 'no_proposal' });
});

test('WMB-5172: source_unavailable derivation runs end-to-end through the runner', async () => {
  const candidates = [candidate('c0', 'claim_a', 'https://a.example.com/x'), candidate('c1', 'claim_a', 'https://b.example.com/y')];
  const { promise, state } = run(
    { gap: makeGap({ requiredClaims: [{ key: 'claim_a', text: 'A', type: 'fact' }] }) },
    { candidates, fetch: async () => ({ ok: false, reason: 'auth_required' }) }
  );
  const result = await promise;
  assert.equal(result.terminal, 'partial');
  assert.deepEqual([...result.pack.unresolvedRequiredClaims], ['claim_a']);
  assert.equal(result.pack.claims[0].status, 'source_unavailable');
  assert.equal(result.pack.claims[0].verdictReason, 'auth_required');
  assert.equal(state.writes.length, 0);
  assert.equal(result.pack.terminalReason, 'candidates_exhausted');
});

// ---------------------------------------------------------------------------
// 重启恢复续跑
// ---------------------------------------------------------------------------

test('WMB-5172: resume consumes remaining checkpoint budget, keeps counters and never resets startedAt', async () => {
  const checkpoint = { round: 1, startedAt: new Date(T0).toISOString(), budgetLeftMs: 360_000, candidatesProcessed: 20, claimsSnapshot: { claim_a: 'unresolved' } };
  const progress = { planned: 40, processed: 20, verified: 10, saved: 8 };
  const initialClaims = [{ id: 'row-a', claimKey: 'claim_a', status: 'unresolved', verdictReason: 'threshold_not_met', evidenceSourceIds: [], needsTimeExcerpt: false }];
  const candidates = Array.from({ length: 30 }, (_, i) => candidate(`c${i}`, 'claim_a', `https://a${i}.example.com/p${i}`));
  const { promise, state } = run(
    { task: makeTask({ checkpoint, progress }), gap: makeGap({ requiredClaims: [{ key: 'claim_a', text: 'A', type: 'fact' }] }) },
    { candidates, nowMs: T0 + 300_000, initialClaims, proposals: [proposal('claim_a', 'supported', ['src-1', 'src-2'])] }
  );
  const result = await promise;
  assert.equal(result.terminal, 'succeeded');
  assert.equal(result.pack.terminalReason, 'claims_resolved');
  // 剩余预算 = 360s - 300s = 60s；候选头寸 = 40 - 20 = 20。
  assert.equal(result.progress.processed, 40);
  assert.equal(result.progress.verified, 30);
  assert.equal(result.progress.saved, 28);
  assert.equal(result.pack.candidateCount, 40);
  assert.equal(result.pack.validSourceCount, 30);
  assert.equal(result.checkpoint.startedAt, checkpoint.startedAt, 'startedAt 不得重置');
  assert.equal(result.checkpoint.budgetLeftMs, 60_000, '只消耗剩余预算');
  assert.equal(result.checkpoint.candidatesProcessed, 40);
  assert.equal(state.writes[0].requestId, `task-research-1:source:${researchSourceKeyFor('https://a0.example.com/p0')}`, '续跑 requestId 由 canonical URL 派生，与位置无关');
  assert.equal(state.fetchCalls, 20, '只处理剩余头寸 20 候选');
  assert.equal(result.pack.claims[0].status, 'supported');
  assert.deepEqual(result.pack.claims[0].evidenceSourceIds, ['src-1', 'src-2']);
  assert.equal(result.pack.sourceIds.length, 20, '本轮新入库证据（既有 claim 行无证据 id）');
  assert.equal(result.pack.sourceIds[0], 'src-1');
});

// ---------------------------------------------------------------------------
// 写回幂等
// ---------------------------------------------------------------------------

test('WMB-5172: canonical-URL write-back idempotent (duplicate candidate → one source, no double count)', async () => {
  const checkpoint = { round: 1, startedAt: new Date(T0).toISOString(), budgetLeftMs: 360_000, candidatesProcessed: 0, claimsSnapshot: {} };
  const candidates = [
    candidate('c0', 'claim_a', 'https://a.example.com/p', { sourceKind: 'official' }),
    candidate('c1', 'claim_a', 'https://a.example.com/p', { sourceKind: 'official' }) // 同 canonical URL 重复候选
  ];
  const { deps, state } = makeDeps({ candidates, proposals: [proposal('claim_a', 'supported', ['src-1'])] });
  const input = { task: makeTask({ checkpoint }), gap: makeGap({ requiredClaims: [{ key: 'claim_a', text: 'A', type: 'fact' }] }), signal: new AbortController().signal };
  const result = await runResearchJob(input, deps);
  assert.equal(result.progress.processed, 2);
  assert.equal(result.progress.saved, 1, 'canonical URL 去重：重复候选不新增 source');
  assert.equal(result.progress.verified, 1, '同 sourceId 不重复计数 verified');
  assert.equal(state.writes.length, 1, '同 URL 候选只派发一次 source 写命令');
  assert.equal(state.writes[0].requestId, `task-research-1:source:${researchSourceKeyFor('https://a.example.com/p')}`);
  assert.equal(state.sourcesByUrl.size, 1);
  assert.deepEqual(result.pack.sourceIds, ['src-1']);
  assert.equal(result.terminal, 'succeeded');
});

test('WMB-5377: duplicate URL candidates never reuse one source request identity with different command input', async () => {
  const checkpoint = { round: 1, startedAt: new Date(T0).toISOString(), budgetLeftMs: 360_000, candidatesProcessed: 0, claimsSnapshot: {} };
  const candidates = [
    candidate('quote-a', 'claim_a', 'https://example.com/transcript', { title: '原访谈全文', summary: '第一段摘要', excerpt: '第一段原文', sourceKind: 'official' }),
    candidate('quote-b', 'claim_a', 'https://example.com/transcript', { title: '原访谈推理章节', summary: '第二段摘要', excerpt: '第二段原文', sourceKind: 'official' })
  ];
  const { deps, state } = makeDeps({ candidates, proposals: [proposal('claim_a', 'supported', ['src-1'])] });
  const dispatched = new Map();
  const strictDeps = {
    ...deps,
    writeSource: async (input) => {
      const commandInput = JSON.stringify({
        title: input.title, url: canonicalizeUrl(input.url), author: input.author,
        summary: input.summary, publishedAt: input.publishedAt, excerpt: input.excerpt
      });
      const previous = dispatched.get(input.requestId);
      if (previous !== undefined && previous !== commandInput) throw Object.assign(new Error('同一 requestId 已绑定不同命令或输入。'), { code: 'REQUEST_REPLAY_CONFLICT' });
      dispatched.set(input.requestId, commandInput);
      state.writes.push(input);
      return { sourceId: 'src-1', created: previous === undefined };
    }
  };
  const result = await runResearchJob({
    task: makeTask({ checkpoint }),
    gap: makeGap({ requiredClaims: [{ key: 'claim_a', text: 'A', type: 'fact' }] }),
    signal: new AbortController().signal
  }, strictDeps);
  assert.equal(result.terminal, 'succeeded');
  assert.equal(state.writes.length, 1, '同一 canonical URL 在一轮内只派发一次 source 写命令');
  assert.equal(dispatched.size, 1);
  assert.equal(result.progress.processed, 2, '候选处理计数保持真实');
  assert.equal(result.progress.verified, 1);
});

test('WMB-5172: reordered resume — URL-stable requestId, replayed created:true receipts do not inflate verified/saved', async () => {
  const gap = makeGap({ requiredClaims: [{ key: 'claim_a', text: 'A', type: 'fact' }] });
  const urlA = 'https://a.example.com/p', urlB = 'https://b.example.com/p', urlC = 'https://c.example.com/p';
  const checkpoint = { round: 1, startedAt: new Date(T0).toISOString(), budgetLeftMs: 600_000, candidatesProcessed: 0, claimsSnapshot: {} };
  const progress = { planned: 40, processed: 0, verified: 0, saved: 0 };
  const signal = new AbortController().signal;
  // 阶段 1（干净 checkpoint）：同 canonical URL 重复候选（a 与 a#frag）→ 同一 requestId，只计一次；后端重放回执 created:true。
  const { deps, state } = makeDeps({
    candidates: [candidate('c0', 'claim_a', urlA), candidate('c1', 'claim_a', `${urlA}#frag`), candidate('c2', 'claim_a', urlB)],
    proposals: [proposal('claim_a', 'unresolved', ['src-1', 'src-2'])],
    replayCreated: true
  });
  const run1 = await runResearchJob({ task: makeTask({ checkpoint, progress }), gap, signal }, deps);
  assert.equal(run1.progress.processed, 3);
  assert.equal(run1.progress.verified, 2, '重复候选只计一次 verified');
  assert.equal(run1.progress.saved, 2, 'created:true 重放回执不虚增 saved');
  assert.equal(state.writes.length, 2, '首轮 canonical URL 去重后只派发 A/B 两次写命令');
  assert.notEqual(state.writes[0].requestId, state.writes[1].requestId, '互异 URL → 互异 requestId');
  state.claims = []; // 模拟 sources 回执已提交、claim 尚未落库即崩溃。
  state.candidates = [candidate('c1', 'claim_a', urlB), candidate('c0', 'claim_a', urlA), candidate('c3', 'claim_a', urlC)];
  const run2 = await runResearchJob({ task: makeTask({ checkpoint: run1.checkpoint, progress: run1.progress }), gap, signal }, deps);
  assert.equal(run2.progress.processed, 6);
  assert.equal(run2.progress.verified, 3, '重放既有证据不虚增 verified（2 既有 + 1 新）');
  assert.equal(run2.progress.saved, 3, '重放 created:true 回执不虚增 saved（2 既有 + 1 新）');
  assert.equal(state.writes[2].requestId, state.writes[1].requestId, '乱序重放沿用原 URL requestId（幂等重放，无 REQUEST_REPLAY_CONFLICT）');
  assert.equal(state.writes[3].requestId, state.writes[0].requestId);
  assert.equal(state.writes[4].requestId, `task-research-1:source:${researchSourceKeyFor(urlC)}`);
  assert.equal(run2.pack.sourceIds.length, 3, '既有证据 + 新证据去重后 3 个 sourceId');
});

test('WMB-5172: resume skips candidates of already-terminal claims', async () => {
  const checkpoint = { round: 1, startedAt: new Date(T0).toISOString(), budgetLeftMs: 360_000, candidatesProcessed: 5, claimsSnapshot: { claim_a: 'supported' } };
  const initialClaims = [{ id: 'row-a', claimKey: 'claim_a', status: 'supported', verdictReason: 'official_source', evidenceSourceIds: ['src-1'], needsTimeExcerpt: false }];
  const candidates = [candidate('c0', 'claim_a', 'https://a.example.com/p'), candidate('c1', 'claim_a', 'https://b.example.com/q')];
  const { promise, state } = run(
    { task: makeTask({ checkpoint }), gap: makeGap({ requiredClaims: [{ key: 'claim_a', text: 'A', type: 'fact' }] }) },
    { candidates, initialClaims }
  );
  const result = await promise;
  assert.equal(state.fetchCalls, 0);
  assert.equal(result.terminal, 'succeeded');
  assert.equal(result.pack.terminalReason, 'claims_resolved');
  assert.equal(result.progress.processed, 5);
  assert.deepEqual(result.pack.sourceIds, ['src-1'], '恢复续跑不丢已入库证据 sourceIds');
});

// ---------------------------------------------------------------------------
// wmb_save_source 扩展（CAP-028 §6.4）
// ---------------------------------------------------------------------------

test('WMB-5172: wmb_save_source optional fields — research payload vs non-research unchanged', () => {
  const research = buildSaveSourcePayload({
    requestId: 'task-research-1:source:1', taskId: 'task-research-1', grantId: 'grant-1', workerLeaseId: 'lease-1',
    title: 'T', originalUrl: 'https://a.example.com/p', summary: 'S', author: 'A',
    publishedAt: '2026-08-10', excerpt: '原文关键句', clientLabel: 'WMB research'
  });
  assert.equal(research.request_id, 'task-research-1:source:1');
  assert.equal(research.task_id, 'task-research-1');
  assert.equal(research.worker_lease_id, 'lease-1');
  const item = research.items[0];
  assert.equal(item.clientLabel, 'WMB research');
  assert.deepEqual(item.categories, ['研究补料']);
  assert.equal(item.publishedAt, '2026-08-10');
  assert.deepEqual(JSON.parse(item.evidence), { excerpt: '原文关键句' });
  assert.equal('feedId' in item, false, '研究写回禁止 feedId');

  const plain = buildSaveSourcePayload({ requestId: 'r1', taskId: 't1', grantId: 'g1', title: 'T', originalUrl: 'https://a.example.com/p', summary: 'S' });
  assert.equal(plain.items[0].clientLabel, 'WMB built-in Pi');
  assert.deepEqual(plain.items[0].categories, ['Pi 协作']);
  assert.deepEqual(plain.items[0].keywords, ['Pi', 'WMB', 'MCP']);
  assert.equal(plain.items[0].author, undefined);
  assert.equal(plain.items[0].evidence, undefined);
  assert.equal(plain.items[0].publishedAt, undefined);
});

test('WMB-5172: research boundary rejection — missing author or envelope throws, feedId not in tool schema', () => {
  const base = { requestId: 'r1', taskId: 't1', grantId: 'g1', workerLeaseId: 'l1', title: 'T', originalUrl: 'https://a.example.com/p', summary: 'S', clientLabel: 'WMB research' };
  assert.throws(() => buildSaveSourcePayload({ ...base, author: undefined }), /RESEARCH_EVIDENCE_FIELDS_REQUIRED/);
  assert.throws(() => buildSaveSourcePayload({ ...base, author: 'A', workerLeaseId: undefined }), /RESEARCH_ENVELOPE_REQUIRED/);
  assert.throws(() => buildSaveSourcePayload({ ...base, author: 'A', grantId: '' }), /RESEARCH_ENVELOPE_REQUIRED/);

  const saveSource = coreTools.find((tool) => tool.name === 'wmb_save_source');
  assert.ok(saveSource, 'wmb_save_source registered');
  assert.equal(saveSource.parameters.additionalProperties, false, '工具 schema 拒绝未知字段（feedId 无法进入研究写回）');
  assert.equal('feedId' in saveSource.parameters.properties, false);
  for (const field of ['publishedAt', 'excerpt', 'clientLabel']) {
    assert.ok(field in saveSource.parameters.properties, `optional field ${field} exposed`);
  }
});

// ---------------------------------------------------------------------------
// 结构化输出解析 / 预算默认 / prompt 纪律
// ---------------------------------------------------------------------------

test('WMB-5172: structured output parsers are fail-closed', () => {
  const valid = '```json\n{"candidates":[{"key":"c1","claimKey":"claim_a","url":"https://a.example.com/p","title":"T","author":"A","summary":"S","sourceKind":"official"}]}\n```';
  const parsed = parseResearchCandidates(valid);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].sourceKind, 'official');
  assert.equal(parsed[0].excerpt, null);

  const defaultKind = parseResearchCandidates('```json\n{"candidates":[{"key":"c1","claimKey":"claim_a","url":"https://a.example.com/p"}]}\n```');
  assert.equal(defaultKind[0].sourceKind, 'secondary', '缺失声明 → 保守 secondary');

  for (const bad of [null, 'no json block', '```json\n{"candidates":"nope"}\n```', '```json\n{"candidates":[{"key":"c1","claimKey":"claim_a"}]}\n```']) {
    assert.equal(parseResearchCandidates(bad), null, '非法输入整单拒绝');
  }

  const claims = parseClaimProposals('```json\n{"claims":[{"claimKey":"claim_a","status":"supported","evidenceSourceIds":["s1","s1"],"verdictReason":"官方价页"}]}\n```');
  assert.equal(claims.length, 1);
  assert.deepEqual(claims[0].evidenceSourceIds, ['s1'], 'evidenceSourceIds 去重');
  assert.equal(parseClaimProposals('```json\n{"claims":[{"claimKey":"claim_a","status":"weird"}]}\n```'), null);
  assert.equal(parseClaimProposals('text only'), null);
});

test('WMB-5172: budget resolves to fixed hard defaults', () => {
  assert.deepEqual(resolveResearchBudget(undefined), RESEARCH_DEFAULT_BUDGET);
  assert.deepEqual(resolveResearchBudget({ timeMinutes: 5, minValidSources: 3, maxCandidates: 9, maxParallelFetches: 2, maxRounds: 1 }), { timeMinutes: 5, minValidSources: 3, maxCandidates: 9, maxParallelFetches: 2, maxRounds: 1 });
  // 非法值（非正数/NaN）逐键回落硬默认；合法下调保留。
  assert.deepEqual(resolveResearchBudget({ timeMinutes: 0, minValidSources: -1, maxCandidates: NaN, maxParallelFetches: 0, maxRounds: 0 }), RESEARCH_DEFAULT_BUDGET);
  // WMB-5173/5174：RESEARCH_DEFAULT_BUDGET 即机器硬上限——调用方上调钳制到上限（400 → 40）。
  assert.equal(resolveResearchBudget({ timeMinutes: 5, minValidSources: 3, maxCandidates: 400, maxParallelFetches: 2, maxRounds: 1 }).maxCandidates, 40);
});

test('WMB-5172: research prompts carry whitelist discipline and structured-output contract', () => {
  const text = researchToolDisciplineText();
  assert.ok(text.includes('wmb_search_web') && text.includes('wmb_read_web_page'));
  assert.ok(text.includes('wmb_save_source'));
  assert.ok(text.includes('禁止 wmb_get_workbench'));
  const gap = makeGap();
  const task = makeTask();
  const discovery = researchDiscoveryPrompt(task, gap);
  assert.ok(discovery.includes('40 候选上限') && discovery.includes('3 并行抓取') && discovery.includes('仅一轮'));
  assert.ok(discovery.includes('"candidates"') && discovery.includes('sourceKind'));
  assert.ok(discovery.includes('达到 15 条有效候选') && discovery.includes('约 8 分钟'));
  assert.ok(discovery.includes('禁止调用 wmb_save_source') && discovery.includes('禁止调用 wmb_report_agent_progress'));
  const proposal = researchProposalPrompt(task, gap, '## claim_a\n- sourceId=src-1');
  assert.ok(proposal.includes('"claims"') && proposal.includes('evidenceSourceIds'));
  assert.ok(proposal.includes('claim_a（fact）：声明 A（事实）'));
  assert.ok(proposal.includes('禁止继续检索') && proposal.includes('末条回复必须直接输出'));
});

test('WMB-5303: research prompt timeout matches the 12-minute hard budget instead of failing at five minutes', () => {
  assert.equal(resolveResearchPromptTimeoutMs(undefined), 600_000);
  assert.equal(resolveResearchPromptTimeoutMs('420000'), 420_000);
  assert.equal(resolveResearchPromptTimeoutMs('invalid'), 600_000);
  assert.equal(resolveResearchPromptTimeoutMs('29999'), 600_000);
});
test('WMB-5291: research runtime mounts the packaged deep-research skill', async () => {
  const skillPath = researchSkillSourcePath();
  const skill = await readFile(`${skillPath}/SKILL.md`, 'utf8');
  assert.match(skill, /name:\s*deep-research/);
  for (const fragment of ['先联网，后判断', '主动找反证', '搜索结果页不是证据', 'Source SSOT', 'source_unavailable']) {
    assert.ok(skill.includes(fragment), `deep-research skill 缺少合同：${fragment}`);
  }

  const args = researchPiRuntimeArgs({
    piCliPath: 'pi-cli.js',
    sessionFile: 'research.jsonl',
    extensionPath: 'wmb-extension.ts',
    model: 'research-model',
    authorityPrompt: 'authority'
  });
  const skillFlag = args.indexOf('--skill');
  assert.ok(skillFlag >= 0);
  assert.equal(args[skillFlag + 1], skillPath);
  assert.deepEqual(args.slice(args.indexOf('--provider'), args.indexOf('--provider') + 4), ['--provider', 'wmb-api', '--model', 'research-model']);
});

test('WMB-5172: canonical URL helpers', () => {
  assert.equal(evidenceDomainOf('https://www.Example.com/path'), 'example.com');
  assert.equal(canonicalUrlKey('http://Example.com/path/#frag'), canonicalUrlKey('https://example.com/path'));
  assert.notEqual(canonicalUrlKey('https://a.example.com/x'), canonicalUrlKey('https://b.example.com/x'));
});
