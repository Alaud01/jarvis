import React, { useState, useRef, useEffect } from 'react';

type VoiceState = 'idle' | 'recording' | 'processing';

interface VoiceTranscriptPayload {
  id: string;
  text: string;
  autoSubmit: boolean;
  newChat: boolean;
}

interface InputAreaProps {
  onSendMessage: (text: string) => void;
  onStopStreaming: () => void;
  isLoading?: boolean;
  disabled?: boolean;
  voiceTranscript?: VoiceTranscriptPayload | null;
  onVoiceTextUsed?: () => void;
  voiceShortcut?: string;
  /** Increments when the user starts a new chat; focuses the composer without focusing on first app mount. */
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
  composeFocusKey = 0,
}) => {
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
        <div className="bg-transparent border border-border-primary p-3 transition-all duration-150 focus-within:border-text-primary">
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
            <div className="flex items-center gap-3 flex-wrap">
              {voiceShortcut && (
                <span className="font-mono text-[0.65rem] text-text-tertiary uppercase tracking-widest">
                  {voiceShortcut} toggles voice
                </span>
              )}
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