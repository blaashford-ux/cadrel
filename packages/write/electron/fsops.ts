import { makeFsops } from '../src/shared/backend/fsops';
import { nodeFs } from './nodeFs';

export const { createFile, createFolder, renameNode } = makeFsops(nodeFs);
