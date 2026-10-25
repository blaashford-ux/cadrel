import type { DirNode } from '../src/shared/api';
import { scanFolder as scan } from '../src/shared/backend/scan';
import { nodeFs } from './nodeFs';

export const scanFolder = (dir: string): Promise<DirNode> => scan(nodeFs, dir);
