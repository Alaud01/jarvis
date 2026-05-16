import React, { useState, useRef, useEffect } from 'react';

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

interface ProviderInfo {
  id: string;
  name: string;
  available: boolean;
}

interface InputAreaProps {
  onSendMessage: (text: string) => void;
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
  providers: ProviderInfo[];
  selectedProvider: string;
  onProviderSelect: (providerId: string) => void;
  onRefreshModels: () => void;
  composeFocusKey?: number;
}

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
  providers,
  selectedProvider,
  onProviderSelect,
  onRefreshModels,
  composeFocusKey = 0,
}) => {
  const filteredModels = models.filter(m => m.provider === selectedProvider);
  const [input, setInput] = useState('');
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
      onSendMessage(nextInput);
    } else {
      setInput(nextInput);
    }

    onVoiceTextUsed();
  }, [voiceTranscript, onVoiceTextUsed, input, isLoading, disabled, onSendMessage]);

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
    const text = input.trim();
    if (!text || isLoading) return;
    onSendMessage(text);
    setInput('');
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
              {providers.length > 1 && (
                <div className="relative">
                  <select
                    value={selectedProvider}
                    onChange={(e) => onProviderSelect(e.target.value)}
                    className="appearance-none bg-transparent border border-border-secondary px-2 py-0.5 pr-5 font-mono text-[0.6rem] text-text-tertiary uppercase tracking-widest cursor-pointer transition-all duration-[150ms] hover:border-text-primary hover:text-text-primary focus:outline-none focus:border-text-primary"
                  >
                    {providers.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.name}
                      </option>
                    ))}
                  </select>
                  <div className="absolute right-1 top-1/2 -translate-y-1/2 pointer-events-none">
                    <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-text-tertiary">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </div>
                </div>
              )}
              <div className="relative inline-flex">
                {filteredModels.length === 0 && !isLoadingModels ? (
                  <button
                    onClick={onRefreshModels}
                    className="w-28 truncate bg-transparent border border-border-secondary px-2 py-0.5 font-mono text-[0.6rem] text-text-tertiary uppercase tracking-widest cursor-pointer transition-all duration-[150ms] hover:border-text-primary hover:text-text-primary focus:outline-none focus:border-text-primary"
                    title="No models found - click to retry"
                  >
                    No models - retry
                  </button>
                ) : (
                  <>
                    <select
                      value={selectedModel || ''}
                      onChange={(e) => onModelSelect(e.target.value)}
                      disabled={isLoadingModels}
                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
                    >
                      {isLoadingModels && (
                        <option value="" disabled>Loading...</option>
                      )}
                      {!isLoadingModels && filteredModels.length > 0 && (
                        <option value="" disabled>Select model</option>
                      )}
                      {filteredModels.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.name}
                        </option>
                      ))}
                    </select>
                    <span
                      className={`w-40 truncate font-mono text-[0.6rem] uppercase tracking-widest transition-all duration-[150ms] hover:border-text-primary hover:text-text-primary pointer-events-none select-none ${isLoadingModels ? 'text-text-tertiary opacity-50' : selectedModel ? 'text-text-secondary' : 'text-text-tertiary'}`}
                    >
                      {isLoadingModels ? 'Loading...' : selectedModel ? filteredModels.find(m => m.id === selectedModel)?.name ?? selectedModel : 'Select model'}
                    </span>
                  </>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
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
                disabled={!isLoading && (!input.trim() || disabled)}
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