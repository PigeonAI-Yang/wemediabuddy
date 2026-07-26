# Architecture Context

## Stack and runtime

Project facts from `TECHNICAL_DESIGN.md`:

- Windows desktop application;
- Electron modular monolith;
- TypeScript;
- React + Vite renderer;
- Electron main process for business commands;
- Node.js `node:sqlite`;
- Playwright over CDP;
- independent Chrome/Chromium profile;
- official MCP TypeScript SDK over loopback Streamable HTTP;
- Electron Forge packaging.

## Entry points

No application manifest or source entrypoint exists yet. `PLAN.md` and `TASKS.md` define the scaffold task that will establish them.

## Planned directory map

This is a recommendation until the scaffold task creates it:

```text
src/
├─ main/
│  ├─ domains/
│  ├─ browser/
│  ├─ mcp/
│  ├─ db/
│  └─ index.ts
├─ preload/
└─ renderer/
tests/
scripts/
```

Do not add more top-level architecture unless a SPEC requirement needs it.

## Request flow

```text
React UI ── IPC ──┐
                  ├─ Business commands ── SQLite / files / jobs / browser
External Agent ─ MCP ┘
```

IPC and MCP are transport adapters. They call the same business commands and do not access SQLite or CDP directly.

## Integration boundaries

- Renderer ↔ main: narrow `contextBridge` API.
- Agent ↔ WMB: loopback Streamable HTTP MCP.
- WMB ↔ platforms: visible dedicated Chrome controlled through Playwright CDP.
- Database ↔ assets: SQLite stores relative paths and metadata; files remain under the configured data root.

## Known unknowns

- Exact installed Chrome path and version on target machines.
- Exact live DOM and creator-metric labels for the user's X, Xiaohongshu, and WeChat accounts.
- Package manager and exact package versions until scaffold.

These are implementation-time observations, not permission to weaken SPEC behavior.

