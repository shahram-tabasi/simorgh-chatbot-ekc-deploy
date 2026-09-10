import React from 'react';
import { LockIcon, XIcon } from 'lucide-react';
import { RevisionLockNotice } from '../../context/ProjectContext';

interface RevisionLockedModalProps {
  notice: RevisionLockNotice;
  onClose: () => void;
}

// Shown whenever an edit is refused. Two reasons: the revision is no longer
// the latest one (it froze the moment a newer revision was created, and the
// newer ones have to be deleted first), or TPMS still owns the project — it is
// re-read from TPMS on every open, so an edit here would be overwritten, and
// the way to start editing is to raise a revision.
export const RevisionLockedModal: React.FC<RevisionLockedModalProps> = ({ notice, onClose }) => {
  if (notice.kind === 'tpms') {
    const next = notice.nextRevisionNumber;
    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[100]">
        <div className="bg-white rounded-lg shadow-2xl w-[540px] flex flex-col">
          <div className="flex items-start justify-between px-6 py-4 border-b bg-purple-50 rounded-t-lg">
            <div className="flex items-start gap-3">
              <LockIcon className="w-6 h-6 text-purple-600 flex-shrink-0 mt-0.5" />
              <div>
                <h3 className="font-semibold text-lg text-purple-900">This project is read from TPMS</h3>
                <p className="text-sm text-purple-800 mt-0.5">Changes were not applied.</p>
              </div>
            </div>
            <button className="p-1 hover:bg-purple-100 rounded" onClick={onClose}>
              <XIcon className="w-5 h-5 text-purple-600" />
            </button>
          </div>

          <div className="px-6 py-4 space-y-3">
            <p className="text-sm text-gray-700">
              TPMS is the master of this project: it is read again on every open, so edits made here
              would be overwritten. Raise a revision{next ? ` (REV ${next})` : ''} — Design Suite then owns
              the project, syncing stops, and it becomes editable.
            </p>
            <p className="text-xs text-gray-500">
              New revisions are created from the <strong>REV</strong> dropdown in the header, or the
              button on the read-only bar.
            </p>
          </div>

          <div className="flex justify-end px-6 py-4 border-t bg-gray-50">
            <button className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700" onClick={onClose}>
              OK
            </button>
          </div>
        </div>
      </div>
    );
  }

  const blocking = notice.blockingRevisionNumbers;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-[100]">
      <div className="bg-white rounded-lg shadow-2xl w-[520px] flex flex-col">
        <div className="flex items-start justify-between px-6 py-4 border-b bg-amber-50 rounded-t-lg">
          <div className="flex items-start gap-3">
            <LockIcon className="w-6 h-6 text-amber-600 flex-shrink-0 mt-0.5" />
            <div>
              <h3 className="font-semibold text-lg text-amber-900">
                REV {notice.currentRevisionNumber} is locked
              </h3>
              <p className="text-sm text-amber-800 mt-0.5">Changes were not applied.</p>
            </div>
          </div>
          <button className="p-1 hover:bg-amber-100 rounded" onClick={onClose}>
            <XIcon className="w-5 h-5 text-amber-600" />
          </button>
        </div>

        <div className="px-6 py-4 space-y-3">
          <p className="text-sm text-gray-700">
            {blocking.length > 0
              ? `A newer revision (${blocking.map(n => `REV ${n}`).join(', ')}) already exists, so REV ${notice.currentRevisionNumber} is read-only. Delete the newer revision(s) first to edit it again.`
              : `A newer revision already exists, so REV ${notice.currentRevisionNumber} is read-only. Delete the newer revision(s) first to edit it again.`}
          </p>
          <p className="text-xs text-gray-500">
            Revisions are deleted from the <strong>REV</strong> dropdown in the header (password required).
          </p>
        </div>

        <div className="flex justify-end px-6 py-4 border-t bg-gray-50">
          <button
            className="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700"
            onClick={onClose}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
};
