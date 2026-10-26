import { MemoryFs } from './memoryFs';
import { fsPortSuite } from './fsPortSuite';

fsPortSuite('in-memory', async () => {
  const fs = new MemoryFs();
  await fs.mkdir('/root', { recursive: true });
  return { fs, root: '/root', join: (...p) => p.join('/') };
});
