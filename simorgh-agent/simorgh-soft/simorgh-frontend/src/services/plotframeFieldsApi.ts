// Plotframe "User supplementary field" values (Send to EPLAN tab) — stored
// in this app's own backend/Mongo, per project + switchgear + drawing type.
// See simorgh-backend/plotframeFields.js.

const API_BASE_URL = `${(import.meta as any).env?.VITE_API_URL || ''}/api`;

export type PlotframeDrawingType = 'SLD' | 'OLD';

export const plotframeFieldsApi = {
  async get(projectId: string, equipmentId: string, drawingType: PlotframeDrawingType): Promise<Record<string, string>> {
    const params = new URLSearchParams({ projectId, equipmentId, drawingType });
    const response = await fetch(`${API_BASE_URL}/eplan/plotframe-fields?${params}`);
    if (!response.ok) throw new Error('Could not read the plotframe supplementary fields');
    const body = await response.json();
    return body.fields || {};
  },

  async save(
    projectId: string, equipmentId: string, drawingType: PlotframeDrawingType, fields: Record<string, string>,
  ): Promise<void> {
    const response = await fetch(`${API_BASE_URL}/eplan/plotframe-fields`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId, equipmentId, drawingType, fields }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || 'Could not save the plotframe supplementary fields');
    }
  },
};
