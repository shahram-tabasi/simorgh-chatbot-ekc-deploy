// src/components/TemplateCreation/TemplateGraphicPage.tsx
//
// One template's graphic, large, in a browser tab of its own — opened from the
// template screen's graphic panel or its window, the way Project Templates
// opens its table.
//
// It does not hold the project. The tab the project is open in announces the
// templates, the project's own symbols and the kept drawing edits on a
// BroadcastChannel (see ProjectContext), so a part changed there redraws here
// at once; and a Save here is sent back to that tab, which applies it through
// the same edit gate as every other change — a TPMS project that is still
// read-only stays read-only from here too. With that tab closed the template
// is read from the server and shown read-only.

import React, { useEffect, useRef, useState } from 'react';
import type { ProjectData, SymbolArtOverride, TemplateItem, DrawingEdits } from '../../types/project';
import { TemplateGraphicEditor } from '../SimorghDraw/TemplateGraphicEditor';
import { useSymbolLibrary } from '../../utils/cad/useSymbols';
import { TIERS } from '../../utils/tiers';
import { TEMPLATE_GRAPHIC_CHANNEL } from '../../utils/templateGraphicChannel';


export interface TemplateGraphicState {
  type: 'state';
  projectId: string;
  templates: ProjectData['templates'];
  symbolOverrides?: Record<string, SymbolArtOverride>;
  drawingEdits?: DrawingEdits;
  editable: boolean;
}

const API = `${(import.meta as { env?: Record<string, string> }).env?.VITE_API_URL || ''}/api`;

const findTemplate = (templates: ProjectData['templates'] | undefined, id: string): TemplateItem | undefined => {
  for (const tier of TIERS) {
    const hit = (templates?.[tier] ?? []).find(t => t.id === id);
    if (hit) return hit;
  }
  return undefined;
};

export const TemplateGraphicPage: React.FC<{ projectId: string; templateId: string }> = ({ projectId, templateId }) => {
  const [state, setState] = useState<TemplateGraphicState | null>(null);
  const [live, setLive] = useState(false);
  const channel = useRef<BroadcastChannel | null>(null);
  const lastLive = useRef(0);

  useEffect(() => {
    if (typeof BroadcastChannel !== 'undefined') {
      const c = new BroadcastChannel(TEMPLATE_GRAPHIC_CHANNEL);
      channel.current = c;
      c.onmessage = e => {
        const m = e.data as TemplateGraphicState;
        if (m?.type !== 'state' || m.projectId !== projectId) return;
        lastLive.current = Date.now();
        setLive(true);
        setState(m);
      };
      c.postMessage({ type: 'hello', projectId });
    }
    // With the project's tab closed: the template from the server, read-only.
    const fromServer = async () => {
      if (Date.now() - lastLive.current < 20_000) return;
      if (!/^[0-9a-f]{24}$/i.test(projectId)) return;
      try {
        const r = await fetch(`${API}/projects/${projectId}`);
        if (!r.ok) return;
        const p = await r.json();
        if (Date.now() - lastLive.current < 20_000) return;
        setLive(false);
        setState({
          type: 'state', projectId, templates: p.templates,
          symbolOverrides: p.symbolOverrides, drawingEdits: p.drawingEdits, editable: false,
        });
      } catch { /* tried again in a moment */ }
    };
    const first = setTimeout(fromServer, 1500);
    const every = setInterval(fromServer, 15_000);
    return () => { channel.current?.close(); channel.current = null; clearTimeout(first); clearInterval(every); };
  }, [projectId]);

  // This job's own symbols, so the graphic is drawn exactly as in the app.
  useSymbolLibrary(state?.symbolOverrides);

  const template = findTemplate(state?.templates, templateId);
  useEffect(() => {
    if (template?.name) document.title = `${template.name} — template graphic`;
  }, [template?.name]);

  if (!state) {
    return <div className="h-screen flex items-center justify-center text-sm text-gray-500">
      Waiting for the project — keep it open in Simorgh Soft in another tab.
    </div>;
  }
  if (!template) {
    return <div className="h-screen flex items-center justify-center text-sm text-gray-500">
      This template is not in the project any more.
    </div>;
  }

  return (
    <>
      {!live && (
        <div className="fixed top-0 inset-x-0 z-10 bg-amber-100 text-amber-900 text-xs px-3 py-1 text-center">
          The project is not open in another tab — showing the saved copy, read-only.
        </div>
      )}
      <TemplateGraphicEditor
        page
        template={template}
        tier={template.type}
        savedEdits={state.drawingEdits}
        canEdit={live && state.editable}
        onSaveEdits={next => channel.current?.postMessage({ type: 'save', projectId, edits: next })}
        onClose={() => window.close()}
      />
    </>
  );
};
