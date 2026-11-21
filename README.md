---
noteId: "4b086fa0e5c811f184baf5bdcbe2c6ad"
tags: []

---

# ERD Workbench

Production-oriented VS Code extension for **MySQL** and **MariaDB**: connections, schema explorer, SQL execution with a fail-closed policy gate, reverse-engineered interactive ERD (React Flow), layout-preserving schema sync, and three-tier MCP tools.

## Features

- Connection profiles with **SecretStorage** passwords, SSL modes (`disable` → `verify-identity`), reconnect
- Lazy schema explorer (databases → tables/views → columns / indexes / composite FKs)
- SQL runner with **parser-based** risk classification (`node-sql-parser`); destructive ops always confirmed in the Extension Host
- Reverse engineer → `*.erd.json` **Custom Text Editor** (dirty state, save, undo/redo via text document edits, hot exit)
- Interactive ERD: drag tables, filters, inferred/visual/physical edges, auto-layout (ELK) on selection, viewport culling for large schemas
- Relationship draw is **visual-only by default**; physical FK / N:M junction requires SQL preview + confirm
- Schema Diff, export JSON / SQL / DBML
- MCP tools: **read** / **propose** / **execute** with content-bound, single-use approval tokens

## Install from VSIX

```bash
npm install
npm run package
```

This creates `erd-workbench-0.1.0.vsix` in the project root.

**VS Code**
1. `Ctrl+Shift+P` → **Extensions: Install from VSIX...**
2. Select `erd-workbench-0.1.0.vsix`
3. Reload the window if prompted

Or from a terminal:

```bash
code --install-extension .\erd-workbench-0.1.0.vsix
```

**Cursor**

```bash
cursor --install-extension .\erd-workbench-0.1.0.vsix
```

After install, open the **ERD Workbench** activity-bar icon or run **ERD Workbench: Add Connection**.

## Develop

```bash
npm install
npm run build
npm test
```

Press **F5** (`Run ERD Workbench Extension`) to launch an Extension Development Host.

## Typical workflow

1. **ERD Workbench: Add Connection** → Connect
2. Refresh catalog / expand explorer
3. **Reverse Engineer Schema to Diagram**
4. Arrange tables, filter, auto-layout selection
5. Open a `.sql` file → **Execute SQL** (destructive statements prompt for confirmation)
6. **Schema Diff** / **Export Schema** as needed

## Agents / CLI (realtime diagram control)

While the extension is open, a localhost **Agent Bridge** starts on `http://127.0.0.1:3847`.

```bash
npm run build
node dist/cli.js tools
node dist/cli.js invoke list_diagrams
node dist/cli.js invoke set_page --args "{\"pageIndex\":0,\"pageSize\":50}"
node dist/cli.js invoke move_tables --args "{\"moves\":[{\"tableId\":\"db.users\",\"dx\":80,\"dy\":0}]}"
node dist/cli.js invoke apply_layout
node dist/cli.js invoke arrange_page_grid
```

Inside VS Code / Cursor agents can also call:

```text
erdWorkbench.mcp.invoke
```

**Realtime (no SQL approval):** `set_table_positions`, `move_tables`, `apply_layout`, `set_page`, `set_filters`, `create_group`, `focus_neighborhood`, `set_viewport`

**SQL changes:** `propose_*` → `request_approval` → `execute_proposal` (human confirm required)

### Large schemas

Enable **Pages** in the ERD toolbar (or `set_page` / `pageMode`) to browse 50 tables at a time, then auto-layout only the current page.

## MCP / AI

```text
erdWorkbench.mcp.listTools
erdWorkbench.mcp.invoke
ERD Workbench: Agent Bridge Status
```

Execute path: `propose_*` → `request_approval` (host modal) → `execute_proposal(proposalId, approvalToken)`.  
Client-asserted `userApproved: true` is rejected.

## Security model

| Path | Enforcement |
|------|-------------|
| Webview | UI only; no DB access |
| SQL runner | `SqlPolicyGate` + confirm |
| Mutations | `MutationPipeline` preview + confirm |
| MCP writes | Approval token bound to exact SQL; no unattended destructive |

Unparseable / unknown SQL **fail closed** (denied).

## Large schemas

Catalog paging, compact summaries, column hydration on focus, viewport mounting cap (~300 nodes), LOD, search/filter/groups. Auto-layout runs only on filtered subgraphs (configurable cap).

## Settings

See `erdWorkbench.*` in VS Code settings (page size, layout cap, write confirmation, SSL default, inferred relationships, etc.).

## Tests

- `test/sql-policy` — parser / fail-closed cases
- `test/mutation` — approval token binding
- `test/schema` — content hashes
- `test/large-schema` — 1000-table synthetic graph build
