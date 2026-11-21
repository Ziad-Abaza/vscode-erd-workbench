import { EventEmitter } from 'events';

export interface ActiveSqlRun {
  runId: string;
  connectionId: string;
  controller: AbortController;
  startedAt: number;
}

/**
 * Tracks in-flight SQL runner executions so the Results panel / Cancel command
 * can abort the active query without bypassing SqlPolicyGate.
 */
export class SqlRunRegistry {
  private readonly runs = new Map<string, ActiveSqlRun>();
  private readonly emitter = new EventEmitter();
  private sequence = 0;

  get size(): number {
    return this.runs.size;
  }

  get activeRunIds(): string[] {
    return [...this.runs.keys()];
  }

  getLatest(): ActiveSqlRun | undefined {
    const ids = this.activeRunIds;
    if (!ids.length) {
      return undefined;
    }
    return this.runs.get(ids[ids.length - 1]);
  }

  create(connectionId: string): ActiveSqlRun {
    this.sequence += 1;
    const runId = `run_${Date.now().toString(36)}_${this.sequence}`;
    const run: ActiveSqlRun = {
      runId,
      connectionId,
      controller: new AbortController(),
      startedAt: Date.now(),
    };
    this.runs.set(runId, run);
    this.emitter.emit('change');
    return run;
  }

  get(runId: string): ActiveSqlRun | undefined {
    return this.runs.get(runId);
  }

  cancel(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run) {
      return false;
    }
    if (!run.controller.signal.aborted) {
      run.controller.abort();
    }
    this.emitter.emit('change');
    return true;
  }

  cancelLatest(): boolean {
    const latest = this.getLatest();
    if (!latest) {
      return false;
    }
    return this.cancel(latest.runId);
  }

  complete(runId: string): void {
    if (this.runs.delete(runId)) {
      this.emitter.emit('change');
    }
  }

  onDidChange(listener: () => void): { dispose: () => void } {
    this.emitter.on('change', listener);
    return {
      dispose: () => {
        this.emitter.off('change', listener);
      },
    };
  }

  dispose(): void {
    for (const run of this.runs.values()) {
      if (!run.controller.signal.aborted) {
        run.controller.abort();
      }
    }
    this.runs.clear();
    this.emitter.removeAllListeners();
  }
}
