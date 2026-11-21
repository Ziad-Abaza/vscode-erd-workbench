import type { SqlResultsHostMessage, SqlResultsWebviewMessage } from '../../shared/types';

interface VsCodeApi {
  postMessage(message: SqlResultsWebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscodeApi = acquireVsCodeApi();

export function post(message: SqlResultsWebviewMessage): void {
  vscodeApi.postMessage(message);
}

export type HostMessageHandler = (msg: SqlResultsHostMessage) => void;
