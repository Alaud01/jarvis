import React, { useState, useRef, useEffect } from 'react';
import type { FileAttachment } from '../../shared/attachments';

type VoiceState = 'idle' | 'recording' | 'processing';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

interface VoiceTranscriptPayload {
  id: string;
  text: string;
  autoSubmit: boolean;
  newChat: boolean;
}

interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextLength?: number;
}

interface InputAreaProps {
  onSendMessage: (text: string, attachments?: FileAttachment[]) => void;
  onStopStreaming: () => void;
  value: string;
  onChange: (value: string) => void;
  isLoading?: boolean;
  disabled?: boolean;
  voiceTranscript?: VoiceTranscriptPayload | null;
  onVoiceTextUsed?: () => void;
  voiceShortcut?: string;
  models: ModelInfo[];
  selectedModel: string | null;
  onModelSelect: (model: string) => void;
  isLoadingModels?: boolean;
  onRefreshModels: () => void;
  composeFocusKey?: number;
}

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  'ollama': 'Ollama',
  'opencode-go': 'Go',
  'openrouter': 'OpenRouter',
};

function getProviderDisplayName(providerId: string): string {
  return PROVIDER_DISPLAY_NAMES[providerId] || providerId;
}

function groupModelsByProvider(models: ModelInfo[]): Map<string, ModelInfo[]> {
  const groups = new Map<string, ModelInfo[]>();
  for (const model of models) {
    const existing = groups.get(model.provider) || [];
    existing.push(model);
    groups.set(model.provider, existing);
  }
  return groups;
}

function getExtensionFromFile(file: File): string {
  const extension = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')).toLowerCase() : '';
  if (extension) {
    return extension;
  }

  switch (file.type) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    default:
      return '';
  }
}

function getAttachmentImageSrc(attachment: FileAttachment): string | null {
  if (attachment.kind !== 'image' || !attachment.base64) {
    return null;
  }

  return `data:${attachment.mimeType ?? 'image/png'};base64,${attachment.base64}`;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
        return;
      }
      reject(new Error('Unable to read image data.'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read image data.'));
    reader.readAsDataURL(file);
  });
}

async function createImageAttachment(file: File, fallbackName: string): Promise<FileAttachment> {
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(file.type)) {
    throw new Error('Unsupported image type.');
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error(`Image is larger than the ${MAX_IMAGE_BYTES / (1024 * 1024)} MB upload limit.`);
  }

  const dataUrl = await readFileAsDataUrl(file);
  const base64 = dataUrl.split(',', 2)[1];
  if (!base64) {
    throw new Error('Unable to read image data.');
  }

  const name = file.name || fallbackName;
  return {
    name,
    extension: getExtensionFromFile(file),
    size: file.size,
    content: `[Image attachment: ${name}]`,
    truncated: false,
    kind: 'image',
    mimeType: file.type,
    base64,
  };
}

const ModelSelector: React.FC<{
  models: ModelInfo[];
  selectedModel: string | null;
  onModelSelect: (model: string) => void;
  isLoading: boolean;
  onRefreshModels: () => void;
}> = ({ models, selectedModel, onModelSelect, isLoading, onRefreshModels }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selectedModelInfo = models.find(m => m.id === selectedModel);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setSearch('');
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
        setSearch('');
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  const lowerSearch = search.toLowerCase();
  const filteredModels = search
    ? models.filter(m =>
        m.name.toLowerCase().includes(lowerSearch) ||
        m.id.toLowerCase().includes(lowerSearch) ||
        getProviderDisplayName(m.provider).toLowerCase().includes(lowerSearch)
      )
    : models;

  const groupedModels = groupModelsByProvider(filteredModels);
  const providerOrder = ['opencode-go', 'openrouter', 'ollama'];
  const sortedProviders = [...groupedModels.keys()].sort((a, b) => {
    const ai = providerOrder.indexOf(a);
    const bi = providerOrder.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });

  useEffect(() => {
    if (!isOpen || !selectedModel || !listRef.current) return;
    const selectedEl = listRef.current.querySelector('[data-selected="true"]');
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: 'nearest' });
    }
  }, [isOpen, selectedModel]);

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => {
          if (!isLoading && models.length > 0) {
            setIsOpen(!isOpen);
          } else if (models.length === 0 && !isLoading) {
            onRefreshModels();
          }
        }}
        className={`inline-flex items-center gap-1.5 border font-mono text-[0.6rem] uppercase tracking-widest transition-all duration-[150ms] cursor-pointer ${
          isLoading
            ? 'border-border-secondary text-text-tertiary opacity-50 cursor-not-allowed'
            : models.length === 0
              ? 'border-border-secondary text-text-tertiary hover:border-text-primary hover:text-text-primary'
              : 'border-border-secondary text-text-secondary hover:border-text-primary hover:text-text-primary'
        } px-2 py-0.5`}
        disabled={isLoading}
      >
        {isLoading ? (
          'Loading...'
        ) : models.length === 0 ? (
          'No models - retry'
        ) : selectedModelInfo ? (
          <>
            <span className="truncate max-w-28" title={selectedModelInfo.name}>{selectedModelInfo.name}</span>
            <span className="text-text-tertiary text-[0.5rem] normal-case tracking-normal">{getProviderDisplayName(selectedModelInfo.provider)}</span>
          </>
        ) : (
          'Select model'
        )}
      </button>

      {isOpen && (
        <div className="absolute bottom-full left-0 mb-1 w-72 bg-bg-primary border border-border-primary shadow-lg z-50 flex flex-col" style={{ maxHeight: 'min(400px, 60vh)' }}>
          <div className="p-2 border-b border-border-primary shrink-0">
            <input
              ref={searchInputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search models..."
              className="w-full bg-transparent border border-border-secondary px-2 py-1 font-mono text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-text-primary"
            />
          </div>
          <div ref={listRef} className="overflow-y-auto flex-1">
            {sortedProviders.length === 0 && (
              <div className="px-3 py-4 text-center font-mono text-xs text-text-tertiary">
                No models found
              </div>
            )}
            {sortedProviders.map(providerId => {
              const providerModels = groupedModels.get(providerId) || [];
              return (
                <div key={providerId}>
                  <div className="px-3 py-1 font-mono text-[0.55rem] uppercase tracking-widest text-text-tertiary bg-bg-secondary sticky top-0">
                    {getProviderDisplayName(providerId)}
                  </div>
                  {providerModels.map(model => (
                    <button
                      key={model.id}
                      data-selected={model.id === selectedModel ? 'true' : undefined}
                      type="button"
                      onClick={() => {
                        onModelSelect(model.id);
                        setIsOpen(false);
                        setSearch('');
                      }}
                      title={model.name}
                      className={`w-full text-left px-3 py-1.5 flex items-center justify-between gap-2 transition-colors duration-100 cursor-pointer ${
                        model.id === selectedModel
                          ? 'bg-bg-secondary text-text-primary'
                          : 'text-text-secondary hover:bg-bg-secondary hover:text-text-primary'
                      }`}
                    >
                      <span className="font-mono text-xs truncate" title={model.name}>{model.name}</span>
                      <span className="text-text-tertiary text-[0.55rem] shrink-0">{getProviderDisplayName(model.provider)}</span>
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

const InputArea: React.FC<InputAreaProps> = ({ 
  onSendMessage, 
  onStopStreaming, 
  value,
  onChange,
  isLoading = false, 
  disabled = false,
  voiceTranscript,
  onVoiceTextUsed,
  voiceShortcut,
  models,
  selectedModel,
  onModelSelect,
  isLoadingModels = false,
  onRefreshModels,
  composeFocusKey = 0,
}) => {
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState('');
  const [isReadingAttachments, setIsReadingAttachments] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastComposeFocusKeyRef = useRef<number | null>(null);
  const lastHandledVoiceIdRef = useRef<string | null>(null);
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');

  useEffect(() => {
    if (lastComposeFocusKeyRef.current === null) {
      lastComposeFocusKeyRef.current = composeFocusKey;
      return;
    }
    if (lastComposeFocusKeyRef.current !== composeFocusKey) {
      lastComposeFocusKeyRef.current = composeFocusKey;
      queueMicrotask(() => {
        textareaRef.current?.focus({ preventScroll: true });
      });
    }
  }, [composeFocusKey]);

  useEffect(() => {
    if (!voiceTranscript || !onVoiceTextUsed) {
      return;
    }

    if (lastHandledVoiceIdRef.current === voiceTranscript.id) {
      return;
    }

    lastHandledVoiceIdRef.current = voiceTranscript.id;

    const text = voiceTranscript.text.trim();
    if (!text) {
      onVoiceTextUsed();
      return;
    }

    const nextInput = value ? `${value} ${text}` : text;

    if (voiceTranscript.autoSubmit && !isLoading && !disabled) {
      onChange('');
      onSendMessage(nextInput, attachments);
      setAttachments([]);
      setAttachmentError('');
    } else {
      onChange(nextInput);
    }

    onVoiceTextUsed();
  }, [voiceTranscript, onVoiceTextUsed, value, attachments, isLoading, disabled, onSendMessage, onChange]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    if (!value) {
      textarea.style.height = '24px';
      return;
    }
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [value]);

  useEffect(() => {
    if (!window.assistant?.onVoiceFlowState) return;
    
    const cleanup = window.assistant.onVoiceFlowState((state) => {
      setVoiceState(state);
    });
    
    return cleanup;
  }, []);

  const handleSend = () => {
    const text = value.trim() || (attachments.length > 0 ? 'Please read and summarize the attached file(s).' : '');
    if (!text || isLoading) return;
    onSendMessage(text, attachments);
    onChange('');
    setAttachments([]);
    setAttachmentError('');
  };

  const handleAttach = async () => {
    if (
      !window.assistant?.pickAttachmentPaths
      || !window.assistant?.readAttachments
      || isReadingAttachments
    ) {
      return;
    }

    setAttachmentError('');
    try {
      const paths = await window.assistant.pickAttachmentPaths();
      if (paths.length === 0) {
        return;
      }

      setIsReadingAttachments(true);
      const result = await window.assistant.readAttachments(paths);
      setAttachments(current => [...current, ...result.attachments]);
      setAttachmentError(result.errors.join(' '));
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : 'Unable to attach files.');
    } finally {
      setIsReadingAttachments(false);
    }
  };

  const addFilesAsAttachments = async (files: File[], fallbackPrefix: string) => {
    if (files.length === 0 || isReadingAttachments) {
      return;
    }

    setAttachmentError('');
    setIsReadingAttachments(true);

    try {
      const paths: string[] = [];
      const blobImages: File[] = [];
      const errors: string[] = [];

      files.forEach((file, index) => {
        let nativePath = (file as File & { path?: string }).path || '';
        try {
          nativePath = window.assistant?.getPathForFile?.(file) || nativePath;
        } catch {
          nativePath = nativePath || '';
        }

        if (nativePath) {
          paths.push(nativePath);
          return;
        }

        if (SUPPORTED_IMAGE_MIME_TYPES.has(file.type)) {
          blobImages.push(file.name ? file : new File([file], `${fallbackPrefix}-${index + 1}${getExtensionFromFile(file)}`, { type: file.type }));
          return;
        }

        errors.push(`${file.name || 'Pasted item'}: Only image clipboard items can be attached without a file path.`);
      });

      const [pathResult, imageResults] = await Promise.all([
        paths.length > 0 && window.assistant?.readAttachments
          ? window.assistant.readAttachments(paths)
          : Promise.resolve({ attachments: [], errors: [] }),
        Promise.allSettled(blobImages.map((file, index) => createImageAttachment(file, `${fallbackPrefix}-${index + 1}${getExtensionFromFile(file)}`))),
      ]);

      const imageAttachments: FileAttachment[] = [];
      imageResults.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          imageAttachments.push(result.value);
          return;
        }

        const reason = result.reason instanceof Error ? result.reason.message : 'Unable to read image.';
        errors.push(`${blobImages[index]?.name || 'Image'}: ${reason}`);
      });

      setAttachments(current => [...current, ...pathResult.attachments, ...imageAttachments]);
      setAttachmentError([...pathResult.errors, ...errors].join(' '));
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : 'Unable to attach files.');
    } finally {
      setIsReadingAttachments(false);
    }
  };

  const handleRemoveAttachment = (index: number) => {
    setAttachments(current => current.filter((_, currentIndex) => currentIndex !== index));
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const fileItems = Array.from(e.clipboardData.items)
      .filter(item => item.kind === 'file')
      .map(item => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    const files = fileItems.length > 0 ? fileItems : Array.from(e.clipboardData.files);

    if (files.length === 0) {
      return;
    }

    e.preventDefault();
    void addFilesAsAttachments(files, 'pasted-image');
  };

  const hasDraggedFiles = (dataTransfer: DataTransfer) => Array.from(dataTransfer.types).includes('Files');

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(e.dataTransfer)) {
      return;
    }

    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setIsDragOver(false);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(e.dataTransfer)) {
      return;
    }

    e.preventDefault();
    setIsDragOver(false);
    void addFilesAsAttachments(Array.from(e.dataTransfer.files), 'dropped-image');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleMicClick = async () => {
    if (!window.assistant?.startVoiceRecording || !window.assistant?.stopVoiceRecording) {
      console.error('Voice recording not available');
      return;
    }

    if (voiceState === 'idle') {
      const result = await window.assistant.startVoiceRecording();
      if (!result.success) {
        console.error('Failed to start recording:', result.error);
      }
    } else if (voiceState === 'recording') {
      await window.assistant.stopVoiceRecording();
    }
  };

  const isDisabled = isLoading || disabled || voiceState === 'processing';

  return (
    <div
      className="pb-6 bg-bg-primary shrink-0"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="max-w-200 mx-auto">
        <div className={`bg-transparent border px-3 py-2 transition-all duration-150 focus-within:border-text-primary ${isDragOver ? 'border-text-primary bg-bg-secondary' : 'border-border-primary'}`}>
          {attachments.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap mb-2">
              {attachments.map((attachment, index) => (
                <span
                  key={`${attachment.name}-${attachment.size}-${index}`}
                  className="inline-flex items-center gap-2 border border-border-secondary px-2 py-1 font-mono text-[0.65rem] text-text-secondary"
                  title={attachment.truncated ? 'Extracted text was truncated for model context' : attachment.name}
                >
                  {getAttachmentImageSrc(attachment) && (
                    <img
                      src={getAttachmentImageSrc(attachment) ?? undefined}
                      alt=""
                      className="h-10 w-10 object-cover border border-border-secondary"
                    />
                  )}
                  {attachment.name}{attachment.truncated ? ' (trimmed)' : ''}
                  <button
                    type="button"
                    className="text-text-tertiary hover:text-text-primary"
                    onClick={() => handleRemoveAttachment(index)}
                    aria-label={`Remove ${attachment.name}`}
                  >
                    x
                  </button>
                </span>
              ))}
            </div>
          )}
          {attachmentError && (
            <p className="mb-2 font-mono text-[0.65rem] text-red-500">{attachmentError}</p>
          )}
          <textarea
            ref={textareaRef}
            className="w-full min-h-7 max-h-20 border-none outline-none resize-none bg-transparent text-text-primary font-sans text-[0.875rem] leading-relaxed placeholder:text-text-tertiary overflow-y-auto"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onPaste={handlePaste}
            onKeyDown={handleKeyDown}
            placeholder="Compose your thought..."
            rows={1}
            disabled={isDisabled}
          />
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 flex-wrap">
              <ModelSelector
                models={models}
                selectedModel={selectedModel}
                onModelSelect={onModelSelect}
                isLoading={isLoadingModels}
                onRefreshModels={onRefreshModels}
              />
            </div>
            <div className="flex items-center gap-2">
              <button
                className="py-1 px-3 border border-text-primary bg-transparent text-text-primary font-mono text-[0.575rem] uppercase tracking-widest cursor-pointer transition-all duration-150 hover:bg-text-primary hover:text-bg-primary disabled:opacity-30 disabled:cursor-not-allowed"
                onClick={handleAttach}
                disabled={isDisabled || isReadingAttachments}
                title="Attach PDF, Office, text, or code files"
                type="button"
              >
                {isReadingAttachments ? 'Reading…' : 'Attach'}
              </button>
              <button
                className={`py-1 px-3 border font-mono text-[0.575rem] uppercase tracking-widest cursor-pointer transition-all duration-150 ${
                  voiceState === 'recording'
                    ? 'border-red-500 bg-red-500 text-white animate-pulse'
                    : voiceState === 'processing'
                    ? 'border-yellow-500 bg-yellow-500 text-white cursor-wait'
                    : 'border-text-primary bg-transparent text-text-primary hover:bg-text-primary hover:text-bg-primary'
                }`}
                onClick={handleMicClick}
                disabled={disabled || voiceState === 'processing'}
                title={
                  voiceState === 'recording'
                    ? voiceShortcut
                      ? `Stop recording (${voiceShortcut})`
                      : 'Stop recording'
                    : voiceState === 'processing'
                    ? 'Processing...'
                    : voiceShortcut
                    ? `Record voice (${voiceShortcut})`
                    : 'Record voice'
                }
              >
                {voiceState === 'recording' ? 'Stop' : voiceState === 'processing' ? 'Wait' : 'Mic'}
              </button>
              <button
                className="py-1 px-4 border border-text-primary bg-text-primary text-bg-primary font-mono text-[0.575rem] uppercase tracking-widest cursor-pointer transition-all duration-[150ms] hover:not-disabled:bg-transparent hover:not-disabled:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed"
                onClick={isLoading ? onStopStreaming : handleSend}
                disabled={!isLoading && ((!value.trim() && attachments.length === 0) || disabled)}
              >
                {isLoading ? 'Stop' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default InputArea;
