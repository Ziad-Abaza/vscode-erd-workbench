#!/usr/bin/env node
/**
 * Simple CLI for agents (works while VS Code/Cursor has the extension active).
 *
 * Examples:
 *   node dist/cli.js tools
 *   node dist/cli.js invoke list_connections
 *   node dist/cli.js invoke get_page_info
 *   node dist/cli.js invoke set_page --args "{\"pageIndex\":1,\"pageSize\":40}"
 *   node dist/cli.js invoke set_table_positions --args "{\"positions\":[{\"tableId\":\"app.users\",\"x\":100,\"y\":200}]}"
 *   node dist/cli.js invoke apply_layout
 *
 * Env:
 *   ERD_BRIDGE_URL=http://127.0.0.1:3847
 */

const BASE = process.env.ERD_BRIDGE_URL ?? 'http://127.0.0.1:3847';

async function main(): Promise<void> {
  const [cmd, tool, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help') {
    printHelp();
    return;
  }

  if (cmd === 'health') {
    const res = await fetch(`${BASE}/health`);
    console.log(await res.text());
    return;
  }

  if (cmd === 'tools') {
    const res = await fetch(`${BASE}/tools`);
    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (cmd === 'invoke') {
    if (!tool) {
      throw new Error('Usage: erd-cli invoke <tool> [--args JSON]');
    }
    let args: Record<string, unknown> = {};
    const idx = rest.indexOf('--args');
    if (idx >= 0) {
      args = JSON.parse(rest[idx + 1] ?? '{}') as Record<string, unknown>;
    } else if (rest[0] && rest[0].startsWith('{')) {
      args = JSON.parse(rest[0]) as Record<string, unknown>;
    }
    const res = await fetch(`${BASE}/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool, args }),
    });
    const text = await res.text();
    if (!res.ok) {
      console.error(text);
      process.exitCode = 1;
      return;
    }
    console.log(text);
    return;
  }

  throw new Error(`Unknown command: ${cmd}`);
}

function printHelp(): void {
  console.log(`ERD Workbench Agent CLI

Requires the extension to be running (Agent Bridge on ${BASE}).

Commands:
  health
  tools
  invoke <tool> [--args '{"key":"value"}']

Diagram realtime examples:
  invoke list_diagrams
  invoke get_diagram
  invoke set_page --args "{\"pageIndex\":0,\"pageSize\":50}"
  invoke set_filters --args "{\"filters\":{\"search\":\"user\",\"pageMode\":true}}"
  invoke move_tables --args "{\"moves\":[{\"tableId\":\"db.users\",\"dx\":40,\"dy\":0}]}"
  invoke apply_layout
  invoke arrange_page_grid
  invoke focus_neighborhood --args "{\"tableId\":\"db.users\",\"hops\":1}"
`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  console.error('\nIs ERD Workbench open in VS Code/Cursor with Agent Bridge enabled?');
  process.exitCode = 1;
});
