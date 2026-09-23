// src/utils/cascadeDelete.ts
//
// Deleting something must delete it EVERYWHERE it was used — a device removed
// from the Device Library must also disappear from the Device Selection tree
// and from every row it produced there; a deleted template must disappear
// from the rows that referenced it.
//
// The reverse never holds: removing an equipment from the project tree in
// Device Selection is only an arrangement change, so the Device Library entry
// it was created from stays untouched (see EquipmentTree's delete flow).
//
// These helpers only *compute* things: `find…Usage` reports where an item is
// referenced (so the UI can warn before deleting) and `remove…Everywhere`
// returns the ProjectData patch that performs the cascade.
import { ProjectData } from '../types/project';
import { type Tier, TIERS, emptyTiers } from './tiers';

export interface UsageEquipment {
  id: string;
  name: string;
  type: Tier;
  rowCount: number;
}

export interface UsageReport {
  equipments: UsageEquipment[];
  totalRows: number;
}

const EMPTY_USAGE: UsageReport = { equipments: [], totalRows: 0 };

// An equipment belongs to a library device when it carries its id. Equipment
// created before the id link existed is matched by name + tier instead, so
// older projects still cascade correctly.
export function isEquipmentFromLibraryItem(
  equipment: any,
  libItemId: string,
  libItemName: string,
  libItemType: Tier,
): boolean {
  const linkedId = equipment?.properties?.deviceLibraryItemId as string | undefined;
  if (linkedId) return linkedId === libItemId;
  return equipment?.type === libItemType && equipment?.name === libItemName;
}

// Where a Device Library entry is used across the project.
export function findDeviceLibraryUsage(
  data: ProjectData,
  libItemId: string,
  type: Tier,
): UsageReport {
  const libItem = (data.deviceLibrary?.[type] ?? []).find(d => d.id === libItemId);
  if (!libItem) return EMPTY_USAGE;

  const equipments = (data.equipments ?? [])
    .filter(eq => isEquipmentFromLibraryItem(eq, libItemId, libItem.name, type))
    .map(eq => ({
      id: eq.id,
      name: eq.name,
      type: eq.type,
      rowCount: (eq.devices ?? []).length,
    }));

  return {
    equipments,
    totalRows: equipments.reduce((sum, eq) => sum + eq.rowCount, 0),
  };
}

// Patch that removes a Device Library entry plus every equipment created from
// it — together with the device rows those equipments hold.
export function removeDeviceLibraryItemEverywhere(
  data: ProjectData,
  libItemId: string,
  type: Tier,
): Partial<ProjectData> {
  const library = data.deviceLibrary ?? emptyTiers();
  const usage = findDeviceLibraryUsage(data, libItemId, type);
  const removedEquipmentIds = new Set(usage.equipments.map(eq => eq.id));

  return {
    deviceLibrary: {
      ...library,
      [type]: (library[type] ?? []).filter(d => d.id !== libItemId),
    },
    equipments: (data.equipments ?? []).filter(eq => !removedEquipmentIds.has(eq.id)),
    devices: (data.devices ?? []).filter(d => !d.equipmentId || !removedEquipmentIds.has(d.equipmentId)),
  };
}

// Where a template is used across the project's equipment rows.
export function findTemplateUsage(data: ProjectData, templateId: string): UsageReport {
  const equipments = (data.equipments ?? [])
    .map(eq => ({
      id: eq.id,
      name: eq.name,
      type: eq.type,
      rowCount: (eq.devices ?? []).filter(row => row.templateId === templateId).length,
    }))
    .filter(eq => eq.rowCount > 0);

  return {
    equipments,
    totalRows: equipments.reduce((sum, eq) => sum + eq.rowCount, 0),
  };
}

// Patch that removes a template plus every device row built on it. Equipment
// itself is kept — only its rows for that template go away — and the
// remaining rows are renumbered so the table stays 1..n.
export function removeTemplateEverywhere(data: ProjectData, templateId: string): Partial<ProjectData> {
  const templates = { ...data.templates };
  for (const t of TIERS) {
    templates[t] = (templates[t] ?? []).filter(tmpl => tmpl.id !== templateId);
  }

  return {
    templates,
    equipments: (data.equipments ?? []).map(eq => ({
      ...eq,
      devices: (eq.devices ?? [])
        .filter(row => row.templateId !== templateId)
        .map((row, idx) => ({ ...row, rowNumber: idx + 1 })),
    })),
    devices: (data.devices ?? []).filter(d => d.templateId !== templateId),
  };
}

// One-line summary of a usage report, e.g. "2 equipment, 7 rows".
export function describeUsage(usage: UsageReport): string {
  const eqLabel  = `${usage.equipments.length} equipment`;
  const rowLabel = `${usage.totalRows} row${usage.totalRows === 1 ? '' : 's'}`;
  return `${eqLabel}, ${rowLabel}`;
}
