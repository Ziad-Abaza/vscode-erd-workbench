import * as vscode from 'vscode';
import type { ErdDocument } from '../../shared/types';
import { parseDocument } from '../editor/ErdTextEditorProvider';

export interface StoredDiagramRef {
  diagramId: string;
  name: string;
  connectionId: string;
  fileName: string;
  uri: vscode.Uri;
  updatedAt: string;
}

/**
 * Stores ERD diagrams in VS Code extension storage (workspaceStorage / globalStorage),
 * never in the user's project folder — same pattern as most DB/IDE extensions.
 */
export class DiagramStorageService {
  private readonly diagramsDir: vscode.Uri;

  constructor(private readonly context: vscode.ExtensionContext) {
    // Prefer workspace-scoped storage (not visible in project / not committed).
    // Fall back to global storage when no folder workspace is open.
    const root = context.storageUri ?? context.globalStorageUri;
    this.diagramsDir = vscode.Uri.joinPath(root, 'diagrams');
  }

  get directory(): vscode.Uri {
    return this.diagramsDir;
  }

  private async ensureDir(): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.diagramsDir);
  }

  fileUriFor(doc: ErdDocument): vscode.Uri {
    const safe = sanitizeFilePart(doc.diagramId || doc.name);
    return vscode.Uri.joinPath(this.diagramsDir, `${safe}.erd.json`);
  }

  async save(doc: ErdDocument): Promise<vscode.Uri> {
    await this.ensureDir();
    const uri = this.fileUriFor(doc);
    const content = Buffer.from(JSON.stringify(doc, null, 2), 'utf8');
    await vscode.workspace.fs.writeFile(uri, content);
    return uri;
  }

  async list(): Promise<StoredDiagramRef[]> {
    await this.ensureDir();
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(this.diagramsDir);
    } catch {
      return [];
    }
    const refs: StoredDiagramRef[] = [];
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File || !name.endsWith('.erd.json')) {
        continue;
      }
      const uri = vscode.Uri.joinPath(this.diagramsDir, name);
      try {
        const raw = await vscode.workspace.fs.readFile(uri);
        const erd = parseDocument(Buffer.from(raw).toString('utf8'));
        refs.push({
          diagramId: erd.diagramId,
          name: erd.name,
          connectionId: erd.connectionId,
          fileName: name,
          uri,
          updatedAt: erd.updatedAt,
        });
      } catch {
        refs.push({
          diagramId: name,
          name,
          connectionId: '',
          fileName: name,
          uri,
          updatedAt: '',
        });
      }
    }
    return refs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async delete(uri: vscode.Uri): Promise<void> {
    await vscode.workspace.fs.delete(uri, { useTrash: false });
  }

  /**
   * Optional explicit export into the project (user-initiated only).
   */
  async exportToWorkspace(doc: ErdDocument): Promise<vscode.Uri | undefined> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!folder) {
      throw new Error('No workspace folder open to export into');
    }
    const defaultName = `${sanitizeFilePart(doc.name)}.erd.json`;
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(folder, defaultName),
      filters: { 'ERD Diagram': ['erd.json', 'json'] },
      saveLabel: 'Export Diagram',
      title: 'Export ERD (optional — diagrams are normally kept in private extension storage)',
    });
    if (!target) {
      return undefined;
    }
    await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(doc, null, 2), 'utf8'));
    return target;
  }
}

function sanitizeFilePart(value: string): string {
  return value.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || `diagram_${Date.now().toString(36)}`;
}
