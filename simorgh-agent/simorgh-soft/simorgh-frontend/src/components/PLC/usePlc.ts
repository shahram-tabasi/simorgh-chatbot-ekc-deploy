// src/components/PLC/usePlc.ts
//
// The program, read out of the project and written back into it.
//
// One hook rather than a store, because the program is not a separate document
// — it is a field of the project, and the project already knows how to save
// itself, keep a history and refuse an edit on a locked revision. A second
// store beside it would be a second thing to save and a second thing to get
// out of step.
//
// The two rules that make it behave:
//
//   * **Read once per change.** `readPlcProject` builds a new object every
//     time it runs, so calling it during render would hand every child a new
//     project on every keystroke anywhere in the app. It is memoised on the
//     raw field, which changes only when the program does.
//
//   * **Write whole.** Every edit is a function from the program to the next
//     program, applied in one patch. Half an edit — a block added here and the
//     tree updated there — is how two views end up disagreeing about what
//     exists.

import { useCallback, useMemo } from 'react';
import { useProject } from '../../context/ProjectContext';
import {
  PlcBlock, PlcProject, newPlcProject, readPlcProject,
} from '../../utils/plc/model';

export interface PlcHandle {
  project: PlcProject;
  /** True while the open revision may be changed at all. */
  editable: boolean;
  /** Replace the whole program. */
  setProject: (next: PlcProject | ((prev: PlcProject) => PlcProject)) => void;
  /** Change one block, by id. The block's `changedAt` is stamped for you. */
  patchBlock: (id: string, patch: Partial<PlcBlock> | ((b: PlcBlock) => Partial<PlcBlock>)) => void;
  /** Whether this project has ever had a program. */
  started: boolean;
}

export function usePlc(): PlcHandle {
  const { projectData, patchProjectData, isCurrentRevisionEditable } = useProject();

  const raw = projectData.plc;
  const started = raw !== undefined && raw !== null;

  const project = useMemo<PlcProject>(
    () => (started ? readPlcProject(raw) : newPlcProject()),
    [raw, started],
  );

  const setProject = useCallback((
    next: PlcProject | ((prev: PlcProject) => PlcProject),
  ) => {
    patchProjectData(prev => {
      const before = prev.plc === undefined || prev.plc === null
        ? newPlcProject() : readPlcProject(prev.plc);
      const after = typeof next === 'function' ? next(before) : next;
      return { plc: { ...after, changedAt: new Date().toISOString() } };
    });
  }, [patchProjectData]);

  const patchBlock = useCallback((
    id: string, patch: Partial<PlcBlock> | ((b: PlcBlock) => Partial<PlcBlock>),
  ) => {
    setProject(prev => ({
      ...prev,
      blocks: prev.blocks.map(b => (b.id === id
        ? { ...b, ...(typeof patch === 'function' ? patch(b) : patch), changedAt: new Date().toISOString() }
        : b)),
    }));
  }, [setProject]);

  return {
    project,
    editable: isCurrentRevisionEditable,
    setProject,
    patchBlock,
    started,
  };
}
