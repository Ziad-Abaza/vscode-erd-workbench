/**
 * Optional stdio MCP-style JSON-RPC loop for external agents.
 * Shares tool names with McpToolHost; in-extension activation wires the real host.
 *
 * Usage (after packaging host separately): node dist/mcpStdio.js
 * This stub documents the wire protocol; Extension Host commands are the primary surface.
 */
import * as readline from 'readline';

type RpcReq = { id?: string | number; method: string; params?: Record<string, unknown> };

const tools = [
  'list_connections',
  'get_schema_summary',
  'list_tables',
  'get_table',
  'get_relationships',
  'search_schema',
  'diff_schema',
  'export_schema',
  'propose_create_table',
  'propose_alter_table',
  'propose_drop_table',
  'propose_create_relationship',
  'propose_drop_relationship',
  'request_approval',
  'execute_proposal',
];

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.on('line', (line) => {
  let req: RpcReq;
  try {
    req = JSON.parse(line) as RpcReq;
  } catch {
    process.stdout.write(JSON.stringify({ error: 'invalid json' }) + '\n');
    return;
  }
  if (req.method === 'tools/list') {
    process.stdout.write(
      JSON.stringify({
        id: req.id,
        result: tools.map((name) => ({ name })),
      }) + '\n'
    );
    return;
  }
  process.stdout.write(
    JSON.stringify({
      id: req.id,
      error: {
        message:
          'Standalone stdio server requires Extension Host bridge. Use command erdWorkbench.mcp.invoke inside VS Code.',
      },
    }) + '\n'
  );
});
