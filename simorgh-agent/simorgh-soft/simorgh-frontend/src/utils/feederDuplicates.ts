// src/utils/feederDuplicates.ts
//
// FEEDER NO. identifies a line within its switchgear, so two rows of the same
// equipment must never carry the same one. Device Selection stays out of the
// way while the user is working; the check runs when they leave the tab, and
// what it finds is what the warning dialog lists and lets them fix.
import { ProjectData } from '../types/project';

export interface DuplicateRowRef {
  rowId: string;
  rowNumber: number;
  feederNo: string;
  templateName: string;
  busSection: string;
  description: string;
}

export interface DuplicateGroup {
  equipmentId: string;
  equipmentName: string;
  equipmentType: 'LV' | 'MV' | 'HV';
  feederNo: string;
  rows: DuplicateRowRef[];
}

// Blank feeder numbers are not duplicates — a row simply hasn't been filled in
// yet, and nagging about those would fire on every half-finished table.
export function findFeederDuplicates(data: ProjectData): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];

  for (const eq of data.equipments ?? []) {
    const byFeeder = new Map<string, DuplicateRowRef[]>();
    for (const row of eq.devices ?? []) {
      const feeder = String(row.feederNo ?? '').trim();
      if (!feeder) continue;
      const key = feeder.toLowerCase();
      const ref: DuplicateRowRef = {
        rowId: row.id,
        rowNumber: row.rowNumber,
        feederNo: feeder,
        templateName: String(row.templateName ?? ''),
        busSection: String(row.busSection ?? ''),
        description: String(row.description ?? ''),
      };
      const list = byFeeder.get(key);
      if (list) list.push(ref); else byFeeder.set(key, [ref]);
    }

    for (const rows of byFeeder.values()) {
      if (rows.length < 2) continue;
      groups.push({
        equipmentId: eq.id,
        equipmentName: eq.name,
        equipmentType: eq.type,
        feederNo: rows[0].feederNo,
        rows,
      });
    }
  }

  return groups.sort((a, b) =>
    a.equipmentName.localeCompare(b.equipmentName) || a.feederNo.localeCompare(b.feederNo));
}

export function countDuplicateRows(groups: DuplicateGroup[]): number {
  return groups.reduce((sum, g) => sum + g.rows.length, 0);
}
