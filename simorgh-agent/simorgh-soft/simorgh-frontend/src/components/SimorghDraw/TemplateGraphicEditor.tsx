import React, { useMemo } from 'react';
import { XIcon } from 'lucide-react';
import { DrawingEdits } from '../../types/project';
import { EplanSymbolMap, TemplateLike, buildTemplateSvg } from '../../utils/eplanSingleLine';
import { drawingFromSvg } from '../../utils/cad/fromSvg';
import { fingerprint } from '../../utils/cad/edit';
import { DrawingEditor, EditorSheet } from './DrawingEditor';

// The whole template, in one window.
//
// Not a symbol and not a part: the cell a template stands for, put together by
// the rule the sheet already uses — the devices that carry power in series down
// the line, the instruments hanging off it in parallel from the transformer
// that feeds them, the shunts beside it with the earth under them.
//
// It is the same drawing that will appear on a feeder built from this template,
// which is the point of looking at it here: what is wrong with the template is
// visible before a switchgear is built on it.

interface Props {
  template: TemplateLike & { id: string };
  tier: 'LV' | 'MV' | 'HV';
  /** What EPLAN says the parts are, when it has been asked. */
  symbols?: EplanSymbolMap;
  /** Edits already kept with the project. */
  savedEdits?: DrawingEdits;
  onSaveEdits?: (next: DrawingEdits) => void;
  canEdit?: boolean;
  onClose: () => void;
}

/** Where a template's own drawing is kept in the project. */
export const templateSheetKey = (templateId: string) => `template#${templateId}`;

export const TemplateGraphicEditor: React.FC<Props> = ({
  template, tier, symbols, savedEdits, onSaveEdits, canEdit = true, onClose,
}) => {
  const built = useMemo(
    () => buildTemplateSvg(template, tier, symbols), [template, tier, symbols]);

  const sheets = useMemo<EditorSheet[]>(() => [{
    name: template.name || 'Template',
    drawing: drawingFromSvg(built.svg, template.name || 'Template'),
    key: templateSheetKey(template.id),
    drawnAs: fingerprint(built.svg),
  }], [built.svg, template.id, template.name]);

  return (
    <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-[210]" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-2xl w-[1220px] max-w-[96vw] h-[94vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="bg-slate-700 text-white px-5 py-3 flex items-center justify-between">
          <div className="min-w-0">
            <h2 className="text-base font-semibold truncate">{template.name || 'Template'}</h2>
            <p className="text-[11px] text-slate-200">
              {tier} · {built.devices} device{built.devices === 1 ? '' : 's'} ·
              {' '}drawn the way a feeder built on this template will be
            </p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-white/20">
            <XIcon className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 bg-gray-100">
          <DrawingEditor
            embedded
            sheets={sheets}
            fileBase={`template_${template.name || template.id}`}
            titleBlock={[template.name || 'Template', `Simorgh Draw — ${tier} template`]}
            mmPerUnit={1}
            savedEdits={savedEdits}
            onSaveEdits={onSaveEdits}
            canEdit={canEdit}
          />
        </div>

        <div className="px-5 py-2 border-t bg-gray-50 text-[11px] text-gray-500">
          The cell is put together from the parts by the same series-and-parallel rule the
          sheets use. Edits are kept with the project and can be sent out as DXF or PDF;
          the sheets themselves still draw from the parts.
        </div>
      </div>
    </div>
  );
};
