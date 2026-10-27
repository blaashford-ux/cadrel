import type { ProjectStage } from '../shared/projects';

/** The project's stage in the host's workflow (read-only here: Cadrel moves projects between stages). */
export function StageChip({ stage }: { stage: ProjectStage }) {
  return (
    <span className="status-chip" style={{ background: `color-mix(in srgb, ${stage.color} 18%, transparent)`, color: stage.color }} title="Set in Cadrel">
      {stage.name}
    </span>
  );
}
