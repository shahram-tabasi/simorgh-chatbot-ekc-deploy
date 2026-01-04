import React, { useState, useRef, useEffect } from 'react';
import {
  SendIcon, PaperclipIcon, MicIcon, StopCircleIcon,
  FileTextIcon, XIcon, LoaderIcon, Loader2Icon
} from 'lucide-react';
import { UploadedFile } from '../types';
import { showError, showInfo } from '../utils/alerts';

interface ChatInputProps {
  onSend: (message: string, files?: UploadedFile[]) => void;
  onCancel?: () => void;
  disabled?: boolean;
  centered?: boolean;
  isGenerating?: boolean;
  editMessage?: { content: string; files?: UploadedFile[] } | null;
  promptToInsert?: string | null;
}

export function ChatInput({
  onSend,
  onCancel,
  disabled,
  centered = false,
  isGenerating = false,
  editMessage = null,
  promptToInsert = null
}: ChatInputProps) {
  const [message, setMessage] = useState('');
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  // Load edit message when provided
  useEffect(() => {
    if (editMessage) {
      setMessage(editMessage.content);
      setFiles(editMessage.files || []);
      // Focus textarea after setting message
      setTimeout(() => {
        textareaRef.current?.focus();
        // Move cursor to end
        if (textareaRef.current) {
          textareaRef.current.selectionStart = editMessage.content.length;
          textareaRef.current.selectionEnd = editMessage.content.length;
        }
      }, 100);
    }
  }, [editMessage]);

  // Insert prompt when provided (for suggested prompts like SPEC)
  useEffect(() => {
    if (promptToInsert) {
      setMessage(promptToInsert);
      // Focus textarea after setting message
      setTimeout(() => {
        textareaRef.current?.focus();
        // Move cursor to end
        if (textareaRef.current) {
          textareaRef.current.selectionStart = promptToInsert.length;
          textareaRef.current.selectionEnd = promptToInsert.length;
        }
      }, 100);
    }
  }, [promptToInsert]);

  // Auto-resize textarea - constrained by CSS max-height
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      const maxHeight = window.innerWidth < 640 ? 120 : 200; // Match Tailwind sm breakpoint
      textarea.style.height = Math.min(textarea.scrollHeight, maxHeight) + 'px';
    }
  }, [message]);

  const handleSend = () => {
    if (message.trim() || files.length > 0) {
      onSend(message, files.length > 0 ? files : undefined);
      setMessage('');
      setFiles([]);
    }
  };

  // const handleKeyPress = (e: React.KeyboardEvent) => {
  //   if (e.key === 'Enter' && !e.shiftKey) {
  //     e.preventDefault();
  //     handleSend();
  //   }
  // };


  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = e.target.files;
    if (!selectedFiles) return;

    setIsUploading(true);
    setUploadProgress(0);

    try {
      const newFiles: UploadedFile[] = [];

      for (let i = 0; i < selectedFiles.length; i++) {
        const file = selectedFiles[i];

        // Simulate upload progress (replace with real upload)
        const uploadedFile: UploadedFile = {
          id: Date.now().toString() + i,
          name: file.name,
          type: file.type,
          size: file.size,
          category: getFileCategory(file.type),
          url: URL.createObjectURL(file), // Temporary URL
          file: file, // Store original File object for backend upload
        };

        newFiles.push(uploadedFile);
        setUploadProgress(((i + 1) / selectedFiles.length) * 100);
      }

      setFiles((prev) => [...prev, ...newFiles]);
    } catch (error) {
      console.error('File upload failed:', error);
    } finally {
      setIsUploading(false);
      setUploadProgress(0);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const removeFile = (fileId: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== fileId));
  };

  const getFileCategory = (mimeType: string) => {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    return 'document';
  };

  // Voice recording with STT transcription
  const startRecording = async () => {
    try {
      // Check if mediaDevices API is available (requires HTTPS or localhost)
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showError(
          'Microphone Not Available',
          'Microphone access requires HTTPS. Please access the site via HTTPS or localhost.'
        );
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'audio/webm;codecs=opus'
      });
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        // Create audio blob
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });

        // Stop all tracks
        stream.getTracks().forEach((track) => track.stop());

        // If audio is too short, skip transcription
        if (audioBlob.size < 1000) {
          console.log('Audio too short, skipping transcription');
          return;
        }

        // Transcribe audio
        setIsTranscribing(true);
        try {
          const formData = new FormData();
          formData.append('audio', audioBlob, 'recording.webm');

          const response = await fetch('/api/stt/transcribe', {
            method: 'POST',
            body: formData
          });

          if (!response.ok) {
            throw new Error(`STT failed: ${response.statusText}`);
          }

          const result = await response.json();

          if (result.text && result.text.trim()) {
            // Append transcribed text to message
            setMessage(prev => {
              const separator = prev.trim() ? ' ' : '';
              return prev + separator + result.text.trim();
            });

            // Focus textarea
            setTimeout(() => textareaRef.current?.focus(), 100);

            console.log(`STT: "${result.text}" (${result.language}, ${result.processing_time.toFixed(2)}s)`);
          } else {
            showInfo('No Speech Detected', 'Could not detect any speech in the recording. Please try again.');
          }
        } catch (error) {
          console.error('Transcription failed:', error);
          showError('Transcription Failed', 'Could not transcribe audio. Please try again or type your message.');
        } finally {
          setIsTranscribing(false);
        }
      };

      // Request data every 1 second for potential future streaming
      mediaRecorder.start(1000);
      setIsRecording(true);
    } catch (error) {
      console.error('Failed to start recording:', error);
      showError('Microphone Access Denied', 'Could not access microphone. Please check your browser permissions.');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  const inputClasses = centered
    ? 'w-full max-w-3xl mx-auto px-2 sm:px-4'
    : 'border-t border-transparent backdrop-blur-xl p-2 sm:p-4';

  return (
    <div className={`${inputClasses} relative z-10`}>
      {/* File attachments */}
      {files.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {files.map((file) => (
            <div
              key={file.id}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-sm"
            >
              <FileTextIcon className="w-4 h-4 text-blue-400" />
              <span className="text-gray-300 truncate max-w-[150px]">
                {file.name}
              </span>
              <span className="text-xs text-gray-500">
                ({(file.size / 1024).toFixed(1)} KB)
              </span>
              <button
                onClick={() => removeFile(file.id)}
                className="p-0.5 hover:bg-white/10 rounded transition-colors"
              >
                <XIcon className="w-3 h-3 text-gray-400" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Upload progress */}
      {isUploading && (
        <div className="mb-3">
          <div className="flex items-center gap-2 text-sm text-blue-400 mb-1">
            <LoaderIcon className="w-4 h-4 animate-spin" />
            <span>Uploading... {uploadProgress.toFixed(0)}%</span>
          </div>
          <div className="h-1 bg-white/10 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-blue-500 to-purple-500 transition-all"
              style={{ width: `${uploadProgress}%` }}
            />
          </div>
        </div>
      )}

      <div className="flex gap-1.5 md:gap-2 items-center bg-black/40 backdrop-blur-xl rounded-2xl border border-white/10 p-1.5 md:p-2">
        {/* File upload */}
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || isUploading}
          className="p-2 md:p-2.5 rounded-xl hover:bg-white/10 transition-colors disabled:opacity-50 flex-shrink-0"
          title="Attach files"
        >
          <PaperclipIcon className="w-5 h-5 text-gray-300" />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.doc,.docx,.txt,image/*,video/*,audio/*"
          multiple
          className="hidden"
          onChange={handleFileSelect}
        />

        {/* Voice recording with STT - visible on all screens (matches Claude/ChatGPT mobile) */}
        <button
          onClick={isRecording ? stopRecording : startRecording}
          disabled={disabled || isTranscribing}
          className={`p-2 md:p-2.5 rounded-xl transition-colors flex-shrink-0 ${
            isTranscribing
              ? 'bg-blue-500/20 cursor-wait'
              : isRecording
              ? 'bg-red-500/20 hover:bg-red-500/30'
              : 'hover:bg-white/10'
            } disabled:opacity-50`}
          title={
            isTranscribing
              ? 'Transcribing...'
              : isRecording
              ? 'Stop recording'
              : 'Start voice recording (Speech-to-Text)'
          }
        >
          {isTranscribing ? (
            <Loader2Icon className="w-5 h-5 text-blue-400 animate-spin" />
          ) : isRecording ? (
            <StopCircleIcon className="w-5 h-5 text-red-400 animate-pulse" />
          ) : (
            <MicIcon className="w-5 h-5 text-gray-300" />
          )}
        </button>

        {/* Text input */}
        <div className="flex-1 relative flex items-center min-h-[40px] md:min-h-[44px]">
          <textarea
            ref={textareaRef}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={disabled ? "Please create or select a project and chat to start messaging..." : "Ask Simorgh anything..."}
            disabled={disabled}
            rows={1}
            className="w-full px-3 md:px-4 py-2 md:py-3 rounded-xl bg-transparent text-white text-base placeholder-gray-500 focus:outline-none resize-none disabled:cursor-not-allowed overflow-y-auto max-h-[120px] sm:max-h-[200px] leading-normal"
            style={{ minHeight: '40px' }}
          />
        </div>

        {/* Send or Stop button */}
        {isGenerating ? (
          <button
            onClick={onCancel}
            className="p-2 md:p-2.5 rounded-xl bg-red-500 hover:bg-red-600 transition-all flex-shrink-0"
            title="Stop generating"
          >
            <StopCircleIcon className="w-5 h-5 text-white" />
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={disabled || (!message.trim() && files.length === 0)}
            className="p-2 md:p-2.5 rounded-xl bg-gradient-to-r from-blue-500 to-purple-500 hover:from-blue-600 hover:to-purple-600 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex-shrink-0"
          >
            <SendIcon className="w-5 h-5 text-white" />
          </button>
        )}
      </div>
    </div>
  );
}