import React, { useState } from 'react';
import { SearchIcon, MessageSquareIcon, FolderIcon } from 'lucide-react';
import { Project } from '../types';
interface HistoryListProps {
  projects: Project[];
  onSelectChat: (projectId: string, chatId: string) => void;
}
export function HistoryList({
  projects,
  onSelectChat
}: HistoryListProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const allChats = projects.flatMap(project => project.chats.map(chat => ({
    ...chat,
    projectId: project.id,
    projectName: project.name
  })));
  const filteredChats = allChats.filter(chat => chat.title.toLowerCase().includes(searchQuery.toLowerCase()) || chat.projectName.toLowerCase().includes(searchQuery.toLowerCase()));
  return <div className="h-full flex flex-col">
      {/* Search */}
      <div className="p-4 border-b border-white/10">
        <div className="relative">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search history..." className="w-full pl-10 pr-4 py-2 rounded-lg bg-white/5 border border-white/10 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 text-sm" />
        </div>
      </div>

      {/* History list */}
      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {filteredChats.length === 0 ? <div className="text-center text-gray-500 text-sm mt-8">
            {searchQuery ? 'No results found' : 'No history yet'}
          </div> : filteredChats.map(chat => <button key={chat.id} onClick={() => onSelectChat(chat.projectId, chat.id)} className="w-full p-3 rounded-lg hover:bg-white/5 transition-colors text-left group">
              <div className="flex items-start gap-3">
                <MessageSquareIcon className="w-4 h-4 text-purple-400 mt-1 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-white truncate group-hover:text-blue-400 transition-colors">
                    {chat.title}
                  </div>
                  <div className="flex items-center gap-2 mt-1 text-xs text-gray-500">
                    <FolderIcon className="w-3 h-3" />
                    <span className="truncate">{chat.projectName}</span>
                  </div>
                  <div className="text-xs text-gray-600 mt-1">
                    {new Date(chat.updatedAt).toLocaleDateString()}
                  </div>
                </div>
              </div>
            </button>)}
      </div>
    </div>;
}