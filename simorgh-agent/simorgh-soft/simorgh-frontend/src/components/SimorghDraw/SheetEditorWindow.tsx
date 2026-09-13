import React from 'react';
import { XIcon } from 'lucide-react';
import { DrawingEdits } from '../../types/project';
import { PaperChoice } from '../../utils/cad/paper';
import { DrawingEditor, EditorSheet } from './DrawingEditor';

// The sheets of a switchgear, opened for editing.
//
// A window rather than a tab: the drawing is looked at from the single line and
// edited there, so it opens over what it belongs to and closes back onto it.
// Full screen is inside, on the editor's own bar, because that is where a hand
// already is when it wants the room.

interface Props {
  title: string;
  note?: string;
  sheets: EditorSheet[];
  fileBase: string;
  titleBlock: string[];
  paper?: PaperChoice;
  savedEdits?: DrawingEdits;
  onSaveEdits?: (next: DrawingEdits) => void;
  canEdit?: boolean;
  /** Extra buttons in the header, before Close — e.g. "Send to EPLAN" on the
   *  single-line editor. Generic on purpose: this window opens for symbol and
   *  template graphics too, which have nothing to send. */
  headerActions?: React.ReactNode;
  onClose: () => void;
}

export const SheetEditorWindow: React.FC<Props> = ({
  title, note, sheets, fileBase, titleBlock, paper, savedEdits, onSaveEdits,
  canEdit = true, headerActions, onClose,
}) => (
  <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-[210]" onClick={onClose}>
    <div
      className="bg-white rounded-lg shadow-2xl w-[1320px] max-w-[97vw] max-h-[95vh] flex flex-col overflow-hidden"
      onClick={e => e.stopPropagation()}
    >
      <div className="bg-slate-700 text-white px-5 py-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold truncate">{title}</h2>
          {note && <p className="text-[11px] text-slate-200">{note}</p>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {headerActions}
          <button onClick={onClose} className="p-1 rounded hover:bg-white/20" title="Close">
            <XIcon className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-3 bg-gray-100">
        <DrawingEditor
          sheets={sheets}
          fileBase={fileBase}
          titleBlock={titleBlock}
          paper={paper}
          savedEdits={savedEdits}
          onSaveEdits={onSaveEdits}
          canEdit={canEdit}
        />
      </div>
    </div>
  </div>
);
