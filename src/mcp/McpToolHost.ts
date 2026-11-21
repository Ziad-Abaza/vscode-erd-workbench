import * as vscode from 'vscode';
import type { MutationPlan } from '../../shared/types';
import { ConnectionManager } from '../connection/ConnectionManager';
import { SchemaCatalogService } from '../schema/SchemaCatalogService';
import { SchemaDiffService } from '../schema/SchemaDiffService';
import { MutationPipeline } from '../mutation/MutationPipeline';
import { ApprovalStore } from '../mutation/ApprovalStore';
import { exportDbml, exportSqlDdl, exportJsonPackage } from '../engineering/ImportExport';
import { DiagramRealtimeService } from '../diagram/DiagramRealtimeService';

export type McpToolTier = 'read' | 'propose' | 'execute' | 'diagram';

export interface McpToolDefinition {
  name: string;
  tier: McpToolTier;
  description: string;
}

/**
 * Tool surface for AI agents / CLI.
 * - read / diagram: immediate
 * - propose: no DB write
 * - execute: requires host approval token for SQL
 * Diagram layout ops are real-time and do not require SQL approval.
 */
export class McpToolHost {
  constructor(
    private readonly connections: ConnectionManager,
    private readonly catalog: SchemaCatalogService,
    private readonly diff: SchemaDiffService,
    private readonly mutations: MutationPipeline,
    private readonly approvals: ApprovalStore,
    private readonly diagrams: DiagramRealtimeService
  ) {}

  listTools(): McpToolDefinition[] {
    return [
      { name: 'list_connections', tier: 'read', description: 'List saved connection profiles' },
      { name: 'connect', tier: 'read', description: 'Connect by connectionId (uses stored password)' },
      { name: 'get_schema_summary', tier: 'read', description: 'Summarize schemas/tables for a connection' },
      { name: 'list_tables', tier: 'read', description: 'List tables/views (supports limit/offset page)' },
      { name: 'get_table', tier: 'read', description: 'Get full table metadata' },
      { name: 'get_relationships', tier: 'read', description: 'List physical foreign keys' },
      { name: 'search_schema', tier: 'read', description: 'Search tables by name' },
      { name: 'diff_schema', tier: 'read', description: 'Diff catalog snapshots' },
      { name: 'export_schema', tier: 'read', description: 'Export schema as json|sql|dbml' },

      { name: 'list_diagrams', tier: 'diagram', description: 'List open .erd.json diagrams' },
      { name: 'get_diagram', tier: 'diagram', description: 'Get active/open diagram document' },
      { name: 'get_page_info', tier: 'diagram', description: 'Large-schema page info for current filters' },
      { name: 'set_page', tier: 'diagram', description: 'Show pageIndex of tables (pageSize default 50) — live' },
      { name: 'set_filters', tier: 'diagram', description: 'Update diagram filters live (search/schemas/pageMode)' },
      { name: 'set_table_positions', tier: 'diagram', description: 'Set absolute x/y for tables — live realtime' },
      { name: 'move_tables', tier: 'diagram', description: 'Move tables by dx/dy or absolute — live' },
      { name: 'apply_layout', tier: 'diagram', description: 'Auto-layout selection or current page — live' },
      { name: 'arrange_page_grid', tier: 'diagram', description: 'Grid-arrange current page — live' },
      { name: 'create_group', tier: 'diagram', description: 'Group tables under a named group — live' },
      { name: 'focus_neighborhood', tier: 'diagram', description: 'Focus N-hop neighborhood around a table — live' },
      { name: 'set_viewport', tier: 'diagram', description: 'Set canvas viewport x/y/zoom — live' },

      { name: 'propose_create_table', tier: 'propose', description: 'Propose CREATE TABLE SQL (no execution)' },
      { name: 'propose_alter_table', tier: 'propose', description: 'Propose ALTER TABLE SQL (no execution)' },
      { name: 'propose_drop_table', tier: 'propose', description: 'Propose DROP TABLE SQL (no execution)' },
      { name: 'propose_create_relationship', tier: 'propose', description: 'Propose FK / N:M SQL (no execution)' },
      { name: 'propose_drop_relationship', tier: 'propose', description: 'Propose DROP FOREIGN KEY SQL (no execution)' },
      { name: 'execute_proposal', tier: 'execute', description: 'Execute approved proposal with approvalToken' },
      { name: 'request_approval', tier: 'execute', description: 'Host UI approve proposal → approvalToken' },
    ];
  }

  async invoke(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'list_connections':
        return this.connections.listProfiles().map((p) => ({
          id: p.id,
          name: p.name,
          host: p.host,
          port: p.port,
          connected: this.connections.isConnected(p.id),
        }));
      case 'connect': {
        const connectionId = str(args.connectionId);
        await this.connections.connect(connectionId);
        await this.catalog.refresh(connectionId, { full: false });
        return { ok: true, connectionId };
      }
      case 'get_schema_summary': {
        const connectionId = str(args.connectionId);
        const cat = this.catalog.getCatalog(connectionId);
        if (!cat) {
          return { error: 'Catalog not loaded; refresh/connect first' };
        }
        return {
          schemas: cat.schemas,
          tableCount: cat.tables.length,
          syncStatus: cat.syncStatus,
          fetchedAt: cat.fetchedAt,
        };
      }
      case 'list_tables': {
        const connectionId = str(args.connectionId);
        const all = this.catalog.getSummaries(connectionId);
        const offset = Number(args.offset ?? 0);
        const limit = Number(args.limit ?? all.length);
        return {
          total: all.length,
          offset,
          limit,
          tables: all.slice(offset, offset + limit),
        };
      }
      case 'get_table': {
        const connectionId = str(args.connectionId);
        const id = str(args.tableId);
        return this.catalog.getTable(connectionId, id) ?? { error: 'Not found' };
      }
      case 'get_relationships': {
        const connectionId = str(args.connectionId);
        const cat = this.catalog.getCatalog(connectionId);
        return (cat?.tables ?? []).flatMap((t) => t.foreignKeys ?? []);
      }
      case 'search_schema': {
        const connectionId = str(args.connectionId);
        return this.catalog.search(connectionId, str(args.query ?? ''), Number(args.limit ?? 100));
      }
      case 'diff_schema': {
        const connectionId = str(args.connectionId);
        const cat = this.catalog.getCatalog(connectionId);
        if (!cat) {
          return { error: 'No catalog' };
        }
        const before = (args.beforeTables as typeof cat.tables) ?? [];
        return this.diff.diffCatalogs(connectionId, before, cat.tables);
      }
      case 'export_schema': {
        const connectionId = str(args.connectionId);
        const format = str(args.format ?? 'json') as 'json' | 'sql' | 'dbml';
        const cat = this.catalog.getCatalog(connectionId);
        if (!cat) {
          return { error: 'No catalog' };
        }
        if (format === 'sql') {
          return { format, content: exportSqlDdl(cat.tables) };
        }
        if (format === 'dbml') {
          return { format, content: exportDbml(cat.tables) };
        }
        return { format, content: exportJsonPackage(cat) };
      }

      // ——— Realtime diagram ops ———
      case 'list_diagrams':
        return this.diagrams.listOpenDiagrams();
      case 'get_diagram': {
        const erd = await this.diagrams.getDiagram(optStr(args.uri));
        return { erd, page: this.diagrams.getPageInfo(erd) };
      }
      case 'get_page_info': {
        const erd = await this.diagrams.getDiagram(optStr(args.uri));
        return this.diagrams.getPageInfo(erd);
      }
      case 'set_page': {
        const pageIndex = Number(args.pageIndex ?? 0);
        const pageSize = args.pageSize !== undefined ? Number(args.pageSize) : undefined;
        return this.diagrams.setPage(pageIndex, pageSize, optStr(args.uri));
      }
      case 'set_filters': {
        const erd = await this.diagrams.setFilters(
          (args.filters ?? args) as Record<string, unknown> as never,
          optStr(args.uri)
        );
        return { erd, page: this.diagrams.getPageInfo(erd) };
      }
      case 'set_table_positions': {
        const positions = args.positions as Array<{ tableId: string; x: number; y: number; pinned?: boolean }>;
        if (!Array.isArray(positions)) {
          throw new Error('positions[] required');
        }
        const erd = await this.diagrams.setTablePositions(positions, optStr(args.uri));
        return { ok: true, updated: positions.length, updatedAt: erd.updatedAt };
      }
      case 'move_tables': {
        const moves = args.moves as Array<{ tableId: string; dx?: number; dy?: number; x?: number; y?: number }>;
        if (!Array.isArray(moves)) {
          throw new Error('moves[] required');
        }
        const erd = await this.diagrams.moveTables(moves, optStr(args.uri));
        return { ok: true, updated: moves.length, updatedAt: erd.updatedAt };
      }
      case 'apply_layout': {
        const tableIds = Array.isArray(args.tableIds) ? (args.tableIds as string[]) : undefined;
        const erd = await this.diagrams.applyLayout(tableIds, optStr(args.uri));
        return { ok: true, updatedAt: erd.updatedAt, page: this.diagrams.getPageInfo(erd) };
      }
      case 'arrange_page_grid': {
        const erd = await this.diagrams.arrangePageGrid(optStr(args.uri));
        return { ok: true, updatedAt: erd.updatedAt, page: this.diagrams.getPageInfo(erd) };
      }
      case 'create_group': {
        const name = str(args.name);
        const tableIds = args.tableIds as string[];
        if (!Array.isArray(tableIds)) {
          throw new Error('tableIds[] required');
        }
        const erd = await this.diagrams.createGroup(name, tableIds, optStr(args.uri));
        return { ok: true, groups: erd.groups };
      }
      case 'focus_neighborhood': {
        const erd = await this.diagrams.focusNeighborhood(
          str(args.tableId),
          Number(args.hops ?? 1),
          optStr(args.uri)
        );
        return { ok: true, page: this.diagrams.getPageInfo(erd) };
      }
      case 'set_viewport': {
        const erd = await this.diagrams.setViewport(
          {
            x: Number(args.x ?? 0),
            y: Number(args.y ?? 0),
            zoom: Number(args.zoom ?? 1),
          },
          optStr(args.uri)
        );
        return { ok: true, viewport: erd.viewport };
      }

      case 'propose_create_table':
      case 'propose_alter_table':
      case 'propose_drop_table':
      case 'propose_create_relationship':
      case 'propose_drop_relationship': {
        const plan = this.mutations.propose({
          connectionId: str(args.connectionId),
          title: str(args.title ?? name),
          intent: str(args.intent ?? name),
          sql: str(args.sql),
        });
        return { ...plan };
      }
      case 'request_approval': {
        const proposalId = str(args.proposalId);
        const plan = this.mutations.getProposal(proposalId);
        if (!plan) {
          return { error: 'Unknown proposal' };
        }
        const token = await this.mutations.confirmWithUser(plan);
        if (!token) {
          return { approved: false };
        }
        return { approved: true, approvalToken: token, proposalId };
      }
      case 'execute_proposal': {
        const proposalId = str(args.proposalId);
        const approvalToken = str(args.approvalToken);
        if (args.userApproved) {
          throw new Error('Client-asserted userApproved is ignored; host approvalToken required');
        }
        await this.mutations.executeApproved(proposalId, approvalToken);
        return { ok: true, proposalId };
      }
      default:
        throw new Error(`Unknown MCP tool: ${name}`);
    }
  }

  async showToolsQuickPick(): Promise<void> {
    const tools = this.listTools();
    const picked = await vscode.window.showQuickPick(
      tools.map((t) => ({
        label: t.name,
        description: t.tier,
        detail: t.description,
      })),
      { title: 'ERD Workbench Agent Tools' }
    );
    if (picked) {
      void vscode.window.showInformationMessage(`${picked.label} [${picked.description}]: ${picked.detail}`);
    }
  }
}

function str(v: unknown): string {
  if (typeof v !== 'string' || !v) {
    throw new Error('Expected string argument');
  }
  return v;
}

function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}
