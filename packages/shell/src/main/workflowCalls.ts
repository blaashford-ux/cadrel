/** The workflow builder's changes, routed: those that only touch the records go to the people host, those that also touch projects to `ProjectStages`. Nothing else is reachable. */
import type { PeopleHost } from './people';
import type { ProjectStages } from './stages';

export const WORKFLOW_CALL_NAMES = ['create', 'setDefault', 'save', 'delete'] as const;

export async function callWorkflow(name: string, args: unknown[], host: PeopleHost, stages: ProjectStages): Promise<unknown> {
  if (!(WORKFLOW_CALL_NAMES as readonly string[]).includes(name)) throw new Error('That is not something the workflow builder can do.'); // no inherited names: it is a list, not an object
  if (name === 'save') return stages.saveWorkflow(String(args[0]), args[1] as Parameters<ProjectStages['saveWorkflow']>[1]);
  if (name === 'delete') return stages.deleteWorkflow(String(args[0]));
  return host.workflowCall(name, ...args);
}
