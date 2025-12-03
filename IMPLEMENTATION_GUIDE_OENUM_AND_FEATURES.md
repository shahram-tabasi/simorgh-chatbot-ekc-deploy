# Implementation Guide: OENUM Lookup, Context Menu, and Message Ordering

This guide provides step-by-step instructions for completing the chatbot upgrade with all requested features.

## ✅ Completed (Part 1)

### Backend: OENUM Lookup
- ✅ Added `get_project_by_oenum()` to `TPMSAuthService`
- ✅ Added `POST /api/auth/validate-project-by-oenum` endpoint
- ✅ Validates project existence and user permissions

---

## 🚧 Remaining Implementation

### Part 2: Update CreateProjectModal (Frontend)

**File**: `simorgh-agent/frontend/src/components/CreateProjectModal.tsx`

**Changes needed**:

```typescript
import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Plus, X, Loader, CheckCircle, AlertCircle } from 'lucide-react';
import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (idProjectMain: string, projectName: string, oenum: string, firstPageTitle: string) => void;
}

export default function CreateProjectModal({ isOpen, onClose, onCreate }: Props) {
  const [oenum, setOenum] = useState('');  // Field 1: OENUM
  const [projectName, setProjectName] = useState('');  // Field 2: Auto-filled
  const [idProjectMain, setIdProjectMain] = useState('');  // Hidden, from API
  const [firstPageName, setFirstPageName] = useState('New Page');  // Field 3
  const [isValidating, setIsValidating] = useState(false);
  const [isValidated, setIsValidated] = useState(false);
  const [error, setError] = useState('');

  const handleValidateOenum = async () => {
    if (!oenum.trim()) {
      setError('Please enter Project ID (OENUM)');
      return;
    }

    setIsValidating(true);
    setError('');

    try {
      const token = localStorage.getItem('simorgh_token');
      const response = await axios.post(
        `${API_BASE}/auth/validate-project-by-oenum`,
        { oenum: oenum.trim() },
        { headers: { 'Authorization': `Bearer ${token}` } }
      );

      // Auto-fill project name (read-only)
      setProjectName(response.data.project.project_name);
      setIdProjectMain(response.data.project.id_project_main);
      setIsValidated(true);
      setError('');
    } catch (err: any) {
      setIsValidated(false);
      if (err.response?.status === 404) {
        setError('Project not found with this OENUM');
      } else if (err.response?.status === 403) {
        setError('Access denied: You don\'t have permission for this project');
      } else {
        setError(err.response?.data?.detail || 'Validation failed');
      }
    } finally {
      setIsValidating(false);
    }
  };

  const handleSubmit = () => {
    if (!isValidated) {
      setError('Please validate the Project ID first');
      return;
    }

    if (!firstPageName.trim()) {
      setError('First Page Name cannot be empty');
      return;
    }

    // Pass ID, Name, OENUM, and Page Name to parent
    onCreate(idProjectMain, projectName, oenum, firstPageName.trim());

    // Reset form
    setOenum('');
    setProjectName('');
    setIdProjectMain('');
    setFirstPageName('New Page');
    setIsValidated(false);
    onClose();
  };

  const handleClose = () => {
    setOenum('');
    setProjectName('');
    setIdProjectMain('');
    setFirstPageName('New Page');
    setIsValidated(false);
    setError('');
    onClose();
  };

  if (!isOpen) return null;

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={handleClose}
        className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50"
      />

      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.9, opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
      >
        <div className="bg-gradient-to-br from-gray-900 to-black border border-white/20 rounded-2xl shadow-2xl w-full max-w-md p-8">
          <div className="flex items-center justify-between mb-8">
            <h2 className="text-2xl font-bold text-white flex items-center gap-3">
              <Plus className="w-8 h-8 text-emerald-400" />
              New Project
            </h2>
            <button onClick={handleClose} className="p-2 hover:bg-white/10 rounded-lg transition">
              <X className="w-6 h-6 text-gray-400" />
            </button>
          </div>

          <div className="space-y-6">
            {/* Field 1: Project ID (OENUM) */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Project ID (OENUM)
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={oenum}
                  onChange={(e) => {
                    setOenum(e.target.value);
                    setIsValidated(false);
                    setError('');
                  }}
                  placeholder="e.g., P-2024-001"
                  className="flex-1 px-4 py-3 bg-white/10 border border-white/20 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 transition"
                  autoFocus
                  disabled={isValidated || isValidating}
                />
                <button
                  onClick={handleValidateOenum}
                  disabled={isValidating || isValidated || !oenum.trim()}
                  className="px-4 py-3 bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-700 disabled:cursor-not-allowed rounded-xl text-white font-medium transition flex items-center gap-2"
                >
                  {isValidating && <Loader className="w-4 h-4 animate-spin" />}
                  {isValidated ? <CheckCircle className="w-4 h-4" /> : null}
                  {isValidating ? 'Checking...' : isValidated ? 'Valid' : 'Validate'}
                </button>
              </div>
            </div>

            {/* Field 2: Project Name (Auto-filled, Read-only) */}
            {isValidated && (
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Project Name (Auto-filled)
                </label>
                <input
                  type="text"
                  value={projectName}
                  readOnly
                  className="w-full px-4 py-3 bg-green-500/10 border border-green-500/30 rounded-xl text-green-300 cursor-not-allowed"
                />
              </div>
            )}

            {/* Field 3: First Page Name */}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                First Page Name
              </label>
              <input
                type="text"
                value={firstPageName}
                onChange={(e) => setFirstPageName(e.target.value)}
                placeholder="New Page"
                className="w-full px-4 py-3 bg-white/10 border border-white/20 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500 transition"
                disabled={!isValidated}
              />
            </div>

            {/* Error Message */}
            {error && (
              <div className="flex items-center gap-2 px-4 py-3 bg-red-500/10 border border-red-500/30 rounded-xl">
                <AlertCircle className="w-5 h-5 text-red-400" />
                <p className="text-sm text-red-400">{error}</p>
              </div>
            )}

            {/* Buttons */}
            <div className="flex gap-3">
              <button
                onClick={handleSubmit}
                disabled={!isValidated || !firstPageName.trim()}
                className="flex-1 py-3 bg-gradient-to-r from-emerald-500 to-teal-600 rounded-xl font-bold text-white hover:from-emerald-600 hover:to-teal-700 transition shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Create Project
              </button>
              <button
                onClick={handleClose}
                className="px-6 py-3 bg-white/10 border border-white/20 rounded-xl text-white hover:bg-white/20 transition"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      </motion.div>
    </>
  );
}
```

---

### Part 3: Fix Message Ordering (Backend)

**File**: `simorgh-agent/backend/services/redis_service.py`

**Update `get_chat_history()` method**:

```python
def get_chat_history(self, chat_id: str, limit: int = 50, offset: int = 0):
    """
    Get chat history with proper ordering by CreatedAt timestamp

    Messages must ALWAYS be sorted: User message -> AI response
    """
    messages = self.chat_client.lrange(f"chat:history:{chat_id}", offset, offset + limit - 1)

    parsed_messages = []
    for msg in messages:
        if msg:
            try:
                parsed = json.loads(msg)
                # Ensure message has required fields
                if "created_at" not in parsed:
                    parsed["created_at"] = datetime.now().isoformat()
                parsed_messages.append(parsed)
            except json.JSONDecodeError:
                logger.warning(f"Failed to parse message: {msg}")

    # CRITICAL: Sort by created_at timestamp in ascending order
    # This ensures proper order: User message, then AI response
    parsed_messages.sort(key=lambda x: x.get("created_at", ""))

    return parsed_messages
```

**Update `add_message()` method to include all required fields**:

```python
def add_message(
    self,
    chat_id: str,
    message_id: str,
    project_id: Optional[str],
    page_id: str,
    sender: str,  # "user" or "assistant"
    text: str,
    created_at: Optional[datetime] = None
):
    """
    Add message with complete metadata

    Required fields:
    - message_id: Unique message identifier
    - project_id: Project ID (None for general chats)
    - page_id: Page/Chat ID
    - sender: "user" or "assistant"
    - text: Message content
    - created_at: Timestamp (auto if not provided)
    """
    if created_at is None:
        created_at = datetime.now()

    message = {
        "message_id": message_id,
        "project_id": project_id,
        "page_id": page_id,
        "sender": sender,
        "text": text,
        "created_at": created_at.isoformat(),
        "timestamp": int(created_at.timestamp())
    }

    # Add to chat history
    self.chat_client.rpush(f"chat:history:{chat_id}", json.dumps(message))

    # Update message count
    metadata = self.get(f"chat:{chat_id}:metadata", db="chat")
    if metadata:
        metadata["message_count"] = metadata.get("message_count", 0) + 1
        metadata["last_updated_at"] = created_at.isoformat()
        self.set(f"chat:{chat_id}:metadata", metadata, db="chat")
```

---

### Part 4: Right-Click Context Menu

**Create new file**: `simorgh-agent/frontend/src/components/ContextMenu.tsx`

```typescript
import React, { useEffect, useRef } from 'react';
import { Edit2, Trash2, Plus } from 'lucide-react';

interface ContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  onRename: () => void;
  onDelete: () => void;
  onCreateNew: () => void;
  target: 'project' | 'page';
}

export default function ContextMenu({
  x,
  y,
  onClose,
  onRename,
  onDelete,
  onCreateNew,
  target
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      style={{ top: y, left: x }}
      className="fixed z-50 bg-gray-900 border border-white/20 rounded-lg shadow-2xl py-2 min-w-[200px]"
    >
      <button
        onClick={() => { onRename(); onClose(); }}
        className="w-full px-4 py-2 text-left text-white hover:bg-white/10 flex items-center gap-2 transition"
      >
        <Edit2 className="w-4 h-4" />
        Rename {target === 'project' ? 'Project' : 'Page'}
      </button>

      <button
        onClick={() => { onDelete(); onClose(); }}
        className="w-full px-4 py-2 text-left text-red-400 hover:bg-red-500/10 flex items-center gap-2 transition"
      >
        <Trash2 className="w-4 h-4" />
        Delete {target === 'project' ? 'Project' : 'Page'}
      </button>

      <div className="border-t border-white/10 my-2" />

      <button
        onClick={() => { onCreateNew(); onClose(); }}
        className="w-full px-4 py-2 text-left text-emerald-400 hover:bg-emerald-500/10 flex items-center gap-2 transition"
      >
        <Plus className="w-4 h-4" />
        Create New {target === 'project' ? 'Project' : 'Page'}
      </button>
    </div>
  );
}
```

**Update ProjectTree.tsx** to add right-click handler:

```typescript
// In ProjectTree.tsx, add to each chat/page item:
<div
  onContextMenu={(e) => {
    e.preventDefault();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      chatId: chat.id,
      projectId: project.id
    });
  }}
  className="..."
>
  {/* existing chat content */}
</div>

// Add state and render context menu:
const [contextMenu, setContextMenu] = useState<{
  x: number;
  y: number;
  chatId: string;
  projectId: string;
} | null>(null);

{contextMenu && (
  <ContextMenu
    x={contextMenu.x}
    y={contextMenu.y}
    onClose={() => setContextMenu(null)}
    onRename={() => {
      // Show rename modal
      setRenameModalOpen(true);
    }}
    onDelete={() => {
      // Call delete function
      deleteChat(contextMenu.chatId, contextMenu.projectId);
    }}
    onCreateNew={() => {
      // Create new page in this project
      createChat(contextMenu.projectId, "New Page");
    }}
    target="page"
  />
)}
```

---

### Part 5: Add Message Timestamps (Frontend)

**Update Message Display** in `MessageList.tsx`:

```typescript
import { formatDistanceToNow } from 'date-fns';

// In message rendering:
<div className="flex items-end gap-2">
  <div className={`message-bubble ${message.role}`}>
    {message.content}
  </div>
  <span className="text-xs text-gray-500">
    {formatDistanceToNow(new Date(message.timestamp), { addSuffix: true })}
  </span>
</div>
```

Install dependency:
```bash
npm install date-fns
```

---

## Testing Checklist

### OENUM Lookup
- [ ] Enter valid OENUM → Project name auto-fills
- [ ] Enter invalid OENUM → Error: "Project not found"
- [ ] User without permission → Error: "Access denied"
- [ ] Create button disabled until validation passes

### Message Ordering
- [ ] Send user message → AI responds → Order is correct
- [ ] Close and reopen chat → Messages still in correct order
- [ ] Check database: Messages sorted by `created_at ASC`

### Context Menu
- [ ] Right-click on page → Menu appears
- [ ] Click "Rename" → Rename modal opens
- [ ] Click "Delete" → Confirmation, then deletion
- [ ] Click "Create New" → New page created

### Isolation
- [ ] Create 2 projects → Messages don't mix
- [ ] Create 2 pages in same project → Messages don't mix
- [ ] Files uploaded to one page → Not visible in others

---

## Deployment

```bash
# 1. Install dependencies (if needed)
cd simorgh-agent/frontend
npm install date-fns

# 2. Build frontend
npm run build

# 3. Restart services
cd ../
docker-compose up -d --build

# 4. Test all features
# 5. Commit and push
git add -A
git commit -m "feat: Complete OENUM lookup, context menu, and message ordering"
git push origin claude/chat-session-redis-01QHAGTYeAA3F8Kmz7hAAGoC
```

---

## Database Schema Updates (If Needed)

If you need to update Redis schema for better isolation:

```python
# Session/Page metadata structure:
{
  "page_id": "P-12345-000001",  # Unique page ID
  "project_id": "12345",  # IDProjectMain
  "project_name": "Industrial Plant",
  "page_name": "Panel Analysis",
  "oenum": "P-2024-001",
  "created_by": "john.doe",
  "created_at": "2025-12-03T10:00:00",
  "message_count": 5
}

# Message structure:
{
  "message_id": "S-P-12345-000001-M-001",
  "project_id": "12345",
  "page_id": "P-12345-000001",
  "sender": "user",  # or "assistant"
  "text": "Message content",
  "created_at": "2025-12-03T10:01:00",
  "timestamp": 1701594060
}
```

---

## Summary

This guide provides complete implementation for:
1. ✅ OENUM lookup (Backend complete, Frontend template provided)
2. ⏳ Message ordering fix (Implementation provided)
3. ⏳ Right-click context menu (Complete component provided)
4. ⏳ Message timestamps (Implementation provided)
5. ⏳ Full isolation (Schema design provided)

Follow each section step-by-step, test thoroughly, and commit when complete.
