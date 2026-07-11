import { useCallback, useEffect, useRef, useState } from 'react';
import type { PendingVoiceTranscript } from '../types';

export interface UseVoiceResult {
  voiceTranscript: PendingVoiceTranscript | null;
  voiceShortcut: string;
  handleVoiceTextUsed: () => void;
  pendingJarvisMessageRef: React.MutableRefObject<string | null>;
  onVoiceTranscript: (text: string, autoSubmit: boolean, newChat: boolean) => void;
}

export function useVoice(onVoiceTranscript: (text: string, autoSubmit: boolean, newChat: boolean) => void): UseVoiceResult {
  const [voiceTranscript, setVoiceTranscript] = useState<PendingVoiceTranscript | null>(null);
  const [voiceShortcut, setVoiceShortcut] = useState<string>('');
  const pendingJarvisMessageRef = useRef<string | null>(null);

  useEffect(() => {
    const loadVoiceShortcut = async () => {
      try {
        if (!window.assistant?.getVoiceShortcut) {
          return;
        }

        const shortcut = await window.assistant.getVoiceShortcut();
        setVoiceShortcut(shortcut);
      } catch (error) {
        console.error('Failed to load voice shortcut:', error);
      }
    };

    loadVoiceShortcut();
  }, []);

  useEffect(() => {
    if (!window.assistant?.onVoiceTranscript) return;

    const cleanup = window.assistant.onVoiceTranscript((payload) => {
      if (payload?.text) {
        onVoiceTranscript(payload.text, payload.autoSubmit, payload.newChat);
      }
    });

    return cleanup;
  }, [onVoiceTranscript]);

  useEffect(() => {
    if (!window.assistant?.onVoiceError) return;

    const cleanup = window.assistant.onVoiceError((error) => {
      console.error('Voice error:', error);
    });

    return cleanup;
  }, []);

  const handleVoiceTextUsed = useCallback(() => {
    setVoiceTranscript(null);
  }, []);

  const setTranscript = useCallback((text: string, autoSubmit: boolean, newChat: boolean) => {
    setVoiceTranscript({
      id: crypto.randomUUID(),
      text,
      autoSubmit,
      newChat,
    });
  }, []);

  return {
    voiceTranscript,
    voiceShortcut,
    handleVoiceTextUsed,
    pendingJarvisMessageRef,
    onVoiceTranscript: setTranscript,
  };
}