import * as vscode from 'vscode';
import {
  ERD_FORMAT_VERSION,
  type DiagramFilters,
  type DiagramGroup,
  type DiagramNodeLayout,
  type ErdDocument,
} from '../../shared/types';
import { layoutSubgraph } from './layout';
import { parseDocument } from '../editor/ErdTextEditorProvider';
import { computePageInfo, pageNodes, type PageInfo } from './paging';
import type { DiagramStorageService } from './DiagramStorageService';

export type { PageInfo };
export { computePageInfo, pageNodes } from './paging';

/**
 * Real-time diagram mutations for agents/CLI.
 * Writes go through TextDocument edits so open Custom Text Editors update live
 * (dirty state + undo/redo preserved).
 */
export class DiagramRealtimeService {
  constructor(private readonly storage?: DiagramStorageService) {}

  async listOpenDiagrams(): Promise<Array<{ uri: string; diagramId: string; name: string; nodes: number; stored?: boolean }>> {
    const out: Array<{ uri: string; diagramId: string; name: string; nodes: number; stored?: boolean }> = [];
    const open = vscode.workspace.textDocuments.filter((d) => d.fileName.endsWith('.erd.json'));
    for (const d of open) {
      try {
        const erd = parseDocument(d.getText());
        out.push({
          uri: d.uri.toString(),
          diagramId: erd.diagramId,
          name: erd.name,
          nodes: erd.nodes.length,
          stored: this.isPrivateStorageUri(d.uri),
        });
      } catch {
        /* skip invalid */
      }
    }
    if (this.storage && !out.length) {
      const stored = await this.storage.list();
      for (const s of stored) {
        out.push({
          uri: s.uri.toString(),
          diagramId: s.diagramId,
          name: s.name,
          nodes: 0,
          stored: true,
        });
      }
    }
    return out;
  }

  async getActiveOrUri(uri?: string): Promise<{ document: vscode.TextDocument; erd: ErdDocument }> {
    const doc = uri
      ? await vscode.workspace.openTextDocument(vscode.Uri.parse(uri))
      : vscode.workspace.textDocuments.find((d) => d.fileName.endsWith('.erd.json')) ??
        (await this.findStoredDiagram());
    if (!doc) {
      throw new Error('No open diagram. Reverse engineer or open a saved diagram from the sidebar.');
    }
    return { document: doc, erd: parseDocument(doc.getText()) };
  }

  private isPrivateStorageUri(uri: vscode.Uri): boolean {
    if (!this.storage) {
      return false;
    }
    return uri.fsPath.startsWith(this.storage.directory.fsPath);
  }

  async getDiagram(uri?: string): Promise<ErdDocument> {
    const { erd } = await this.getActiveOrUri(uri);
    return erd;
  }

  async writeErd(document: vscode.TextDocument, erd: ErdDocument): Promise<ErdDocument> {
    if (erd.erdFormatVersion !== ERD_FORMAT_VERSION) {
      throw new Error(`Unsupported erdFormatVersion: ${erd.erdFormatVersion}`);
    }
    const next = { ...erd, updatedAt: new Date().toISOString() };
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), JSON.stringify(next, null, 2));
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) {
      throw new Error('Failed to apply live diagram edit');
    }
    return next;
  }

  async setFilters(patch: Partial<DiagramFilters>, uri?: string): Promise<ErdDocument> {
    const { document, erd } = await this.getActiveOrUri(uri);
    return this.writeErd(document, {
      ...erd,
      filters: { ...erd.filters, ...patch },
    });
  }

  async setTablePositions(
    positions: Array<{ tableId: string; x: number; y: number; pinned?: boolean }>,
    uri?: string
  ): Promise<ErdDocument> {
    const { document, erd } = await this.getActiveOrUri(uri);
    const map = new Map(positions.map((p) => [p.tableId, p]));
    const nodes = erd.nodes.map((n) => {
      const p = map.get(n.tableId);
      if (!p) {
        return n;
      }
      return {
        ...n,
        x: p.x,
        y: p.y,
        pinned: p.pinned ?? n.pinned,
      };
    });
    return this.writeErd(document, { ...erd, nodes });
  }

  async moveTables(
    moves: Array<{ tableId: string; dx?: number; dy?: number; x?: number; y?: number }>,
    uri?: string
  ): Promise<ErdDocument> {
    const { document, erd } = await this.getActiveOrUri(uri);
    const map = new Map(moves.map((m) => [m.tableId, m]));
    const nodes = erd.nodes.map((n) => {
      const m = map.get(n.tableId);
      if (!m) {
        return n;
      }
      return {
        ...n,
        x: m.x !== undefined ? m.x : n.x + (m.dx ?? 0),
        y: m.y !== undefined ? m.y : n.y + (m.dy ?? 0),
      };
    });
    return this.writeErd(document, { ...erd, nodes });
  }

  async applyLayout(tableIds?: string[], uri?: string): Promise<ErdDocument> {
    const { document, erd } = await this.getActiveOrUri(uri);
    const cap = vscode.workspace.getConfiguration('erdWorkbench').get<number>('autoLayoutNodeCap', 300);
    let selected = tableIds?.length
      ? erd.nodes.filter((n) => tableIds.includes(n.tableId))
      : pageNodes(erd);
    if (!selected.length) {
      selected = erd.nodes.filter((n) => !n.pinned).slice(0, cap);
    }
    if (selected.length > cap) {
      selected = selected.slice(0, cap);
    }
    const idSet = new Set(selected.map((n) => n.tableId));
    const edges = erd.edges.filter((e) => idSet.has(e.sourceTableId) && idSet.has(e.targetTableId) && !e.hidden);
    const laidOut = await layoutSubgraph(selected, edges);
    const map = new Map(laidOut.map((n) => [n.tableId, n]));
    const nodes = erd.nodes.map((n) => map.get(n.tableId) ?? n);
    return this.writeErd(document, { ...erd, nodes });
  }

  async createGroup(
    name: string,
    tableIds: string[],
    uri?: string
  ): Promise<ErdDocument> {
    const { document, erd } = await this.getActiveOrUri(uri);
    const group: DiagramGroup = {
      id: `grp_${Date.now().toString(36)}`,
      name,
      collapsed: false,
    };
    const idSet = new Set(tableIds);
    const nodes = erd.nodes.map((n) => (idSet.has(n.tableId) ? { ...n, groupId: group.id } : n));
    return this.writeErd(document, {
      ...erd,
      groups: [...erd.groups, group],
      nodes,
    });
  }

  async setViewport(viewport: { x: number; y: number; zoom: number }, uri?: string): Promise<ErdDocument> {
    const { document, erd } = await this.getActiveOrUri(uri);
    return this.writeErd(document, { ...erd, viewport });
  }

  async focusNeighborhood(tableId: string, hops = 1, uri?: string): Promise<ErdDocument> {
    const { document, erd } = await this.getActiveOrUri(uri);
    const keep = new Set<string>([tableId]);
    for (let h = 0; h < hops; h++) {
      for (const e of erd.edges) {
        if (e.hidden) {
          continue;
        }
        if (keep.has(e.sourceTableId)) {
          keep.add(e.targetTableId);
        }
        if (keep.has(e.targetTableId)) {
          keep.add(e.sourceTableId);
        }
      }
    }
    return this.writeErd(document, {
      ...erd,
      filters: {
        ...erd.filters,
        search: '',
        pageMode: true,
        pageIndex: 0,
        pageSize: Math.max(keep.size, 10),
        groupIds: ['__focus__'],
      },
      groups: [
        ...erd.groups.filter((g) => g.id !== '__focus__'),
        { id: '__focus__', name: `Focus ${tableId}`, collapsed: false },
      ],
      nodes: erd.nodes.map((n) =>
        keep.has(n.tableId)
          ? { ...n, groupId: '__focus__' }
          : { ...n, groupId: n.groupId === '__focus__' ? undefined : n.groupId }
      ),
    });
  }

  getPageInfo(erd: ErdDocument): PageInfo {
    return computePageInfo(erd);
  }

  async setPage(pageIndex: number, pageSize?: number, uri?: string): Promise<{ erd: ErdDocument; page: PageInfo }> {
    const { document, erd } = await this.getActiveOrUri(uri);
    const size = pageSize ?? erd.filters.pageSize ?? 50;
    const next = await this.writeErd(document, {
      ...erd,
      filters: {
        ...erd.filters,
        pageMode: true,
        pageIndex: Math.max(0, pageIndex),
        pageSize: Math.max(10, size),
      },
    });
    return { erd: next, page: computePageInfo(next) };
  }

  async arrangePageGrid(uri?: string): Promise<ErdDocument> {
    const { document, erd } = await this.getActiveOrUri(uri);
    const visible = pageNodes(erd);
    const cols = Math.max(1, Math.ceil(Math.sqrt(visible.length * 1.15)));
    const gapX = 236;
    const gapY = 132;
    const map = new Map<string, DiagramNodeLayout>();
    visible.forEach((n, i) => {
      map.set(n.tableId, {
        ...n,
        x: (i % cols) * gapX,
        y: Math.floor(i / cols) * gapY,
      });
    });
    const nodes = erd.nodes.map((n) => map.get(n.tableId) ?? n);
    return this.writeErd(document, { ...erd, nodes });
  }

  private async findStoredDiagram(): Promise<vscode.TextDocument | undefined> {
    if (!this.storage) {
      return undefined;
    }
    const list = await this.storage.list();
    if (!list.length) {
      return undefined;
    }
    return vscode.workspace.openTextDocument(list[0].uri);
  }
}
