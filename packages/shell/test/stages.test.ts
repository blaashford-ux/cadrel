import { describe, expect, it } from 'vitest';
import { MDEDIT_STAGES } from '@cadrel/kernel';
import { STATUSES, STATUS_LABELS } from '@cadrel/write/src/shared/projects';

// The default workflow is MDEdit's own list. If Write's statuses ever change, the shipped default must be changed with them, on purpose.
describe('the default workflow and Write’s statuses', () => {
  it('are the same stages, in the same order, with the same names', () => {
    expect(MDEDIT_STAGES.map((s) => s.key)).toEqual([...STATUSES]);
    expect(MDEDIT_STAGES.map((s) => s.name)).toEqual(STATUSES.map((k) => STATUS_LABELS[k]));
  });
});
