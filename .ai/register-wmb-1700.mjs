import fs from 'fs';

const path = 'TASKS.md';
let t = fs.readFileSync(path, 'utf8');

t = t.replace(
  `Current state:

- Active task: none; WMB-1605 done 2026-07-31
- Next eligible task: none in M-1600 X List cache slice
- Blocked tasks: none
- Completed harness tasks: \`WMB-0001\`, \`WMB-0002\`
`,
  `Current state:

- Active task: WMB-1700 (doing)
- Next eligible task: WMB-1701 after WMB-1700
- Blocked tasks: none
- Completed harness tasks: \`WMB-0001\`, \`WMB-0002\`
`,
);

const insert = `| WMB-1700 | M-1700 | CAP-002, CAP-003, CAP-014, CAP-017 | doing | WMB-1605, WMB-1115 | Official-release wire foundation: expand source-index (DeepSeek multi-channel + ByteDance/Seedance), harden Skill A-class checklist SOP, require enabled X List bindings (AI前沿) in daily intelligence queue per INTELLIGENCE_WIRE_PLAN.md | Plan file INTELLIGENCE_WIRE_PLAN.md; source-index validation; AI前沿 list_id 2082851520417255750 documented as hard W0 | Codex |
| WMB-1701 | M-1700 | CAP-002, CAP-003, CAP-014, CAP-017 | todo | WMB-1700 | Daily intelligence runner W0/W1 deterministic wire: enabled X List timeline collect + primary release source checklist before Pi B/C routes; per-source failure isolation and checkpoint fields | Focused wire test + typecheck; progress messages show AI前沿 and official source ids; OpenAI failure must not skip DeepSeek/List | Codex |
| WMB-1702 | M-1700 | CAP-002, CAP-003, CAP-017 | todo | WMB-1701 | Acceptance nails + List member governance: ensure DSV4-Flash and Seedance 2.5 enter source_items; suggest/add required official handles into AI前沿 via existing X List operation flow | DB readback for both releases (or documented single-path X fallback); members diff artifact; no duplicate URL spam on rerun | Codex |
`;

if (!t.includes('WMB-1700')) {
  t = t.replace('| WMB-1605 |', `${insert}| WMB-1605 |`);
}

fs.writeFileSync(path, t);
console.log({
  has1700: t.includes('WMB-1700'),
  active: t.includes('Active task: WMB-1700'),
});
