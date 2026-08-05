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
- installation-owned BrowserProfile registry with an explicit root binding;
- official MCP TypeScript SDK over loopback Streamable HTTP;
- Electron Forge packaging.

## Entry points and directory map

The application is implemented. Authoritative entry points are `src/main/index.ts`, `src/preload/preload.ts` and `src/renderer/index.tsx`; packaging is defined by Electron Forge and Vite configuration in the repository root.

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

This is an Electron modular monolith. Do not add another service, database or top-level architecture unless a current SPEC requirement proves it necessary.

## Request flow

```text
React UI ── IPC ──┐
Built-in Pi ─ MCP ┼─ Command dispatcher ─ Domain commands ─ SQLite / files / jobs / browser
External Agent ─ MCP ┘
```

IPC, Pi MCP, external MCP, scheduler and browser adapters are transport/execution adapters. Target behavior requires all mutations to use `CommandEnvelopeV1` through one active-root dispatcher; they do not write SQLite directly. The approved migration design is `docs/architecture/workspace-ai-collaboration-architecture.md`. `TECHNICAL_DESIGN.md` and SPEC CAP-025 remain normative if this short context diverges.

## Integration boundaries

- Renderer ↔ main: narrow `contextBridge` API.
- Agent ↔ WMB: loopback Streamable HTTP MCP.
- WMB ↔ platforms: visible Chrome/Chromium from the active root's explicit BrowserProfile binding, controlled through Playwright CDP.
- Database ↔ assets: SQLite stores relative paths and metadata; files remain under the configured data root.

## Current migration boundary

- `InstallationContext` owns executables, pinned runtime/model presets, shared Skills and BrowserProfile registry/default.
- The active data root owns business facts, tasks/sessions, grants, account snapshots, bindings and receipts.
- `ActiveWorkspaceRuntime` is the only live-root owner; bounded Pi workers are leases, not additional authorities.
- Owner UI actions issue product-defined grants; chat/session text is neither grant nor business truth.
- Final platform publication remains a manual user action.

Current code is being migrated under WMB-4801–WMB-4809. Existing direct routes are historical implementation facts, not permission to weaken CAP-025 or add another compatibility write path.
