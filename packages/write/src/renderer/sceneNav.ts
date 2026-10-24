import type { Align } from '../shared/align';
import type { FindOptions, FindStatus } from '../shared/find';
import type { ReviewApi } from './reviewPlugin';

/** Which match to land on when a search is (re)run. */
export type FindJump = 'caret' | 'first' | 'last' | 'keep';

/** Find & Replace inside one editor (formatted or source). */
export interface FindApi {
  /** Runs the search, highlights the matches and moves to one of them. */
  search(o: FindOptions, jump: FindJump): FindStatus;
  /**
   * Moves to the next/previous match. With `wrap` false it stops (moved: false) instead of wrapping
   * past the end of the chapter, so the caller can carry on in another chapter.
   */
  step(o: FindOptions, dir: 1 | -1, wrap: boolean): FindStatus & { moved: boolean };
  /** Replaces the highlighted match (or the next one after the caret) and moves on to the following match. */
  replaceOne(o: FindOptions, replacement: string): FindStatus;
  /** Replaces every match in this chapter; returns how many. */
  replaceAll(o: FindOptions, replacement: string): number;
  /** Removes the highlights. */
  clear(): void;
  /** The selected text, if it is short and on one line (to prefill the find box). */
  selectedText(): string;
}

/** Formatting the phone's docked bar applies to the selection (the formatted editor only). */
export interface FormatApi {
  bold(): void;
  italic(): void;
  heading(level: number): void;
  quote(): void;
  bullets(): void;
  numbered(): void;
  sceneBreak(): void;
  undo(): void;
  redo(): void;
  /** Aligns the selected blocks (`null`, or the alignment they already have, removes it). */
  align(align: Align | null): void;
}

/** What an editor hands its parent: scene-break jumps and find & replace. */
export interface SceneNav {
  /** Present in the formatted editor. */
  format?: FormatApi;
  go(dir: 1 | -1): boolean;
  /** Puts the caret on file line `line` (which must be in this chapter) and scrolls it into view. */
  goToLine(line: number): boolean;
  find: FindApi;
  /** Comments and suggestions in this chapter. Only the formatted editor has it. */
  review?: ReviewApi;
}
