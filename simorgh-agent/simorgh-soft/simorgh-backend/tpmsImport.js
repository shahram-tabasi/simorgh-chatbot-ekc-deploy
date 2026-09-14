// TPMS import — everything Eplanix reads out of the TPMS MySQL database,
// mapped onto the shapes Simorgh Design Suite works in.
//
// Eplanix (the switchgear company's .NET app) reads MySQL only, through these
// views and tables:
//
//   View_Project_Main                 the OE project
//   view_scope + CODING_SECONDARY_GRP_TB   the switchgear (scope) and its type
//   technical_project_identity_       project-wide technical settings
//   technical_panel_identity          the panel's own specification
//   TECHNICAL_PROPERTIES              lookup titles for the coded fields above
//   View_draft                        one row per feeder line
//   View_draft_Equipment              the parts on each line
//   Technical_draft_lable_eplan_TB    the EPLAN label for a part code
//   View_draft_column                 per-project names for the part columns
//
// This module runs the same reads and returns one payload the frontend turns
// into project data, technical settings, a Device Library entry, a switchgear
// with its device rows, and the templates behind them. Read-only throughout —
// nothing here writes to TPMS.

import { deadline, MYSQL_PING_TIMEOUT_MS } from './dbTimeout.js';

// Equipment slot → template property, in the order the Create Template screen
// lays them out. Slots 1‑17 line up with Simorgh's LV list exactly; slots 18
// (F.C/soft starter) and 19 (surge arrester) have no LV property of their own,
// so they land in the two spare rows LV has beyond MV's five.

export const LV_SLOT_PROPERTIES = {
  1: 'CB ORDER',
  2: 'ACCESSORY',
  3: 'CONTACTOR. ORDER',
  4: 'OVER LOAD RELAY',
  5: 'EARTH FAULT',
  6: 'COREBALANCE CT',
  7: 'PROTECTION RELAY',
  8: 'CT RATING',
  9: 'AMMETER',
  10: 'AMMETER selector',
  11: 'PT RATING',
  12: 'VOLTMETER',
  13: 'VOLTMETER selector',
  14: 'MULTIMETER',
  15: 'TEST BLOCK',
  16: 'TRANSDUSER',
  17: 'ALARM ANUNCIATOR',
  18: 'SPARE 6',
  19: 'SPARE 7',
  20: 'SPARE 1',
  21: 'SPARE 2',
  22: 'SPARE 3',
  23: 'SPARE 4',
  24: 'SPARE 5',
};

export const MV_SLOT_PROPERTIES = {
  1: 'VCB OR VC/FUSE',
  2: 'ACCESSORY',
  5: 'VOLTAGE INDICATOR',
  6: 'COREBALANCE CT',
  7: 'PROTECTION RELAY',
  8: 'CT RATING',
  9: 'AMMETER',
  10: 'AMMETER selector',
  11: 'PT RATING',
  12: 'VOLTMETER',
  13: 'VOLTMETER selector',
  14: 'MULTIMETER',
  15: 'TEST BLOCK',
  16: 'TRANSDUSER',
  17: 'ALARM WINDDOW',
  19: 'SURGE ARRESTER',
  20: 'SPARE 1',
  21: 'SPARE 2',
  22: 'SPARE 3',
  23: 'SPARE 4',
  24: 'SPARE 5',
};

const str = v => (v === null || v === undefined ? '' : String(v).trim());

// The code shown for one part, following Eplanix's FormatSCODE:
//   the EPLAN label for its ECODE when there is one; otherwise SCODE, except
//   that a blank SCODE (or an "LV Current Transformer") falls back to the
//   short or English description; and slot 15 keeps only what is in brackets.
export function formatScode(row) {
  const label = str(row.tlabel);
  if (str(row.Ecode) && label) return label;

  let code = str(row.SCODE);
  if (!code || str(row.SEC_DES) === 'LV Current Transformer') {
    code = str(row.SHR_DES) || str(row.ENG_DES);
  }
  if (Number(row.equipment) === 15 && code.includes('(')) {
    const start = code.indexOf('(');
    const end = code.indexOf(')');
    if (start >= 0 && end > start) return code.slice(start + 1, end);
  }
  return code;
}

// Group the joined draft rows into one line per draft, each carrying its parts
// keyed by equipment slot and ordered by priority — the same grouping Eplanix
// pivots into its columns.
export function buildLines(joinedRows) {
  const byDraft = new Map();

  for (const row of joinedRows) {
    const id = String(row.draftId);
    if (!byDraft.has(id)) {
      byDraft.set(id, {
        draftId: row.draftId,
        ordering: row.ordering ?? 0,
        busSection: str(row.bus_section),
        feederNo: str(row.feeder_no),
        wiringType: str(row.wiring_type),
        ratingPower: str(row.rating_power),
        flc: str(row.flc),
        tag: str(row.tag),
        description: str(row.Designation),
        moduleNo: str(row.Module),
        size: str(row.Size),
        sfdHfd: str(row.sfd_hfd),
        cableSize: str(row.cable_size),
        cbRating: str(row.cb_rating),
        contactorRating: str(row.contactor_rating),
        overloadRating: str(row.overLoad_rating),
        moduleType: str(row.module_type),
        templateName: str(row.templateName),
        parts: {},
      });
    }
    const slot = row.equipment == null ? null : Number(row.equipment);
    if (slot === null || Number.isNaN(slot)) continue; // line with no parts yet

    const line = byDraft.get(id);
    (line.parts[slot] ||= []).push({
      slot,
      label: str(row.label),
      code: formatScode(row),
      quantity: Number(row.QTY) > 0 ? Number(row.QTY) : 1,
      priority: Number(row.priority) || 0,
      ecode: str(row.Ecode),
      scode: str(row.SCODE),
      secDes: str(row.SEC_DES),
      engDes: str(row.ENG_DES),
      shrDes: str(row.SHR_DES),
    });
  }

  const lines = [...byDraft.values()];
  for (const line of lines) {
    for (const slot of Object.keys(line.parts)) {
      line.parts[slot].sort((a, b) => a.priority - b.priority);
    }
  }
  return lines.sort((a, b) => (a.ordering ?? 0) - (b.ordering ?? 0));
}

// The same grouping, one step up: the whole project's rows for one revision,
// split per switchgear (View_draft.Tablo_ID). Used by the project-wide import,
// which reads every switchgear of a revision in a single query.
export function buildLinesByScope(joinedRows) {
  const byScope = new Map();
  for (const row of joinedRows || []) {
    const key = String(row.tabloId ?? '');
    if (!byScope.has(key)) byScope.set(key, []);
    byScope.get(key).push(row);
  }
  const out = [];
  for (const [key, rows] of byScope) {
    out.push({
      scopeId: Number(key),
      scopeName: str(rows[0]?.scopeName),
      lines: buildLines(rows),
    });
  }
  return out;
}

// TPMS stores many panel/project fields as an id into TECHNICAL_PROPERTIES,
// with a free-text "remark" column used when the chosen title is "Remark" (or
// when nothing was chosen). This resolves that pair the way Eplanix does.
export function makeTitleResolver(propertyTitles) {
  return (id, remark) => {
    const key = Number(id);
    const title = Number.isFinite(key) ? str(propertyTitles[key]) : '';
    if (!title || title === 'Remark') return str(remark);
    return title;
  };
}

// technical_panel_identity → the Device Library entry for this switchgear.
export function mapPanelToDeviceProperties(panel, project, resolve) {
  if (!panel) return {};
  const p = panel;
  const pr = project || {};
  return {
    frequency: resolve(p.frequency, p.frequency_Remark_Description),
    mainBusbarConfiguration: resolve(p.mbc, p.mbc_Remark_Description),
    mainBusbarRatedCurrent: str(p.Switch_Amperage),
    ratedShortTimeWithstandCurrent: str(p.KABUS),
    isc: str(p.ABUS),
    height: str(p.Height),
    width: str(p.Width),
    depth: str(p.Depth),
    ratedImpulseWithstandVoltage: str(p.riwv),
    controlProtectionClosingTrippingSignalling: str(p.cpcts),
    ratedInsulationVoltage: resolve(p.rated_voltage, p.rated_voltage_Remark_Description),
    serviceVoltage: resolve(p.Voltage_Rate, p.Voltage_Rate_Remark_Description),
    springChargingMotor: str(p.scm),
    switchgearLightingSpaceHeater: str(p.plsh),
    motorsSpaceHeater: str(p.msh),
    ratedPowerFrequencyWithstandVoltage: str(p.rpfwv),
    mainBusbarSize: str(p.Main_Busbar_Size),
    earthBusbarSize: str(p.Earth_Size),
    neutralBusbarSize: str(p.Neutral_Size),
    ral: (() => {
      const colour = resolve(p.Color_Real, p.Color_Real_Remark_Description);
      return colour && !/^ral/i.test(colour) ? `RAL ${colour}` : colour;
    })(),
    incomingConnection: resolve(p.Inlet_Contact, p.Inlet_Contact_Remark_Description),
    outgoingConnection: resolve(p.Outlet_Contact, p.Outlet_Contact_Remark_Description),
    ip: resolve(p.IP, p.IP_Remark_Description),
    switchgearAccess: resolve(p.Access_From, p.Access_From_Remark_Description),
    switchgearArrangement: resolve(p.Layout_Type, p.Layout_Type_Remark_Description),
    busbarType: resolve(p.Type_Busbar, p.Type_Busbar_Remark_Description),
    thermoFitCover: resolve(p.Isolation, p.Isolation_Remark_Description),
    coating: resolve(p.Plating_Type, p.Plating_Type_Remark_Description),
    padLockCbOnOff: !!Number(p.PadLock_KeyContactor),
    padLockCbTestService: !!Number(p.Padlock_KeyTest),
    padLockHvDoor: !!Number(p.Padlock_SwitchTest),
    // Kept for the technical settings block, which reads the project record.
    __designTemperature: resolve(pr.Average_Temperature, pr.Average_Temperature_Remark_Description),
  };
}

// technical_project_identity_ → the project's Technical Settings.
export function mapProjectToTechSettings(project, resolve) {
  const p = project || {};
  return {
    general: {
      altitudeAboveSeaLevel: str(p.Above_Sea_Level),
      designTemperature: resolve(p.Average_Temperature, p.Average_Temperature_Remark_Description),
    },
    wireSize: {
      controlCircuit: resolve(p.Control_Wire_Size, p.Control_Wire_Size_Remark_Description),
      ctSecondary: resolve(p.CT_Wire_Size, p.CT_Wire_Size_Remark_Description),
      ptSecondary: resolve(p.PT_Wire_Size, p.PT_Wire_Size_Remark_Description),
      plcPowerSupply: resolve(p.PLC_Feeding_Wire_Size, p.PLC_Feeding_Wire_Size_Remark_Description),
    },
    wireColor: {
      acPhase: resolve(p.Phase_Wire_Color, p.Phase_Wire_Color_Remark_Description),
      dcPlus: resolve(p.DC_Plus_Wire_Color, p.DC_Plus_Wire_Color_Remark_Description),
      acNeutral: resolve(p.Natural_Wire_Color, p.Natural_Wire_Color_Remark_Description),
      dcMinus: resolve(p.DC_Mines_Wire_Color, p.DC_Mines_Wire_Color_Remark_Description),
      plcInput: resolve(p.Digital_Inlet_Wire_Color, p.Digital_Inlet_Wire_Color_Remark_Description),
      plcOutput: resolve(p.Digital_Outlet_Wire_Color, p.Digital_Outlet_Wire_Color_Remark_Description),
      threePhase: resolve(p.Three_Phase_Wire_Color, p.Three_Phase_Wire_Color_Remark_Description),
    },
    // TPMS has no wire-manufacturer field; the section is still returned so the
    // shape is always complete for the screens that read it.
    wireManufacturer: { lv: '', mv: '' },
    others: {
      thicknessOfPainting: resolve(p.Color_Thickness, p.Color_Thickness_Remark_Description),
      colorType: resolve(p.Color_Type, p.Color_Type_Remark_Description),
      backgroundColor: resolve(p.Label_Background_Color, p.Label_Background_Color_Remark_Description),
      writingColor: resolve(p.Label_Writing_Color, p.Label_Writing_Color_Remark_Description),
    },
  };
}

// A switchgear type name decides the tier, the same test Eplanix applies.
export function panelTypeFromSwitchgear(switchgearType) {
  const name = str(switchgearType).toUpperCase();
  const isMv = name.includes('SIMOPRIME') || name.includes('EK36') || name.includes('8BK');
  return isMv ? 'MV' : 'LV';
}

// The property-id fields that need a TECHNICAL_PROPERTIES title.
const PANEL_PROPERTY_FIELDS = [
  'frequency', 'mbc', 'rated_voltage', 'Voltage_Rate', 'Color_Real', 'IP',
  'Access_From', 'Inlet_Contact', 'Outlet_Contact', 'Plating_Type', 'Isolation',
  'Layout_Type', 'Type_Busbar',
];
const PROJECT_PROPERTY_FIELDS = [
  'Average_Temperature', 'Control_Wire_Size', 'CT_Wire_Size', 'PT_Wire_Size',
  'PLC_Feeding_Wire_Size', 'DC_Plus_Wire_Color', 'DC_Mines_Wire_Color',
  'Phase_Wire_Color', 'Natural_Wire_Color', 'Three_Phase_Wire_Color',
  'Digital_Inlet_Wire_Color', 'Digital_Outlet_Wire_Color', 'Color_Thickness',
  'Color_Type', 'Label_Background_Color', 'Label_Writing_Color',
];

export function collectPropertyIds(panel, project) {
  const ids = new Set();
  for (const field of PANEL_PROPERTY_FIELDS) {
    const v = Number(panel?.[field]);
    if (Number.isFinite(v) && v > 0) ids.add(v);
  }
  for (const field of PROJECT_PROPERTY_FIELDS) {
    const v = Number(project?.[field]);
    if (Number.isFinite(v) && v > 0) ids.add(v);
  }
  return [...ids];
}

// Assemble the payload the frontend imports from.
export function buildImportPayload({
  projectRow, scopeRow, panelRow, projectIdentityRow, propertyTitles,
  joinedRows, columnRows, revisionId,
}) {
  const resolve = makeTitleResolver(propertyTitles || {});
  const switchgearType = str(scopeRow?.swTypeName);
  const panelType = panelTypeFromSwitchgear(switchgearType);
  const lines = buildLines(joinedRows || []);

  const columnNames = {};
  for (const row of columnRows || []) {
    const level = Number(row.level);
    if (Number.isFinite(level) && str(row.name)) columnNames[level] = str(row.name);
  }

  const deviceProperties = mapPanelToDeviceProperties(panelRow, projectIdentityRow, resolve);
  delete deviceProperties.__designTemperature;

  const scopeName = str(scopeRow?.scopeName) || str(lines[0]?.scopeName) || 'Switchgear';

  return {
    project: {
      projectMainId: projectRow?.IDProjectMain ?? null,
      oeNumber: str(projectRow?.OENUM),
      projectName: str(projectRow?.Project_Name),
      projectNameFa: str(projectRow?.Project_Name_Fa),
      orderCategory: str(projectRow?.Order_Category),
      oeDate: str(projectRow?.OEDATE),
      projectExpert: str(projectRow?.Project_Expert_Label),
      technicalSupervisor: str(projectRow?.Technical_Supervisor_Label),
      technicalExpert: str(projectRow?.Technical_Expert_Label),
    },
    scope: {
      scopeId: scopeRow?.IDProjectScope ?? null,
      scopeName,
      switchgearType,
      panelType,
      cellCount: str(scopeRow?.Cell_No),
      revision: revisionId ?? null,
      tag: str(scopeRow?.TAG),
    },
    techSettings: mapProjectToTechSettings(projectIdentityRow, resolve),
    device: {
      name: scopeName,
      type: panelType,
      properties: deviceProperties,
    },
    columnNames,
    slotProperties: panelType === 'MV' ? MV_SLOT_PROPERTIES : LV_SLOT_PROPERTIES,
    lines,
    counts: {
      lines: lines.length,
      parts: lines.reduce((sum, l) => sum + Object.values(l.parts).reduce((n, p) => n + p.length, 0), 0),
      templates: new Set(lines.map(l => l.templateName || l.wiringType || '')).size,
    },
  };
}

// Assemble the header of a project-wide import: the project itself, its
// technical settings, and every switchgear it holds — everything except the
// feeder lines, which are read one revision at a time.
export function buildProjectPayload({
  projectRow, projectIdentityRow, propertyTitles, scopes, columnRows, revisions,
}) {
  const resolve = makeTitleResolver(propertyTitles || {});

  const columnNames = {};
  for (const row of columnRows || []) {
    const level = Number(row.level);
    if (Number.isFinite(level) && str(row.name)) columnNames[level] = str(row.name);
  }

  const switchgears = (scopes || []).map(entry => {
    const scopeRow = entry.scopeRow || {};
    const switchgearType = str(scopeRow.swTypeName);
    const panelType = panelTypeFromSwitchgear(switchgearType);
    const properties = mapPanelToDeviceProperties(entry.panelRow, projectIdentityRow, resolve);
    delete properties.__designTemperature;
    const scopeName = str(entry.scopeName) || str(scopeRow.scopeName) || 'Switchgear';
    return {
      scopeId: entry.scopeId,
      scopeName,
      switchgearType,
      panelType,
      cellCount: str(scopeRow.Cell_No),
      tag: str(scopeRow.TAG),
      device: { name: scopeName, type: panelType, properties },
      slotProperties: panelType === 'MV' ? MV_SLOT_PROPERTIES : LV_SLOT_PROPERTIES,
    };
  });

  return {
    project: {
      projectMainId: projectRow?.IDProjectMain ?? null,
      oeNumber: str(projectRow?.OENUM),
      projectName: str(projectRow?.Project_Name),
      projectNameFa: str(projectRow?.Project_Name_Fa),
      orderCategory: str(projectRow?.Order_Category),
      oeDate: str(projectRow?.OEDATE),
      projectExpert: str(projectRow?.Project_Expert_Label),
      technicalSupervisor: str(projectRow?.Technical_Supervisor_Label),
      technicalExpert: str(projectRow?.Technical_Expert_Label),
    },
    techSettings: mapProjectToTechSettings(projectIdentityRow, resolve),
    columnNames,
    revisions: (revisions || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b),
    switchgears,
  };
}

// ─── SQL ─────────────────────────────────────────────────────────────────────
// Every statement is a plain SELECT. Column names are exactly the ones the
// Eplanix EF model maps to, so the two apps read the same fields.
//
// The EPLAN label table holds a row per entry, so an ECODE relabelled over the
// years has several. Joining it directly multiplies every part row by that
// count — on a big project that turns a normal read into a runaway one, and
// duplicates the parts on every line. Both line queries therefore join the
// newest label per ECODE (MAX(id)) instead of the table itself.
export const SQL = {
  project: `
    SELECT IDProjectMain, OENUM, Project_Name, Project_Name_Fa, Order_Category,
           OEDATE, Project_Expert_Label, Technical_Supervisor_Label, Technical_Expert_Label
    FROM View_Project_Main
    WHERE IDProjectMain = ?`,

  scope: `
    SELECT vs.IDProjectMain, vs.IDProjectScope, vs.SW_Type, vs.Cell_No, vs.TAG,
           c.ENG_DES AS swTypeName
    FROM view_scope vs
    LEFT JOIN CODING_SECONDARY_GRP_TB c ON c.ID = vs.SW_Type
    WHERE vs.IDProjectMain = ? AND vs.IDProjectScope = ?
    LIMIT 1`,

  scopeName: `
    SELECT scopeName FROM View_draft
    WHERE Tablo_ID = ? AND scopeName IS NOT NULL AND scopeName <> ''
    LIMIT 1`,

  panel: `
    SELECT * FROM technical_panel_identity
    WHERE IDProjectMain = ? AND IDProjectScope = ?
    ORDER BY Revision DESC, Date_Created DESC
    LIMIT 1`,

  projectIdentity: `
    SELECT * FROM technical_project_identity_
    WHERE IDProjectMain = ?
    ORDER BY Revision DESC, Date_Created DESC
    LIMIT 1`,

  lines: `
    SELECT d.ID AS draftId, d.scopeName, d.bus_section, d.feeder_no, d.wiring_type,
           d.rating_power, d.flc, d.tag, d.Designation, d.Module, d.Size, d.sfd_hfd,
           d.cable_size, d.cb_rating, d.contactor_rating, d.overLoad_rating,
           d.module_type, d.templateName, d.ordering,
           e.equipment, e.label, e.SCODE, e.SEC_DES, e.ENG_DES, e.SHR_DES,
           e.priority, e.QTY, e.Ecode,
           t.lable AS tlabel
    FROM View_draft d
    LEFT JOIN View_draft_Equipment e ON e.draftId = d.ID
    LEFT JOIN (
      SELECT l.ECODE, l.lable
      FROM Technical_draft_lable_eplan_TB l
      JOIN (SELECT ECODE, MAX(id) AS id FROM Technical_draft_lable_eplan_TB GROUP BY ECODE) m
        ON m.ECODE = l.ECODE AND m.id = l.id
    ) t ON t.ECODE = e.Ecode
    WHERE d.Project_ID = ? AND d.Tablo_ID = ? AND d.revision = ?
    ORDER BY d.ordering, d.ID, e.equipment, e.priority`,

  columns: `
    SELECT level, name FROM View_draft_column
    WHERE Project_ID = ?`,

  // Every switchgear of a project at one revision, in one read. Same columns
  // as `lines`, plus the switchgear the row belongs to.
  linesForRevision: `
    SELECT d.Tablo_ID AS tabloId,
           d.ID AS draftId, d.scopeName, d.bus_section, d.feeder_no, d.wiring_type,
           d.rating_power, d.flc, d.tag, d.Designation, d.Module, d.Size, d.sfd_hfd,
           d.cable_size, d.cb_rating, d.contactor_rating, d.overLoad_rating,
           d.module_type, d.templateName, d.ordering,
           e.equipment, e.label, e.SCODE, e.SEC_DES, e.ENG_DES, e.SHR_DES,
           e.priority, e.QTY, e.Ecode,
           t.lable AS tlabel
    FROM View_draft d
    LEFT JOIN View_draft_Equipment e ON e.draftId = d.ID
    LEFT JOIN (
      SELECT l.ECODE, l.lable
      FROM Technical_draft_lable_eplan_TB l
      JOIN (SELECT ECODE, MAX(id) AS id FROM Technical_draft_lable_eplan_TB GROUP BY ECODE) m
        ON m.ECODE = l.ECODE AND m.id = l.id
    ) t ON t.ECODE = e.Ecode
    WHERE d.Project_ID = ? AND d.revision = ?
    ORDER BY d.Tablo_ID, d.ordering, d.ID, e.equipment, e.priority`,

  // Every revision the project has, across all its switchgears.
  projectRevisions: `
    SELECT DISTINCT revision AS value
    FROM View_draft
    WHERE Project_ID = ? AND revision IS NOT NULL
    ORDER BY revision`,

  // Its switchgears, as the drafts name them.
  projectScopes: `
    SELECT DISTINCT Tablo_ID AS scopeId, scopeName
    FROM View_draft
    WHERE Project_ID = ? AND scopeName IS NOT NULL AND scopeName <> ''
    ORDER BY scopeName`,

  // Every switchgear of a project with its type and cell count, in one read
  // instead of one read per switchgear.
  projectScopeDetails: `
    SELECT vs.IDProjectScope AS scopeId, vs.SW_Type, vs.Cell_No, vs.TAG,
           c.ENG_DES AS swTypeName
    FROM view_scope vs
    LEFT JOIN CODING_SECONDARY_GRP_TB c ON c.ID = vs.SW_Type
    WHERE vs.IDProjectMain = ?`,

  // How big a project is, before deciding to read it: drafts per revision and
  // the parts on them.
  statsRevisions: `
    SELECT revision, COUNT(*) AS drafts
    FROM View_draft
    WHERE Project_ID = ?
    GROUP BY revision
    ORDER BY revision`,

  statsParts: `
    SELECT COUNT(*) AS parts
    FROM View_draft d
    JOIN View_draft_Equipment e ON e.draftId = d.ID
    WHERE d.Project_ID = ?`,

  // The three pickers, straight from Eplanix's GetScopes / GetRevisions.
  projectList: `
    SELECT IDProjectMain AS value,
           COALESCE(OENUM, '') AS code,
           COALESCE(Project_Name, '') AS name,
           CONCAT(COALESCE(OENUM, ''), ' ', COALESCE(Project_Name, '')) AS text
    FROM View_Project_Main
    ORDER BY Project_Name`,

  scopeList: `
    SELECT DISTINCT Tablo_ID AS value, scopeName AS text
    FROM View_draft
    WHERE Project_ID = ? AND scopeName IS NOT NULL AND scopeName <> ''
    ORDER BY scopeName`,

  revisionList: `
    SELECT DISTINCT revision AS value, revision AS text
    FROM View_draft
    WHERE Tablo_ID = ? AND revision IS NOT NULL
    ORDER BY revision`,
};

const TPMS_QUERY_TIMEOUT_MS = Number(process.env.TPMS_QUERY_TIMEOUT_MS || 60000);

// mysql2's pool has no default query timeout (see mysqlConfig in server.js),
// so a stuck TPMS query would otherwise hold one of the 10 pool connections
// indefinitely, starving every other request. Wrapping execute/query here —
// rather than editing each call site below — puts a bound on every one of
// them at once.
//
// The timeout alone still leaves the caller waiting the full minute for a
// failure that is knowable in milliseconds. A pooled socket to TPMS can be
// dead on arrival — dropped in transit while idle, with nothing on either end
// told about it (see the keepalive note on mysqlConfig in server.js) — and
// mysql2 will happily hand it over, at which point the query goes nowhere and
// the request burns the whole TPMS_QUERY_TIMEOUT_MS before 500ing. Every
// retry draws another socket from the same pool and does the same thing.
//
// So check the connection is alive before trusting it with a query. On a
// healthy LAN connection the ping is a sub-millisecond round-trip; on a dead
// one it fails in MYSQL_PING_TIMEOUT_MS and the socket is destroyed rather
// than released, which takes it out of the pool for good and lets the next
// attempt dial a fresh one. That turns a hard 500 into a recovery the caller
// never sees.
async function liveConnection(pool, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    // Outside the try on purpose: a getConnection() failure means the host
    // itself is unreachable, which retrying here would only slow down.
    const conn = await pool.getConnection();
    try {
      await deadline(conn.ping(), MYSQL_PING_TIMEOUT_MS, 'TPMS ping');
      return conn;
    } catch (err) {
      lastErr = err;
      try { conn.destroy(); } catch { /* already gone */ }
      console.warn(`⚠️ TPMS: discarded a dead pooled connection (${err.message})`);
    }
  }
  throw lastErr ?? new Error('no usable TPMS connection');
}

function withQueryTimeout(pool) {
  const wrapSql = sql => (typeof sql === 'string' ? { sql, timeout: TPMS_QUERY_TIMEOUT_MS } : sql);
  const run = method => async (sql, params) => {
    const conn = await liveConnection(pool);
    let fatal = false;
    try {
      return await conn[method](wrapSql(sql), params);
    } catch (err) {
      // A query timeout is fatal in mysql2's eyes — it cannot cancel the
      // statement server-side, so the socket is left out of step with the
      // protocol and must not be reused.
      fatal = Boolean(err && err.fatal);
      throw err;
    } finally {
      if (fatal) { try { conn.destroy(); } catch { /* already gone */ } }
      else conn.release();
    }
  };
  return { execute: run('execute'), query: run('query') };
}

// Registers the TPMS routes. `getPool` returns the shared mysql2 pool.
export function registerTpmsImportRoutes(app, getPool) {
  // The three pickers. They used to query table and column names that don't
  // exist in TPMS (ViewScopes/IdScope/ViewRevisions…), which are the C# model's
  // property names rather than the database's; these are the real ones.
  const listRoute = (path, sql, paramFrom) => {
    app.get(path, async (req, res) => {
      try {
        const pool = withQueryTimeout(await getPool());
        const params = paramFrom ? [paramFrom(req)] : [];
        const [rows] = await pool.execute(sql, params);
        res.json({ success: true, count: rows.length, items: rows, projects: rows, scopes: rows, revisions: rows });
      } catch (err) {
        console.error(`❌ Error in ${path}:`, err.message);
        res.status(500).json({ success: false, error: err.message, items: [], projects: [], scopes: [], revisions: [] });
      }
    });
  };

  listRoute('/api/tpms/projects', SQL.projectList);
  listRoute('/api/tpms/scopes/:projectId', SQL.scopeList, req => Number(req.params.projectId));
  listRoute('/api/tpms/revisions/:scopeId', SQL.revisionList, req => Number(req.params.scopeId));

  // ── The whole project ──────────────────────────────────────────────────
  // Everything about a project except its feeder lines: used when a project is
  // opened from TPMS, where every switchgear comes in at once rather than one
  // at a time.
  app.get('/api/tpms/project/:projectId', async (req, res) => {
    const projectId = Number(req.params.projectId);
    if (!Number.isFinite(projectId)) {
      return res.status(400).json({ success: false, error: 'projectId is required' });
    }
    try {
      const started = Date.now();
      const pool = withQueryTimeout(await getPool());
      const one = async (sql, params) => (await pool.execute(sql, params))[0][0] || null;
      const many = async (sql, params) => (await pool.execute(sql, params))[0];

      const [projectRow, projectIdentityRow, scopeRows, revisionRows, columnRows] =
        await Promise.all([
          one(SQL.project, [projectId]),
          one(SQL.projectIdentity, [projectId]),
          many(SQL.projectScopes, [projectId]),
          many(SQL.projectRevisions, [projectId]),
          many(SQL.columns, [projectId]),
        ]);

      if (!projectRow) {
        return res.status(404).json({ success: false, error: 'No such project in TPMS' });
      }

      // The header used to read technical_panel_identity for every switchgear
      // — two round trips each, all inside this one request. On a project
      // with dozens of panels that is the request that never comes back. The
      // switchgears now come from a single read, and the panel specification
      // is fetched per switchgear on its own route (see below), so no single
      // request grows with the size of the project.
      const [detailRows] = await pool.query(SQL.projectScopeDetails, [projectId]);
      const details = new Map(detailRows.map(r => [Number(r.scopeId), r]));
      const named = new Map(scopeRows.map(r => [Number(r.scopeId), r.scopeName]));
      const ids = new Set([...details.keys(), ...named.keys()]);

      const scopes = [...ids].map(id => {
        const detail = details.get(id) || {};
        return {
          scopeId: id,
          scopeName: str(named.get(id)) || str(detail.TAG) || `Switchgear ${id}`,
          scopeRow: { ...detail, IDProjectScope: id },
          panelRow: null,          // read per switchgear, on its own route
        };
      }).sort((a, b) => a.scopeName.localeCompare(b.scopeName));

      let propertyTitles = {};
      const titleIds = collectPropertyIds(null, projectIdentityRow);
      if (titleIds.length > 0) {
        const rows = await many(
          `SELECT ID, Title FROM TECHNICAL_PROPERTIES WHERE ID IN (${titleIds.map(() => '?').join(',')})`,
          titleIds,
        );
        propertyTitles = Object.fromEntries(rows.map(r => [Number(r.ID), r.Title]));
      }

      const payload = buildProjectPayload({
        projectRow, projectIdentityRow, propertyTitles, scopes, columnRows,
        revisions: revisionRows.map(r => r.value),
      });
      console.log(`✅ TPMS project ${projectId}: ${payload.switchgears.length} switchgear(s), ` +
        `revisions ${payload.revisions.join(', ') || '—'} in ${Date.now() - started} ms`);
      res.json({ success: true, ...payload });
    } catch (err) {
      console.error('❌ Error in /api/tpms/project:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // The panel specification of one switchgear — technical_panel_identity plus
  // the TECHNICAL_PROPERTIES titles behind its coded fields. Its own route so
  // that reading a project never grows into one huge request.
  app.get('/api/tpms/project/:projectId/panel/:scopeId', async (req, res) => {
    const projectId = Number(req.params.projectId);
    const scopeId = Number(req.params.scopeId);
    if (!Number.isFinite(projectId) || !Number.isFinite(scopeId)) {
      return res.status(400).json({ success: false, error: 'projectId and scopeId are required' });
    }
    try {
      const pool = withQueryTimeout(await getPool());
      const one = async (sql, params) => (await pool.execute(sql, params))[0][0] || null;
      const [panelRow, projectIdentityRow] = await Promise.all([
        one(SQL.panel, [projectId, scopeId]),
        one(SQL.projectIdentity, [projectId]),
      ]);

      let propertyTitles = {};
      const ids = collectPropertyIds(panelRow, projectIdentityRow);
      if (ids.length > 0) {
        const [rows] = await pool.query(
          `SELECT ID, Title FROM TECHNICAL_PROPERTIES WHERE ID IN (${ids.map(() => '?').join(',')})`,
          ids,
        );
        propertyTitles = Object.fromEntries(rows.map(r => [Number(r.ID), r.Title]));
      }

      const resolve = makeTitleResolver(propertyTitles);
      const properties = mapPanelToDeviceProperties(panelRow, projectIdentityRow, resolve);
      delete properties.__designTemperature;
      res.json({ success: true, scopeId, found: !!panelRow, properties });
    } catch (err) {
      console.error('❌ Error in /api/tpms/project/panel:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // How big a project is, and whether TPMS answers at all — the reading behind
  // the dialog's "Check this project" button, so a project that will not open
  // can be described instead of just failing.
  app.get('/api/tpms/project/:projectId/stats', async (req, res) => {
    const projectId = Number(req.params.projectId);
    if (!Number.isFinite(projectId)) {
      return res.status(400).json({ success: false, error: 'projectId is required' });
    }
    const timings = {};
    const time = async (name, fn) => {
      const t = Date.now();
      try { return await fn(); } finally { timings[name] = Date.now() - t; }
    };
    try {
      const pool = withQueryTimeout(await getPool());
      const projectRow = await time('project', async () =>
        (await pool.execute(SQL.project, [projectId]))[0][0] || null);
      if (!projectRow) return res.status(404).json({ success: false, error: 'No such project in TPMS' });

      const scopes = await time('switchgears', async () =>
        (await pool.query(SQL.projectScopeDetails, [projectId]))[0]);
      const perRevision = await time('revisions', async () =>
        (await pool.query(SQL.statsRevisions, [projectId]))[0]);
      const parts = await time('parts', async () =>
        (await pool.query(SQL.statsParts, [projectId]))[0][0]?.parts ?? 0);

      const drafts = perRevision.reduce((n, r) => n + Number(r.drafts || 0), 0);
      console.log(`ℹ️  TPMS project ${projectId} stats: ${scopes.length} switchgear(s), ` +
        `${perRevision.length} revision(s), ${drafts} draft(s), ${parts} part row(s) ` +
        `(${JSON.stringify(timings)} ms)`);
      res.json({
        success: true,
        projectMainId: projectId,
        oeNumber: str(projectRow.OENUM),
        projectName: str(projectRow.Project_Name),
        switchgears: scopes.length,
        revisions: perRevision.map(r => ({ revision: Number(r.revision), drafts: Number(r.drafts) })),
        drafts,
        parts: Number(parts),
        timings,
      });
    } catch (err) {
      console.error('❌ Error in /api/tpms/project/stats:', err.message);
      res.status(500).json({ success: false, error: err.message, timings });
    }
  });

  // One revision of a project, every switchgear in it — the feeder lines and
  // the parts on them. A project's revisions are read one by one so each
  // becomes a revision of its own on this side.
  app.get('/api/tpms/project/:projectId/revision/:revision', async (req, res) => {
    const projectId = Number(req.params.projectId);
    const revision = Number(req.params.revision);
    // One switchgear at a time when `scopeId` is given. A project with dozens
    // of switchgears and a decade of revisions is far too much for a single
    // read — it is the request that times out on the way through nginx — so
    // the client walks it switchgear by switchgear and each read stays small.
    const scopeId = req.query.scopeId != null ? Number(req.query.scopeId) : null;
    if (!Number.isFinite(projectId) || !Number.isFinite(revision)) {
      return res.status(400).json({ success: false, error: 'projectId and revision are required' });
    }
    if (req.query.scopeId != null && !Number.isFinite(scopeId)) {
      return res.status(400).json({ success: false, error: 'scopeId must be a number' });
    }
    try {
      const pool = withQueryTimeout(await getPool());
      const started = Date.now();
      const [joinedRows] = scopeId != null
        ? await pool.query(SQL.lines, [projectId, scopeId, revision])
        : await pool.query(SQL.linesForRevision, [projectId, revision]);
      if (scopeId != null) {
        for (const row of joinedRows) if (row.tabloId == null) row.tabloId = scopeId;
      }
      const switchgears = buildLinesByScope(joinedRows).map(entry => ({
        ...entry,
        counts: {
          lines: entry.lines.length,
          parts: entry.lines.reduce(
            (sum, l) => sum + Object.values(l.parts).reduce((n, p) => n + p.length, 0), 0),
        },
      }));
      console.log(`✅ TPMS project ${projectId} rev ${revision}` +
        `${scopeId != null ? ` scope ${scopeId}` : ''}: ${switchgears.length} switchgear(s), ` +
        `${switchgears.reduce((n, s) => n + s.lines.length, 0)} lines, ` +
        `${joinedRows.length} row(s) in ${Date.now() - started} ms`);
      res.json({ success: true, revision, scopeId, switchgears });
    } catch (err) {
      console.error('❌ Error in /api/tpms/project/revision:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/tpms/import', async (req, res) => {
    const projectId = Number(req.query.projectId);
    const scopeId = Number(req.query.scopeId);
    const revisionId = Number(req.query.revisionId);

    if (!Number.isFinite(projectId) || !Number.isFinite(scopeId) || !Number.isFinite(revisionId)) {
      return res.status(400).json({
        success: false,
        error: 'projectId, scopeId and revisionId are required',
      });
    }

    try {
      const pool = withQueryTimeout(await getPool());
      const one = async (sql, params) => (await pool.execute(sql, params))[0][0] || null;
      const many = async (sql, params) => (await pool.execute(sql, params))[0];

      const [projectRow, scopeRow, panelRow, projectIdentityRow, joinedRows, columnRows] =
        await Promise.all([
          one(SQL.project, [projectId]),
          one(SQL.scope, [projectId, scopeId]),
          one(SQL.panel, [projectId, scopeId]),
          one(SQL.projectIdentity, [projectId]),
          many(SQL.lines, [projectId, scopeId, revisionId]),
          many(SQL.columns, [projectId]),
        ]);

      if (scopeRow && !scopeRow.scopeName) {
        const named = await one(SQL.scopeName, [scopeId]);
        if (named) scopeRow.scopeName = named.scopeName;
      }

      const propertyIds = collectPropertyIds(panelRow, projectIdentityRow);
      let propertyTitles = {};
      if (propertyIds.length > 0) {
        const placeholders = propertyIds.map(() => '?').join(',');
        const rows = await many(
          `SELECT ID, Title FROM TECHNICAL_PROPERTIES WHERE ID IN (${placeholders})`,
          propertyIds,
        );
        propertyTitles = Object.fromEntries(rows.map(r => [Number(r.ID), r.Title]));
      }

      const payload = buildImportPayload({
        projectRow, scopeRow, panelRow, projectIdentityRow, propertyTitles,
        joinedRows, columnRows, revisionId,
      });

      console.log(`✅ TPMS import: project ${projectId} / scope ${scopeId} / rev ${revisionId} — ` +
        `${payload.counts.lines} lines, ${payload.counts.parts} parts`);
      res.json({ success: true, ...payload });
    } catch (err) {
      console.error('❌ Error in /api/tpms/import:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });
}
