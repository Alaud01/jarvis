import React, { useState, useRef, useEffect } from 'react';
import type { FileAttachment } from '../../shared/attachments';

type VoiceState = 'idle' | 'recording' | 'processing';

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
}

interface InputAreaProps {
  onSendMessage: (text: string, attachments?: FileAttachment[]) => void;
  onStopStreaming: () => void;
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
              className="w-full bg-transparent border border-border-secondary px-2 py-1 font-mono text-xs text-text-primary placeholder:text-text-tertiary placeholder:italic focus:outline-none focus:border-text-primary"
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
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState('');
  const [isPickingAttachments, setIsPickingAttachments] = useState(false);
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

    const nextInput = input ? `${input} ${text}` : text;

    if (voiceTranscript.autoSubmit && !isLoading && !disabled) {
      setInput('');
      onSendMessage(nextInput, attachments);
      setAttachments([]);
      setAttachmentError('');
    } else {
      setInput(nextInput);
    }

    onVoiceTextUsed();
  }, [voiceTranscript, onVoiceTextUsed, input, attachments, isLoading, disabled, onSendMessage]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    if (!input) {
      textarea.style.height = '24px';
      return;
    }
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [input]);

  useEffect(() => {
    if (!window.assistant?.onVoiceFlowState) return;
    
    const cleanup = window.assistant.onVoiceFlowState((state) => {
      setVoiceState(state);
    });
    
    return cleanup;
  }, []);

  const handleSend = () => {
    const text = input.trim() || (attachments.length > 0 ? 'Please read and summarize the attached file(s).' : '');
    if (!text || isLoading) return;
    onSendMessage(text, attachments);
    setInput('');
    setAttachments([]);
    setAttachmentError('');
  };

  const handleAttach = async () => {
    if (!window.assistant?.pickAttachments || isPickingAttachments) return;

    setIsPickingAttachments(true);
    setAttachmentError('');
    try {
      const result = await window.assistant.pickAttachments();
      setAttachments(current => [...current, ...result.attachments]);
      setAttachmentError(result.errors.join(' '));
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : 'Unable to attach files.');
    } finally {
      setIsPickingAttachments(false);
    }
  };

  const handleRemoveAttachment = (index: number) => {
    setAttachments(current => current.filter((_, currentIndex) => currentIndex !== index));
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
    <div className="pb-6 bg-bg-primary shrink-0">
      <div className="max-w-200 mx-auto">
        <div className="bg-transparent border border-border-primary px-3 py-2 transition-all duration-150 focus-within:border-text-primary">
          {attachments.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap mb-2">
              {attachments.map((attachment, index) => (
                <span
                  key={`${attachment.name}-${attachment.size}-${index}`}
                  className="inline-flex items-center gap-2 border border-border-secondary px-2 py-1 font-mono text-[0.65rem] text-text-secondary"
                  title={attachment.truncated ? 'Extracted text was truncated for model context' : attachment.name}
                >
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
            className="w-full min-h-7 max-h-20 border-none outline-none resize-none bg-transparent text-text-primary font-sans text-base leading-relaxed placeholder:text-text-tertiary placeholder:italic placeholder:font-serif overflow-y-auto"
            value={input}
            onChange={(e) => setInput(e.target.value)}
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
                className="py-1 px-3 border border-text-primary bg-transparent text-text-primary font-mono text-[0.7rem] uppercase tracking-widest cursor-pointer transition-all duration-150 hover:bg-text-primary hover:text-bg-primary disabled:opacity-30 disabled:cursor-not-allowed"
                onClick={handleAttach}
                disabled={isDisabled || isPickingAttachments}
                title="Attach PDF, Office, text, or code files"
                type="button"
              >
                {isPickingAttachments ? 'Reading' : 'Attach'}
              </button>
              <button
                className={`py-1 px-3 border font-mono text-[0.7rem] uppercase tracking-widest cursor-pointer transition-all duration-150 ${
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
                className="py-1 px-4 border border-text-primary bg-text-primary text-bg-primary font-mono text-[0.7rem] uppercase tracking-widest cursor-pointer transition-all duration-[150ms] hover:not-disabled:bg-transparent hover:not-disabled:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed"
                onClick={isLoading ? onStopStreaming : handleSend}
                disabled={!isLoading && ((!input.trim() && attachments.length === 0) || disabled)}
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
