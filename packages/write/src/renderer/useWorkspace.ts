import { useSyncExternalStore } from 'react';
import type { Workspace, WorkspaceState } from './workspace';

export function useWorkspace(ws: Workspace): WorkspaceState {
  return useSyncExternalStore(ws.subscribe, ws.getState);
}
