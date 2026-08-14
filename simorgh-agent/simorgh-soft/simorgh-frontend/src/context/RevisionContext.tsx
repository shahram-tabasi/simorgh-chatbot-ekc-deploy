import React, { useState, createContext, useContext, ReactNode, useEffect } from 'react';
import { ProjectData, Revision, RevisionCreateData } from '../types/project';
import { projectService } from '../services/projectService';

interface RevisionContextType {
  // Revision state
  revisions: Revision[];
  currentRevision: Revision | null;
  currentRevisionId: string | null;
  
  // Load revisions for a project
  loadRevisions: (projectId: string) => Promise<void>;
  
  // Create a new revision
  createRevision: (revisionData: RevisionCreateData) => Promise<Revision>;
  
  // Switch to a different revision (load project data from that revision)
  switchToRevision: (revisionId: string) => Promise<ProjectData>;
  
  // Delete a revision (password protected)
  deleteRevision: (revisionId: string, password: string) => Promise<void>;
  
  // Get the latest revision
  getLatestRevision: () => Revision | null;
  
  // Check if current revision is the latest
  isCurrentRevisionLatest: () => boolean;
}

const RevisionContext = createContext<RevisionContextType | undefined>(undefined);

interface RevisionProviderProps {
  children: ReactNode;
  projectId?: string;
}

export const RevisionProvider: React.FC<RevisionProviderProps> = ({ children, projectId }) => {
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [currentRevision, setCurrentRevision] = useState<Revision | null>(null);
  const [currentRevisionId, setCurrentRevisionId] = useState<string | null>(null);

  // Load all revisions for a project
  const loadRevisions = async (projectId: string) => {
    try {
      const result = await projectService.getRevisions(projectId);
      const revisionsList = Array.isArray(result) ? result : (result.revisions || []);
      
      // Sort by revision number descending
      const sortedRevisions = revisionsList.sort((a, b) => b.revisionNumber - a.revisionNumber);
      
      setRevisions(sortedRevisions);
      
      // Set current revision to the latest one
      if (sortedRevisions.length > 0) {
        const latest = sortedRevisions.find(r => r.isLatest) || sortedRevisions[0];
        setCurrentRevision(latest);
        setCurrentRevisionId(latest._id || null);
      } else {
        setCurrentRevision(null);
        setCurrentRevisionId(null);
      }
    } catch (error) {
      console.error('Failed to load revisions:', error);
      setRevisions([]);
      setCurrentRevision(null);
      setCurrentRevisionId(null);
    }
  };

  // Create a new revision
  const createRevision = async (revisionData: RevisionCreateData): Promise<Revision> => {
    try {
      const result = await projectService.createRevision(revisionData);
      
      // Reload revisions to get updated list
      if (revisionData.projectId) {
        await loadRevisions(revisionData.projectId);
      }
      
      return result;
    } catch (error) {
      console.error('Failed to create revision:', error);
      throw error;
    }
  };

  // Switch to a different revision
  const switchToRevision = async (revisionId: string): Promise<ProjectData> => {
    try {
      const result = await projectService.loadRevision(revisionId);
      
      // Update current revision state
      const revision = revisions.find(r => r._id === revisionId);
      if (revision) {
        setCurrentRevision(revision);
        setCurrentRevisionId(revisionId);
      }
      
      return result.projectData || result;
    } catch (error) {
      console.error('Failed to switch revision:', error);
      throw error;
    }
  };

  // Delete a revision (password protected)
  const deleteRevision = async (revisionId: string, password: string): Promise<void> => {
    try {
      await projectService.deleteRevision(revisionId, password);
      
      // Reload revisions after deletion
      if (currentRevision) {
        await loadRevisions(currentRevision.projectId);
      }
    } catch (error) {
      console.error('Failed to delete revision:', error);
      throw error;
    }
  };

  // Get the latest revision
  const getLatestRevision = (): Revision | null => {
    return revisions.find(r => r.isLatest) || revisions[0] || null;
  };

  // Check if current revision is the latest
  const isCurrentRevisionLatest = (): boolean => {
    if (!currentRevision) return false;
    return currentRevision.isLatest || false;
  };

  return (
    <RevisionContext.Provider
      value={{
        revisions,
        currentRevision,
        currentRevisionId,
        loadRevisions,
        createRevision,
        switchToRevision,
        deleteRevision,
        getLatestRevision,
        isCurrentRevisionLatest
      }}
    >
      {children}
    </RevisionContext.Provider>
  );
};

export const useRevision = () => {
  const context = useContext(RevisionContext);
  if (context === undefined) {
    throw new Error('useRevision must be used within a RevisionProvider');
  }
  return context;
};
