// src/components/SpecTaskNotification.tsx
import React, { useEffect, useState } from 'react';
import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

interface SpecTaskStatus {
  task_id: string;
  status: 'processing' | 'extracting' | 'building_graph' | 'completed' | 'error' | 'not_found';
  message: string;
  document_id?: string;
  project_number?: string;
  filename?: string;
  progress?: number;
  completed_at?: string;
  error?: string;
  review_url?: string;
}

interface SpecTaskNotificationProps {
  taskId: string;
  onComplete?: (documentId: string, projectNumber: string) => void;
  onError?: (error: string) => void;
}

export const SpecTaskNotification: React.FC<SpecTaskNotificationProps> = ({
  taskId,
  onComplete,
  onError
}) => {
  const [status, setStatus] = useState<SpecTaskStatus | null>(null);
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    let pollInterval: NodeJS.Timeout;

    const checkStatus = async () => {
      try {
        const token = localStorage.getItem('simorgh_token');
        if (!token) return;

        const response = await axios.get(
          `${API_BASE}/spec-tasks/${taskId}/status`,
          {
            headers: {
              Authorization: `Bearer ${token}`
            }
          }
        );

        const taskStatus: SpecTaskStatus = response.data;
        setStatus(taskStatus);

        // Handle completion
        if (taskStatus.status === 'completed') {
          console.log('✅ Spec extraction completed:', taskStatus);

          // Show browser notification
          if (Notification.permission === 'granted') {
            new Notification('Spec Extraction Complete!', {
              body: `${taskStatus.filename} has been processed. Click to review.`,
              icon: '/favicon.ico',
              tag: `spec-${taskId}`
            });
          }

          // Call completion callback
          if (onComplete && taskStatus.document_id && taskStatus.project_number) {
            onComplete(taskStatus.document_id, taskStatus.project_number);
          }

          // Stop polling
          clearInterval(pollInterval);

          // Auto-hide after 10 seconds
          setTimeout(() => setIsVisible(false), 10000);
        }

        // Handle error
        if (taskStatus.status === 'error') {
          console.error('❌ Spec extraction failed:', taskStatus.error);

          if (onError) {
            onError(taskStatus.error || 'Unknown error');
          }

          // Stop polling
          clearInterval(pollInterval);

          // Auto-hide after 10 seconds
          setTimeout(() => setIsVisible(false), 10000);
        }
      } catch (error) {
        console.error('Failed to check spec task status:', error);
      }
    };

    // Initial check
    checkStatus();

    // Poll every 3 seconds
    pollInterval = setInterval(checkStatus, 3000);

    return () => {
      clearInterval(pollInterval);
    };
  }, [taskId, onComplete, onError]);

  if (!isVisible || !status) {
    return null;
  }

  const getProgressColor = () => {
    switch (status.status) {
      case 'completed':
        return 'bg-green-500';
      case 'error':
        return 'bg-red-500';
      default:
        return 'bg-blue-500';
    }
  };

  const getIcon = () => {
    switch (status.status) {
      case 'completed':
        return '✅';
      case 'error':
        return '❌';
      default:
        return '⏳';
    }
  };

  const handleViewSpecs = () => {
    if (status.document_id && status.project_number) {
      // Navigate to spec review page
      window.open(
        `/review-specs/${status.project_number}/${status.document_id}`,
        '_blank'
      );
    }
  };

  return (
    <div className="fixed bottom-4 right-4 max-w-md bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 p-4 animate-slide-up z-50">
      <div className="flex items-start gap-3">
        <div className="text-2xl">{getIcon()}</div>

        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-gray-900 dark:text-white mb-1">
            {status.status === 'completed'
              ? 'Spec Extraction Complete'
              : status.status === 'error'
              ? 'Spec Extraction Failed'
              : 'Processing Specifications'}
          </h3>

          <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
            {status.message}
          </p>

          {status.filename && (
            <p className="text-xs text-gray-500 dark:text-gray-500 mb-2">
              📄 {status.filename}
            </p>
          )}

          {/* Progress bar */}
          {status.status !== 'completed' && status.status !== 'error' && (
            <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2 mb-2">
              <div
                className={`h-2 rounded-full transition-all duration-500 ${getProgressColor()}`}
                style={{ width: `${status.progress || 0}%` }}
              />
            </div>
          )}

          {/* Action buttons */}
          <div className="flex gap-2 mt-3">
            {status.status === 'completed' && (
              <button
                onClick={handleViewSpecs}
                className="px-3 py-1.5 bg-blue-500 hover:bg-blue-600 text-white text-sm rounded transition-colors"
              >
                Review Specs
              </button>
            )}

            <button
              onClick={() => setIsVisible(false)}
              className="px-3 py-1.5 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 text-sm rounded transition-colors"
            >
              Dismiss
            </button>
          </div>
        </div>

        {/* Close button */}
        <button
          onClick={() => setIsVisible(false)}
          className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
        >
          ✕
        </button>
      </div>
    </div>
  );
};

export default SpecTaskNotification;
