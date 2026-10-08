import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModelInfo, ProviderInfo } from '../types';
import type { ModelCatalogSnapshot } from '../../shared/modelCatalog';

const MODEL_RESTORE_TIMEOUT_MS = 30_000;

export interface UseModelsResult {
  models: ModelInfo[];
  providers: ProviderInfo[];
  selectedModel: string | null;
  isLoadingModels: boolean;
  selectedProvider: string;
  setSelectedModel: (model: string) => void;
  refreshModels: () => Promise<void>;
  hasHydratedStore: boolean;
}

export function useModels(hasHydratedStore: boolean): UseModelsResult {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [selectedModel, setSelectedModelState] = useState<string | null>(null);
  const [isLoadingModels, setIsLoadingModels] = useState(true);
  const [selectionSettled, setSelectionSettled] = useState(false);
  const preferredModelRef = useRef<string | null>(null);
  const snapshotRef = useRef<ModelCatalogSnapshot | null>(null);
  const readyRef = useRef(false);
  const mountedRef = useRef(false);
  const restoreDeadlineRef = useRef(0);
  const restoreTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const applyCatalog = useCallback((snapshot: ModelCatalogSnapshot) => {
    if (!mountedRef.current || snapshot.revision < (snapshotRef.current?.revision ?? -1)) return;
    snapshotRef.current = snapshot;
    if (!readyRef.current) return;
    setModels(snapshot.models);
    // Models already discovered remain selectable while other sources load.
    setIsLoadingModels(snapshot.loading && snapshot.models.length === 0);
    const preferred = preferredModelRef.current;
    if (preferred && snapshot.models.some(model => model.id === preferred)) {
      setSelectedModelState(preferred);
      setSelectionSettled(true);
    } else if (preferred && Date.now() < restoreDeadlineRef.current) {
      setSelectedModelState(preferred);
      setSelectionSettled(false);
    } else {
      // Preserve the existing policy: automatic fallback is Ollama only.
      const fallback = snapshot.models.find(model => model.provider === 'ollama')?.id ?? null;
      preferredModelRef.current = fallback;
      setSelectedModelState(fallback);
      setSelectionSettled(true);
    }
  }, []);

  const startRestoreWindow = useCallback(() => {
    clearTimeout(restoreTimerRef.current);
    restoreDeadlineRef.current = Date.now() + MODEL_RESTORE_TIMEOUT_MS;
    restoreTimerRef.current = setTimeout(() => {
      if (!mountedRef.current) return;
      // Permit fallback even if a refresh fails; ordinary reads respect backoff.
      if (snapshotRef.current) applyCatalog(snapshotRef.current);
      void window.assistant.getModelCatalog().then(applyCatalog).catch(error => {
        console.error('Failed to refresh model catalog:', error);
      });
    }, MODEL_RESTORE_TIMEOUT_MS);
  }, [applyCatalog]);

  const setSelectedModel = useCallback((model: string) => {
    preferredModelRef.current = model;
    setSelectedModelState(model);
    setSelectionSettled(true);
  }, []);

  const refreshModels = useCallback(async () => {
    startRestoreWindow();
    try {
      applyCatalog(await window.assistant.getModelCatalog(true));
    } catch (error) {
      console.error('Failed to refresh models:', error);
      if (mountedRef.current) setIsLoadingModels(false);
    }
  }, [applyCatalog, startRestoreWindow]);

  useEffect(() => {
    mountedRef.current = true;
    readyRef.current = false;
    let canceled = false;
    const unsubscribe = window.assistant.onModelCatalogChanged(applyCatalog);
    void (async () => {
      try {
        const [storedModel, availableProviders, snapshot] = await Promise.all([
          window.assistant.storeLoadModel().catch(() => ''),
          window.assistant.getProviders(),
          window.assistant.getModelCatalog(),
        ]);
        if (canceled) return;
        preferredModelRef.current = storedModel || null;
        setProviders(availableProviders);
        readyRef.current = true;
        startRestoreWindow();
        // Events may have delivered newer results while the invoke was pending.
        applyCatalog(snapshotRef.current && snapshotRef.current.revision > snapshot.revision
          ? snapshotRef.current : snapshot);
      } catch (error) {
        if (canceled) return;
        console.error('Failed to load providers/models:', error);
        readyRef.current = true;
        setIsLoadingModels(false);
      }
    })();
    return () => {
      canceled = true;
      mountedRef.current = false;
      unsubscribe();
      clearTimeout(restoreTimerRef.current);
    };
  }, [applyCatalog, startRestoreWindow]);

  const selectedProvider = models.find(model => model.id === selectedModel)?.provider || 'ollama';
  useEffect(() => {
    if (!hasHydratedStore || !selectionSettled || !selectedModel) return;
    if (!models.some(model => model.id === selectedModel)) return;
    window.assistant.storeSaveModel(selectedModel).catch(error => {
      console.error('Failed to save selected model:', error);
    });
    window.assistant.storeSaveProvider(selectedProvider).catch(error => {
      console.error('Failed to save selected provider:', error);
    });
  }, [selectedModel, selectedProvider, models, hasHydratedStore, selectionSettled]);

  return { models, providers, selectedModel, isLoadingModels, selectedProvider,
    setSelectedModel, refreshModels, hasHydratedStore };
}
