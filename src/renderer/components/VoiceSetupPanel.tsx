import React, { useCallback, useEffect, useState } from 'react';
import type { LocalVoiceModelStatus } from '../../shared/voiceSetup';

const DISMISS_KEY = 'jarvis.localVoiceModelSetup.dismissed';
const INSTALLING_POLL_MS = 2000;
const IDLE_POLL_MS = 15000;

function getStatusLabel(status: LocalVoiceModelStatus): string {
  if (status.installInProgress) {
    return 'Installing';
  }
  if (status.status === 'ready') {
    return 'Ready';
  }
  if (status.status === 'failed') {
    return 'Install failed';
  }
  if (status.openRouterFallbackConfigured) {
    return 'Using OpenRouter fallback';
  }
  return 'Setup optional';
}

function shouldShow(status: LocalVoiceModelStatus | null, dismissed: boolean): boolean {
  if (!status) {
    return false;
  }
  if (status.status === 'ready') {
    return false;
  }
  if (status.installInProgress || status.status === 'failed') {
    return true;
  }
  return !dismissed;
}

const VoiceSetupPanel: React.FC = () => {
  const [status, setStatus] = useState<LocalVoiceModelStatus | null>(null);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === 'true');
  const [installError, setInstallError] = useState('');

  const refreshStatus = useCallback(async () => {
    if (!window.assistant?.getLocalVoiceModelStatus) {
      return;
    }
    try {
      const nextStatus = await window.assistant.getLocalVoiceModelStatus();
      setStatus(nextStatus);
      if (nextStatus.status !== 'failed') {
        setInstallError('');
      }
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : 'Unable to check local voice model setup.');
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    if (
      status
      && !status.installInProgress
      && status.status !== 'failed'
      && (status.status === 'ready' || dismissed)
    ) {
      return undefined;
    }

    const interval = window.setInterval(
      () => void refreshStatus(),
      status?.installInProgress ? INSTALLING_POLL_MS : IDLE_POLL_MS,
    );

    return () => window.clearInterval(interval);
  }, [dismissed, refreshStatus, status]);

  const handleInstall = async () => {
    if (!window.assistant?.installLocalVoiceModel || status?.installInProgress) {
      return;
    }

    setInstallError('');
    setDismissed(false);
    localStorage.removeItem(DISMISS_KEY);

    try {
      const result = await window.assistant.installLocalVoiceModel();
      setStatus(result.status);
      if (!result.success) {
        setInstallError(result.error || result.status.lastError || 'Local voice model install failed.');
      }
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : 'Local voice model install failed.');
      void refreshStatus();
    }
  };

  const handleDismiss = () => {
    localStorage.setItem(DISMISS_KEY, 'true');
    setDismissed(true);
  };

  if (!shouldShow(status, dismissed)) {
    return null;
  }

  const lastMessage = installError || status?.lastError || status?.lastStep || '';
  const canUseFallback = Boolean(status?.openRouterFallbackConfigured);

  return (
    <div className="border-t border-border-primary bg-bg-secondary px-4 py-3">
      <div className="mx-auto flex max-w-200 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[0.6rem] uppercase tracking-widest text-text-tertiary">
              Local voice model
            </span>
            <span className="border border-border-secondary px-2 py-0.5 font-mono text-[0.55rem] uppercase tracking-widest text-text-secondary">
              {status ? getStatusLabel(status) : 'Checking'}
            </span>
          </div>
          <p className="mt-1 text-[0.75rem] leading-relaxed text-text-secondary">
            Install Parakeet in a managed runtime at {status?.managedServiceDir || '~/Library/Application Support/Jarvis/python-service'}.
            {' '}
            This downloads {status?.estimatedDownloadSize || 'the local voice dependencies and model'}.
          </p>
          {!canUseFallback && (
            <p className="mt-1 font-mono text-[0.65rem] text-text-tertiary">
              Add an OpenRouter key to use cloud transcription while local setup is skipped or unavailable.
            </p>
          )}
          {lastMessage && (
            <p className="mt-1 truncate font-mono text-[0.65rem] text-text-tertiary" title={lastMessage}>
              {lastMessage}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            className="border border-text-primary bg-text-primary px-3 py-1 font-mono text-[0.575rem] uppercase tracking-widest text-bg-primary transition-colors hover:bg-transparent hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
            onClick={handleInstall}
            disabled={status?.installInProgress}
          >
            {status?.installInProgress ? 'Installing' : 'Install'}
          </button>
          <button
            type="button"
            className="border border-border-secondary px-3 py-1 font-mono text-[0.575rem] uppercase tracking-widest text-text-secondary transition-colors hover:border-text-primary hover:text-text-primary"
            onClick={handleDismiss}
          >
            {canUseFallback ? 'Use fallback' : 'Dismiss'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default VoiceSetupPanel;
