import React, { useState, createContext, useContext, ReactNode } from 'react';
import { ProjectData, TemplateItem, DeviceItem, Equipment, TemplateHierarchy, TemplateMechanical, Revision } from '../types/project';
import { ProjectConflict, SaveNeedsYou, projectService } from '../services/projectService';
import { removeTemplateEverywhere } from '../utils/cascadeDelete';
import { downloadText, fileSafe } from '../utils/download';

interface ProjectContextType {
  projectData: ProjectData;
  updateProjectData: (data: Partial<ProjectData>) => void;
  /** Same as updateProjectData, but the patch is derived from the project as
   *  it is at the moment of the write rather than from whatever the caller
   *  last rendered. A batch of edits applied in one go (the AI assistant's
   *  Apply button) would otherwise have each edit computed from the same
   *  stale copy, and the last one would throw the others away. */
  patchProjectData: (updater: (prev: ProjectData) => Partial<ProjectData>) => void;
  saveProject: () => Promise<void>;
  /** When the project was last written to the database — not when it was edited. */
  lastSavedAt: Date | null;
  /** True while a save is in flight. */
  saving: boolean;
  /** Why the last save failed, or null when the last one went through. */
  saveError: string | null;
  /**
   * True where the last failure will fail again however long it waits — two
   * projects with one name, a request the server refuses. The autosave stops
   * its loop for these, and the warning says so rather than claiming to be
   * still trying.
   */
  saveNeedsYou: boolean;
  /** Set when another computer saved this project while this copy was open. */
  conflict: ProjectConflictState | null;
  /**
   * Take the other computer's version. This copy is handed back as a file
   * first, so the work being set aside is still somewhere.
   */
  resolveConflictTakeTheirs: () => void;
  /** Keep this copy and write it over theirs — theirs is downloaded first. */
  resolveConflictKeepMine: () => Promise<void>;
  /** How many saves have failed in a row — 0 once one goes through. */
  saveFailures: number;
  /**
   * Write the project to a file on this computer, right now.
   *
   * The answer to a save that will not land. A file in a folder is somewhere;
   * anything held inside the browser is not — it goes with a cleared cache, a
   * reinstall or a different machine, and a copy somebody believes in and does
   * not have is worse than no copy at all.
   */
  downloadProjectCopy: () => void;
  /** Read one of those files back in. Saved afterwards like any other edit. */
  restoreFromFile: (project: ProjectData) => void;
  /**
   * Put one switchgear back as an older version of the project had it.
   *
   * The narrow restore, and the one that is usually wanted: a morning's rows
   * on one panel went, and nothing should happen to the other nine.
   */
  restoreOneSwitchgear: (from: ProjectData, equipmentId: string) => void;
  addTemplate: (type: 'LV' | 'MV' | 'HV', name: string, hierarchy?: TemplateHierarchy, copyFromId?: string, useSimorghDraw?: boolean, mechanical?: TemplateMechanical) => void;
  updateTemplate: (templateId: string, properties: Record<string, string>) => void;
  /** The mechanical answers a template holds, replaced whole. */
  setTemplateMechanical: (templateId: string, mechanical: TemplateMechanical) => void;
  /** Re-file a template under a new path, keeping its id and its parts. */
  moveTemplate: (templateId: string, hierarchy: TemplateHierarchy, name?: string, useSimorghDraw?: boolean) => void;
  deleteTemplate: (templateId: string) => void;
  addDevice: (device: Partial<DeviceItem>) => void;
  updateDevice: (deviceId: string, data: Partial<DeviceItem>) => void;
  deleteDevice: (deviceId: string) => void;
  addEquipment: (equipment: Equipment) => void;
  updateEquipment: (equipmentId: string, data: Partial<Equipment>) => void;
  deleteEquipment: (equipmentId: string) => void;
  copyEquipment: (equipmentId: string) => void;
  selectedEquipment: Equipment | null;
  setSelectedEquipment: (equipment: Equipment | null) => void;
  // Revision management
  currentRevision: Revision | null;
  revisions: Revision[];
  loadRevisions: (projectId: string) => Promise<void>;
  createRevision: (revisionName: string, description: string) => Promise<Revision>;
  switchRevision: (revisionId: string) => Promise<void>;
  deleteRevision: (revisionId: string, password: string) => Promise<void>;
  getNextRevisionNumber: () => number;
  // True when the currently selected revision may be saved/edited — i.e.
  // there is no revision selected yet (new project), or the selected
  // revision is the latest one. A non-latest revision (including
  // Revision 0 once higher revisions exist) is view-only.
  isCurrentRevisionEditable: boolean;
  // The revisions that block editing the current one (all newer ones), plus
  // the helpers a screen needs to react to a blocked edit attempt:
  // `notifyRevisionLocked()` raises the warning dialog, `revisionLockNotice`
  // drives it, `dismissRevisionLockNotice()` closes it.
  blockingRevisionNumbers: string[];
  revisionLockNotice: RevisionLockNotice | null;
  notifyRevisionLocked: () => void;
  dismissRevisionLockNotice: () => void;
  // True while TPMS owns this project: it is re-read from TPMS every time it
  // opens, so nothing here may be edited. Raising a revision takes it over.
  isTpmsMastered: boolean;
}

// Details shown by the "this revision is locked" dialog. `kind` says why:
// a newer revision exists, or TPMS still owns the project.
export interface RevisionLockNotice {
  kind: 'newer-revision' | 'tpms';
  currentRevisionNumber: string;
  blockingRevisionNumbers: string[];
  /** For the TPMS case: which TPMS project this one mirrors. */
  tpmsProject?: string;
  /** The revision number a new revision would get. */
  nextRevisionNumber?: string;
}

// EMPTY DEFAULTS - no demo values
// Exported so a project can be seeded from outside the provider — the project
// selection dialog builds one this way when it opens a switchgear from TPMS.
export const defaultProjectData: ProjectData = {
  projectName: '',
  projectId: '',
  projectNumber: '',
  noticeToProceedDate: '',
  deliveryDate: '',
  projectDescription: '',
  planner: '',
  designOffice: '',
  createdOn: new Date().toLocaleDateString(),
  changedOn: new Date().toLocaleDateString(),
  location: '',
  client: '',
  standard: '',
  country: '',
  language: '',
  comment: '',
  technicalSettings: {
    mediumVoltage: {
      nominalVoltage: '',
      maxShortCircuitPower: '',
      minShortCircuitPower: '',
      maxCrossSection: '',
      minCrossSection: ''
    },
    lowVoltage: {
      nominalVoltage: '',
      frequency: '',
      permissibleTouchVoltage: '',
      ambientTemperature: '',
      numberOfPoles: '',
      earthFaultDetection: '',
      referencePoint: '',
      relativeOperatingVoltage: '',
      maxPermissibleVoltage: '',
      maxCrossSection: '',
      minCrossSection: '',
      enableReducedCrossSection: false
    }
  },
  techSettings: {
    general: { altitudeAboveSeaLevel: '', designTemperature: '' },
    wireSize: { controlCircuit: '', ctSecondary: '', ptSecondary: '', plcPowerSupply: '' },
    wireColor: { acPhase: '', dcPlus: '', acNeutral: '', dcMinus: '', plcInput: '', plcOutput: '', threePhase: '' },
    wireManufacturer: { lv: '', mv: '' },
    others: { thicknessOfPainting: '', colorType: '', backgroundColor: '', writingColor: '' }
  },
  templates: { LV: [], MV: [], HV: [] },
  deviceLibrary: { LV: [], MV: [], HV: [] },
  devices: [],
  equipments: [],
  outputTypes: []
};

/** Two versions of one project, and what each of them is. */
export interface ProjectConflictState {
  message: string;
  /** The version on the server — somebody else's work. */
  theirs: ProjectData;
  theirRev: number;
  /** This copy, as it was when the save was refused. */
  mine: ProjectData;
}

const ProjectContext = createContext<ProjectContextType | undefined>(undefined);

interface ProjectProviderProps {
  children: ReactNode;
  initialProject?: ProjectData | null;
  initialRevision?: Revision | null;
}

export const ProjectProvider: React.FC<ProjectProviderProps> = ({ children, initialProject, initialRevision }) => {
  const [projectData, setProjectData] = useState<ProjectData>(
    initialProject
      ? { ...defaultProjectData, ...initialProject }
      : defaultProjectData
  );
  const [projectId, setProjectId] = useState<string | null>(initialProject?._id || null);
  const [selectedEquipment, setSelectedEquipment] = useState<Equipment | null>(null);

  // What the project screen can honestly say about saving.
  //
  // It used to say "Last saved: <projectData.changedOn>", and changedOn is set
  // locally on every edit — so it read as freshly saved while the backend was
  // down and nothing had been written for an hour. These three are the truth:
  // set from the save itself, never from an edit.
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const conflictRef = React.useRef(false);
  /**
   * How many times saving has failed in a row, and thus how many times the
   * person has been told.
   *
   * Counted rather than flagged so the warning can come back on each new
   * failure after being dismissed, instead of being dismissed once and never
   * seen again while nothing is being written.
   */
  const [saveFailures, setSaveFailures] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // True where the last failure is one that will fail again however long it
  // waits — a name clash, a request the server will not take. It decides
  // whether the autosave keeps trying and what the warning says.
  const [saveNeedsYou, setSaveNeedsYou] = useState(false);

  // A save reads these rather than its own closure. A save scheduled five
  // seconds ago and running now must write what the project is now, not what
  // it was when the timer was set.
  const projectDataRef = React.useRef<ProjectData>(defaultProjectData);
  const projectIdRef = React.useRef<string | null>(null);
  const currentRevisionRef = React.useRef<Revision | null>(null);
  /** The tail of the save chain, so two saves can never overlap or land out of order. */
  const saveChain = React.useRef<Promise<void>>(Promise.resolve());
  /**
   * The version of the project this copy is working from.
   *
   * Sent with every save and only moved on by a save that succeeded. It is
   * what tells the server that this copy is up to date — and what it refuses
   * the write on when somebody else has saved in the meantime.
   */
  const revRef = React.useRef<number | undefined>(
    (initialProject as { rev?: number } | null | undefined)?.rev);

  /**
   * Somebody else's version of this project, and the choice between them.
   *
   * While this is set the project is not saved at all: whichever way it is
   * resolved, one of the two days' work is being set aside, and that is not a
   * decision to make on somebody's behalf while they are typing.
   */
  const [conflict, setConflict] = useState<ProjectConflictState | null>(null);
  
  // Revision state - centralized source of truth
  const [currentRevision, setCurrentRevision] = useState<Revision | null>(initialRevision || null);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [isLoadingRevisions, setIsLoadingRevisions] = useState(false);

  // revisions is kept sorted latest-first by the backend/loadRevisions, so
  // revisions[0] is always the latest revision when any exist.
  const isCurrentRevisionEditable =
    !currentRevision || revisions.length === 0 || revisions[0]._id === currentRevision._id;

  // Every revision newer than the selected one — these are exactly the
  // revisions the user has to delete before this one becomes editable again.
  const blockingRevisionNumbers = React.useMemo(() => {
    if (!currentRevision || isCurrentRevisionEditable) return [];
    const currentNum = parseInt(currentRevision.revisionNumber) || 0;
    return revisions
      .filter(r => (parseInt(r.revisionNumber) || 0) > currentNum)
      .map(r => r.revisionNumber)
      .sort((a, b) => (parseInt(b) || 0) - (parseInt(a) || 0));
  }, [revisions, currentRevision, isCurrentRevisionEditable]);

  const [revisionLockNotice, setRevisionLockNotice] = useState<RevisionLockNotice | null>(null);
  const dismissRevisionLockNotice = () => setRevisionLockNotice(null);

  // While TPMS is the master, the project is a mirror of TPMS: it is read
  // again on every open, so an edit made here would be overwritten. The way
  // out is to raise a revision, which hands ownership to this side.
  const isTpmsMastered = projectData.tpmsSync?.master === 'tpms';

  projectDataRef.current = projectData;
  projectIdRef.current = projectId;
  currentRevisionRef.current = currentRevision;

  const notifyRevisionLocked = () => {
    setRevisionLockNotice(
      isTpmsMastered
        ? {
            kind: 'tpms',
            currentRevisionNumber: currentRevision?.revisionNumber ?? '',
            blockingRevisionNumbers: [],
            tpmsProject: projectData.tpmsSync?.oeNumber || projectData.tpmsSync?.projectName || '',
            nextRevisionNumber: String(getNextRevisionNumber()),
          }
        : {
            kind: 'newer-revision',
            currentRevisionNumber: currentRevision?.revisionNumber ?? '',
            blockingRevisionNumbers,
          });
  };

  // Every project mutation goes through this gate. The change is dropped and
  // the user is told why: a newer revision exists and has to be deleted first,
  // or TPMS still owns the project and a revision has to be raised.
  const guardEdit = (): boolean => {
    if (isTpmsMastered) {
      notifyRevisionLocked();
      return false;
    }
    if (isCurrentRevisionEditable) return true;
    notifyRevisionLocked();
    return false;
  };

  // Deep-link hydrate: the chatbot creates a project on simorgh-soft's
  // backend, then redirects the user to /simorgh-design-suite/?projectId=<_id>.
  // If we see that query param on mount AND we don't already have a project
  // loaded, fetch it and hydrate the context. One-shot — won't fight a
  // later in-app project switch.
  React.useEffect(() => {
    if (initialProject) return;
    try {
      const q = new URLSearchParams(window.location.search);
      const pid = q.get("projectId");
      if (!pid) return;
      (async () => {
        try {
          const p = await projectService.getProjectById(pid);
          if (p) {
            setProjectData({ ...defaultProjectData, ...p });
            setProjectId(pid);
          }
        } catch (e) {
          console.warn("deep-link hydrate failed:", e);
        }
      })();
    } catch { /* ignore: no window (SSR / test) */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateProjectData = (data: Partial<ProjectData>) => {
    if (!guardEdit()) return;
    setProjectData(prev => ({
      ...prev,
      ...data,
      changedOn: new Date().toISOString()
    }));
  };

  const patchProjectData = (updater: (prev: ProjectData) => Partial<ProjectData>) => {
    if (!guardEdit()) return;
    setProjectData(prev => ({
      ...prev,
      ...updater(prev),
      changedOn: new Date().toISOString()
    }));
  };

  /** Hand a version back as a file, so whichever one loses is still kept. */
  const keepACopy = (project: ProjectData, whose: string) => {
    const name = fileSafe(`${project.projectName || 'project'}-${whose}`);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    downloadText(`${name}-${stamp}.json`, JSON.stringify(project, null, 2), 'application/json');
  };

  const resolveConflictTakeTheirs = () => {
    if (!conflict) return;
    keepACopy(conflict.mine, 'my-version');
    setProjectData({ ...defaultProjectData, ...conflict.theirs });
    revRef.current = conflict.theirRev;
    conflictRef.current = false;
    setConflict(null);
    setSaveError(null);
  };

  const resolveConflictKeepMine = async () => {
    if (!conflict) return;
    keepACopy(conflict.theirs, 'their-version');
    // Their version is on disk, so writing over it loses nothing. Catching up
    // to their rev is what makes the next save land.
    revRef.current = conflict.theirRev;
    conflictRef.current = false;
    setConflict(null);
    setSaveError(null);
    await saveProject().catch(() => { /* reported through saveError */ });
  };

  const downloadProjectCopy = () => {
    const project = projectDataRef.current;
    keepACopy(project, 'copy');
  };

  /**
   * Read a downloaded copy back in.
   *
   * The id and the version are the ones this copy already has, not the ones in
   * the file: what is being restored is the *content* of an older state into
   * the project that exists now. Saving it is then an ordinary save, and if
   * somebody else has changed the project in the meantime the conflict dialog
   * asks about it like any other.
   */
  const restoreFromFile = (project: ProjectData) => {
    if (!guardEdit()) return;
    // What is on screen goes to a file first. Restoring the wrong one must not
    // be the thing that loses the afternoon.
    keepACopy(projectDataRef.current, 'replaced');
    const { _id, ...content } = project as ProjectData & { rev?: number };
    delete (content as { rev?: number }).rev;
    setProjectData(prev => ({
      ...defaultProjectData,
      ...content,
      _id: prev._id,
      changedOn: new Date().toISOString(),
    }));
  };

  const restoreOneSwitchgear = (from: ProjectData, equipmentId: string) => {
    if (!guardEdit()) return;
    const older = (from?.equipments ?? []).find(e => e.id === equipmentId);
    if (!older) return;
    keepACopy(projectDataRef.current, 'replaced');
    setProjectData(prev => {
      const here = prev.equipments.some(e => e.id === equipmentId);
      return {
        ...prev,
        // Back where it was if it is still in the project, and on the end if
        // it was the switchgear itself that went.
        equipments: here
          ? prev.equipments.map(e => (e.id === equipmentId ? older : e))
          : [...prev.equipments, older],
        changedOn: new Date().toISOString(),
      };
    });
    // The rows on screen come from the selected switchgear, and this is the
    // selected switchgear changing underneath it.
    if (selectedEquipment?.id === equipmentId) setSelectedEquipment(older);
  };

  const saveProject = async (): Promise<void> => {
    // A TPMS-mastered project is written by the sync, not from here.
    if (isTpmsMastered) {
      notifyRevisionLocked();
      throw new Error(
        'This project is read from TPMS. Raise a revision in Design Suite to edit it here.');
    }
    // Revision 0 (or any older revision) becomes read-only once a newer
    // revision exists — the user must delete the newer revisions first.
    if (currentRevision && !isCurrentRevisionEditable) {
      notifyRevisionLocked();
      throw new Error(
        `Revision ${currentRevision.revisionNumber} is locked because newer revision(s) ` +
        `${blockingRevisionNumbers.map(n => `REV ${n}`).join(', ')} exist. ` +
        `Delete the newer revisions to edit it again.`
      );
    }
    // While two versions are on the table, nothing is written.
    if (conflictRef.current) {
      throw new Error('This project was changed on another computer — resolve that first');
    }
    // Saves run one at a time, in order.
    //
    // Two overlapping PUTs of the whole project are a coin toss: the one that
    // reaches Mongo last wins, and that is not necessarily the newer one. The
    // chain also coalesces — a save queued behind another reads the project as
    // it is when its turn comes, so what lands is always the latest.
    const run = async (): Promise<void> => {
      const data = projectDataRef.current;
      const id = projectIdRef.current;
      const revision = currentRevisionRef.current;

      // The version goes as `baseRev`, never in the body. It is the database's
      // own field, moved by $inc, and a body that also carries it asks Mongo
      // to set and increment the same path in one update — which it refuses,
      // with a 500, on every save of a project that had ever been loaded.
      const { _id, rev: _loadedRev, ...withoutId } =
        data as ProjectData & { rev?: number };
      const projectToSave = { ...withoutId, changedOn: new Date().toISOString() };

      setSaving(true);
      try {
        if (id) {
          const saved = await projectService.updateProject(id, projectToSave, revRef.current);
          revRef.current = (saved as { rev?: number })?.rev ?? revRef.current;
        } else {
          const created = await projectService.createProject(projectToSave);
          setProjectId(created._id!);
          projectIdRef.current = created._id!;
          revRef.current = (created as { rev?: number })?.rev ?? 1;
          // Only the id is taken from the reply, and only when the project has
          // not got one yet.
          //
          // The whole reply used to be written back over the open project:
          // `setProjectData(savedProject)`. A save takes as long as a round
          // trip, and anything typed while it was in flight was thrown away by
          // its own answer — the edit stayed on screen, where the table keeps
          // its own copy of the rows, and never reached the database. Coming
          // back to that switchgear later is when it appeared to vanish.
          setProjectData(prev => (prev._id ? prev : { ...prev, _id: created._id }));
        }

        // Revisions are otherwise frozen at creation time. Keep the active
        // revision's stored snapshot in sync with further edits so that
        // switching away and back to it preserves the latest changes. The
        // snapshot is what was sent, not what came back.
        if (revision) {
          const updatedRevision = await projectService.updateRevision(revision._id!, {
            projectSnapshot: { ...projectToSave, _id: id ?? projectIdRef.current ?? undefined },
          });
          // Only take the response when it really is a revision. A malformed
          // reply used to replace the active revision with something that had
          // no _id, which reads as "not the latest revision" — and the whole
          // project silently went read-only.
          if (updatedRevision && (updatedRevision as any)._id) {
            setCurrentRevision(updatedRevision);
            setRevisions(prev => prev.map(r => (r._id === updatedRevision._id ? updatedRevision : r)));
          } else {
            console.warn('updateRevision returned no revision; keeping the current one.');
          }
        }

        setLastSavedAt(new Date());
        setSaveError(null);
        setSaveNeedsYou(false);
        setSaveFailures(0);
      } catch (error) {
        if (error instanceof ProjectConflict) {
          // Not a failure to be retried — retrying would either keep failing
          // or, worse, eventually overwrite. It is a question for the person.
          conflictRef.current = true;
          setConflict({
            message: error.message,
            theirs: error.theirs,
            theirRev: error.theirRev,
            mine: projectToSave as ProjectData,
          });
          setSaveError(error.message);
          throw error;
        }
        // Said out loud rather than logged and forgotten: an unsaved project
        // that looks saved is how a day's work goes missing.
        const message = (error as Error)?.message || 'Could not reach the server';
        console.error('Error saving project:', error);
        setSaveError(message);
        setSaveNeedsYou(error instanceof SaveNeedsYou);
        // Each failure is its own telling. A warning dismissed once must not
        // buy silence for the rest of an afternoon in which nothing is saved.
        setSaveFailures(n => n + 1);
        throw error;
      } finally {
        setSaving(false);
      }
    };

    const next = saveChain.current.then(run, run);
    // The chain must survive a failure, or one unreachable server would stop
    // every later save from ever being attempted.
    saveChain.current = next.catch(() => {});
    return next;
  };

  const addTemplate = (
    type: 'LV' | 'MV' | 'HV',
    name: string,
    hierarchy?: TemplateHierarchy,
    copyFromId?: string,
    useSimorghDraw?: boolean,
    mechanical?: TemplateMechanical,
  ) => {
    if (!guardEdit()) return;
    setProjectData(prev => {
      // Optional clone of an existing template's properties (deep enough for
      // our value tree). Used by the hierarchical wizard's "use as a starting
      // point" flow.
      let baseProps: Record<string, any> = {};
      // A template cloned from another inherits its mechanical answers too —
      // the earth switches and the magnet label are properties of the kind of
      // cell it is, and a copy is the same kind of cell. Anything answered in
      // the wizard still wins, so the inheritance is a starting point rather
      // than something to undo.
      let baseMechanical: TemplateMechanical | undefined;
      if (copyFromId) {
        const source = prev.templates[type].find(t => t.id === copyFromId);
        if (source) {
          baseProps = JSON.parse(JSON.stringify(source.properties || {}));
          if (source.mechanical) baseMechanical = { ...source.mechanical };
        }
      }
      const mech = mechanical && Object.keys(mechanical).length > 0
        ? mechanical : baseMechanical;
      const newTemplate: TemplateItem = {
        id: `${type}-${Date.now()}`,
        name,
        type,
        properties: baseProps,
        ...(hierarchy ? { hierarchy } : {}),
        ...(useSimorghDraw !== undefined ? { useSimorghDraw } : {}),
        // Only when something was actually answered: an empty object on
        // every template would make "nobody has looked at this yet"
        // indistinguishable from "looked at, nothing to say".
        ...(mech && Object.keys(mech).length > 0 ? { mechanical: mech } : {}),
      };
      return {
        ...prev,
        templates: {
          ...prev.templates,
          [type]: [...prev.templates[type], newTemplate],
        },
        changedOn: new Date().toISOString(),
      };
    });
  };

  const updateTemplate = (templateId: string, properties: Record<string, string>) => {
    if (!guardEdit()) return;
    setProjectData(prev => {
      const updatedTemplates = { ...prev.templates };
      for (const type of ['LV', 'MV', 'HV'] as const) {
        updatedTemplates[type] = updatedTemplates[type].map(template =>
          template.id === templateId ? { ...template, properties } : template
        );
      }
      return {
        ...prev,
        templates: updatedTemplates,
        changedOn: new Date().toISOString()
      };
    });
  };

  // The mechanical answers are replaced whole rather than merged: clearing an
  // override is dropping its key, and a merge would have no way to say so.
  const setTemplateMechanical = (templateId: string, mechanical: TemplateMechanical) => {
    if (!guardEdit()) return;
    setProjectData(prev => {
      const updatedTemplates = { ...prev.templates };
      for (const type of ['LV', 'MV', 'HV'] as const) {
        updatedTemplates[type] = updatedTemplates[type].map(template =>
          template.id === templateId ? { ...template, mechanical } : template
        );
      }
      return { ...prev, templates: updatedTemplates, changedOn: new Date().toISOString() };
    });
  };

  // Moving a template keeps its id, and that is the whole point: the device
  // rows built on it point at that id, so re-filing it under another path
  // leaves every row it is used by exactly as it was. A move done as a copy
  // and a delete would take those rows with it.
  const moveTemplate = (
    templateId: string, hierarchy: TemplateHierarchy, name?: string,
    useSimorghDraw?: boolean,
  ) => {
    if (!guardEdit()) return;
    setProjectData(prev => {
      const updatedTemplates = { ...prev.templates };
      for (const type of ['LV', 'MV', 'HV'] as const) {
        updatedTemplates[type] = updatedTemplates[type].map(template =>
          template.id === templateId
            ? {
                ...template, hierarchy,
                ...(name?.trim() ? { name: name.trim() } : {}),
                ...(useSimorghDraw !== undefined ? { useSimorghDraw } : {}),
              }
            : template
        );
      }
      return { ...prev, templates: updatedTemplates, changedOn: new Date().toISOString() };
    });
  };

  // Deleting a template also clears the device rows that were built on it —
  // a row pointing at a template that no longer exists would keep a name in
  // the grid while all of its property columns come out blank.
  const deleteTemplate = (templateId: string) => {
    if (!guardEdit()) return;
    setProjectData(prev => ({
      ...prev,
      ...removeTemplateEverywhere(prev, templateId),
      changedOn: new Date().toISOString()
    }));
  };

  const addDevice = (device: Partial<DeviceItem>) => {
    if (!guardEdit()) return;
    const newDevice: DeviceItem = {
      id: `device-${Date.now()}`,
      rowNumber: projectData.devices.length + 1,
      deviceName: `Device ${projectData.devices.length + 1}`,
      templateId: '',
      flc: '',
      ratingPower: '',
      wiringType: '',
      feederNo: '',
      busSection: '',
      children: [],
      equipmentId: selectedEquipment?.id, // ⭐ ارتباط با Equipment انتخاب شده
      ...device
    };
    setProjectData(prev => ({
      ...prev,
      devices: [...prev.devices, newDevice],
      changedOn: new Date().toISOString()
    }));
  };

  const updateDevice = (deviceId: string, data: Partial<DeviceItem>) => {
    if (!guardEdit()) return;
    setProjectData(prev => ({
      ...prev,
      devices: prev.devices.map(device =>
        device.id === deviceId ? { ...device, ...data } : device
      ),
      changedOn: new Date().toISOString()
    }));
  };

  const deleteDevice = (deviceId: string) => {
    if (!guardEdit()) return;
    setProjectData(prev => ({
      ...prev,
      devices: prev.devices.filter(device => device.id !== deviceId),
      changedOn: new Date().toISOString()
    }));
  };

  // ⭐ جدید - Equipment Methods
  const addEquipment = (equipment: Equipment) => {
    if (!guardEdit()) return;
    setProjectData(prev => ({
      ...prev,
      equipments: [...prev.equipments, equipment],
      changedOn: new Date().toISOString()
    }));
  };

  const updateEquipment = (equipmentId: string, data: Partial<Equipment>) => {
    if (!guardEdit()) return;
    setProjectData(prev => ({
      ...prev,
      equipments: prev.equipments.map(eq =>
        eq.id === equipmentId ? { ...eq, ...data } : eq
      ),
      changedOn: new Date().toISOString()
    }));
  };

  const deleteEquipment = (equipmentId: string) => {
    if (!guardEdit()) return;
    // Removes the equipment from the project arrangement together with its
    // device rows. The Device Library entry it was created from is NOT
    // touched — the user may want to lay the same device out again.
    setProjectData(prev => ({
      ...prev,
      equipments: prev.equipments.filter(eq => eq.id !== equipmentId),
      devices: prev.devices.filter(device => device.equipmentId !== equipmentId),
      changedOn: new Date().toISOString()
    }));
    
    if (selectedEquipment?.id === equipmentId) {
      setSelectedEquipment(null);
    }
  };

  const copyEquipment = (equipmentId: string) => {
    if (!guardEdit()) return;
    const equipment = projectData.equipments.find(eq => eq.id === equipmentId);
    if (equipment) {
      const copiedEquipment: Equipment = {
        ...equipment,
        id: `eq-${Date.now()}`,
        name: `${equipment.name} (Copy)`
      };
      addEquipment(copiedEquipment);
    }
  };

  // ============================================
  // Revision Management - Centralized Source of Truth
  // ============================================

  const loadRevisions = async (pid: string) => {
    if (!pid) return;
    try {
      setIsLoadingRevisions(true);
      console.log('Loading revisions for project:', pid);
      const revisionsData = await projectService.getRevisions(pid);
      console.log('Loaded revisions:', revisionsData.length);
      setRevisions(revisionsData);
      
      // Auto-create Revision 0 if no revisions exist
      if (revisionsData.length === 0 && pid) {
        console.log('No revisions found, creating Revision 0...');
        const rev0 = await createRevisionForProject(pid, 'Initial', 'Base revision created automatically');
        setCurrentRevision(rev0);
      } else if (revisionsData.length > 0 && !currentRevision) {
        // Set current revision to latest (first after sort by revisionNumber desc)
        console.log('Setting current revision to latest:', revisionsData[0].revisionNumber);
        setCurrentRevision(revisionsData[0]);
      }
    } catch (err) {
      console.error('Failed to load revisions:', err);
      setRevisions([]);
    } finally {
      setIsLoadingRevisions(false);
    }
  };

  const getNextRevisionNumber = (): number => {
    if (revisions.length === 0) return 0;
    const maxRev = Math.max(...revisions.map(r => parseInt(r.revisionNumber) || 0));
    return maxRev + 1;
  };

  const createRevisionForProject = async (pid: string, revName: string, desc: string): Promise<Revision> => {
    const nextNum = getNextRevisionNumber();

    // Raising a revision on a TPMS-mirrored project is the hand-over: from
    // here on this side owns the project, so it stops being re-read from TPMS
    // and becomes editable. The revisions TPMS wrote stay where they are.
    const takingOver = projectData.tpmsSync?.master === 'tpms';
    const tpmsSync = takingOver
      ? {
          ...projectData.tpmsSync!,
          master: 'suite' as const,
          detachedAt: new Date().toISOString(),
          detachedAtRevision: String(nextNum),
        }
      : projectData.tpmsSync;
    const snapshot: ProjectData = { ...projectData, ...(tpmsSync ? { tpmsSync } : {}) };

    console.log('Creating revision:', {
      projectId: pid,
      revisionNumber: nextNum.toString(),
      projectName: projectData.projectName,
      takingOverFromTpms: takingOver,
    });

    const newRevision = await projectService.createRevision({
      projectId: pid,
      revisionNumber: nextNum.toString(),
      revisionName: revName || `Revision ${nextNum}`,
      description: desc || '',
      createdBy: 'user',
      projectSnapshot: snapshot,
      isLocked: false,
      source: 'suite',
    });

    if (takingOver) {
      setProjectData(snapshot);
      try {
        await projectService.updateProject(pid, { tpmsSync });
      } catch (err) {
        console.error('Revision created, but the project could not be marked as taken over:', err);
      }
    }
    
    console.log('Revision created successfully:', newRevision);
    
    // Reload revisions and set new one as current
    await loadRevisions(pid);
    // currentRevision will be set by loadRevisions -> it's already the first in list
    // But we explicitly set it here to ensure it's the newly created one
    setCurrentRevision(newRevision);
    return newRevision;
  };

  const createRevision = async (revName: string, desc: string): Promise<Revision> => {
    if (!projectId) {
      console.error('No projectId available for creating revision');
      throw new Error('Project must be saved before creating a revision');
    }
    console.log('createRevision called with:', { projectId, revName, desc });
    return createRevisionForProject(projectId, revName, desc);
  };

  const switchRevision = async (revisionId: string) => {
    console.log('Switching to revision:', revisionId);
    const revision = revisions.find(r => r._id === revisionId);
    if (!revision) {
      console.error('Revision not found:', revisionId);
      throw new Error('Revision not found');
    }
    
    // Load the project snapshot from the selected revision
    if (revision.projectSnapshot) {
      console.log('Loading project snapshot from revision:', revision.revisionNumber);
      setProjectData({ ...defaultProjectData, ...revision.projectSnapshot });
      setCurrentRevision(revision);
      // Update project ID to ensure consistency
      setProjectId(revision.projectId);
      console.log('Successfully switched to revision:', revision.revisionNumber);
    } else {
      console.error('Revision has no projectSnapshot:', revision);
      throw new Error('Revision has no project snapshot');
    }
  };

  const deleteRevision = async (revisionId: string, password: string): Promise<void> => {
    if (!projectId) {
      throw new Error('No project loaded');
    }
    await projectService.deleteRevision(revisionId, password);

    const updatedRevisions = await projectService.getRevisions(projectId);
    setRevisions(updatedRevisions);

    // If the deleted revision was the active one, fall back to the new
    // latest revision and load its snapshot.
    if (currentRevision && currentRevision._id === revisionId) {
      const newCurrent = updatedRevisions.length > 0 ? updatedRevisions[0] : null;
      setCurrentRevision(newCurrent);
      if (newCurrent && newCurrent.projectSnapshot) {
        setProjectData({ ...defaultProjectData, ...newCurrent.projectSnapshot });
        setProjectId(newCurrent.projectId);
      }
    }
  };

  // Load revisions when project ID changes
  React.useEffect(() => {
    if (projectId && !initialRevision) {
      loadRevisions(projectId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  return (
    <ProjectContext.Provider
      value={{
        projectData,
        updateProjectData,
        patchProjectData,
        saveProject,
        lastSavedAt,
        saving,
        saveError,
        saveNeedsYou,
        conflict,
        resolveConflictTakeTheirs,
        resolveConflictKeepMine,
        saveFailures,
        downloadProjectCopy,
        restoreFromFile,
        restoreOneSwitchgear,
        addTemplate,
        updateTemplate,
        setTemplateMechanical,
        moveTemplate,
        deleteTemplate,
        addDevice,
        updateDevice,
        deleteDevice,
        addEquipment,
        updateEquipment,
        deleteEquipment,
        copyEquipment,
        selectedEquipment,
        setSelectedEquipment,
        // Revision management
        currentRevision,
        revisions,
        loadRevisions,
        createRevision,
        switchRevision,
        deleteRevision,
        getNextRevisionNumber,
        isCurrentRevisionEditable,
        isTpmsMastered,
        blockingRevisionNumbers,
        revisionLockNotice,
        notifyRevisionLocked,
        dismissRevisionLockNotice
      }}
    >
      {children}
    </ProjectContext.Provider>
  );
};

export const useProject = () => {
  const context = useContext(ProjectContext);
  if (context === undefined) {
    throw new Error('useProject must be used within a ProjectProvider');
  }
  return context;
};