import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModelInfo, ProviderInfo } from '../types';

/** How long to keep retrying for the previously saved model before falling back. */
const MODEL_RESTORE_TIMEOUT_MS = 30_000;
const MODEL_RESTORE_RETRY_MS = 1_500;

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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function modelIsAvailable(models: ModelInfo[], modelId: string | null | undefined): modelId is string {
  return Boolean(modelId) && models.some(model => model.id === modelId);
}

async function fetchProvidersAndModels(): Promise<{
  providers: ProviderInfo[];
  models: ModelInfo[];
}> {
  const [providers, models] = await Promise.all([
    window.assistant.getProviders(),
    window.assistant.getModels(),
  ]);
  return { providers, models };
}

/**
 * Keep fetching until the preferred model appears, the catalog is empty after
 * the deadline, or the timeout elapses. Most of the time the saved model is
 * only briefly missing while OpenRouter/Ollama finish loading.
 */
async function fetchUntilPreferredAvailable(
  preferredModel: string | null,
  timeoutMs: number,
  retryMs: number,
  shouldContinue: () => boolean,
): Promise<{ providers: ProviderInfo[]; models: ModelInfo[] }> {
  const deadline = Date.now() + timeoutMs;
  let latest = await fetchProvidersAndModels();

  while (
    shouldContinue()
    && preferredModel
    && !modelIsAvailable(latest.models, preferredModel)
    && Date.now() < deadline
  ) {
    await sleep(retryMs);
    if (!shouldContinue()) {
      break;
    }
    latest = await fetchProvidersAndModels();
  }

  return latest;
}

export function useModels(hasHydratedStore: boolean): UseModelsResult {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [selectedModel, setSelectedModelState] = useState<string | null>(null);
  const [isLoadingModels, setIsLoadingModels] = useState(true);
  const [selectionSettled, setSelectionSettled] = useState(false);

  const preferredModelRef = useRef<string | null>(null);
  const selectedModelRef = useRef<string | null>(null);
  const refreshGenerationRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      refreshGenerationRef.current += 1;
    };
  }, []);

  const setSelectedModel = useCallback((model: string) => {
    preferredModelRef.current = model;
    selectedModelRef.current = model;
    setSelectedModelState(model);
    setSelectionSettled(true);
  }, []);

  const applyCatalog = useCallback((
    fetchedProviders: ProviderInfo[],
    fetchedModels: ModelInfo[],
    preferredModel: string | null,
    allowFallback: boolean,
  ) => {
    setProviders(fetchedProviders);
    setModels(fetchedModels);

    if (modelIsAvailable(fetchedModels, preferredModel)) {
      preferredModelRef.current = preferredModel;
      selectedModelRef.current = preferredModel;
      setSelectedModelState(preferredModel);
      setSelectionSettled(true);
      return;
    }

    if (!allowFallback) {
      // Keep showing the preferred model while we wait for the catalog.
      if (preferredModel) {
        preferredModelRef.current = preferredModel;
        selectedModelRef.current = preferredModel;
        setSelectedModelState(preferredModel);
      }
      setSelectionSettled(false);
      return;
    }

    const fallback = fetchedModels[0]?.id ?? null;
    preferredModelRef.current = fallback;
    selectedModelRef.current = fallback;
    setSelectedModelState(fallback);
    setSelectionSettled(true);
  }, []);

  const refreshModels = useCallback(async () => {
    const generation = ++refreshGenerationRef.current;
    const preferredModel = preferredModelRef.current ?? selectedModelRef.current;
    setIsLoadingModels(true);

    try {
      const latest = await fetchUntilPreferredAvailable(
        preferredModel,
        MODEL_RESTORE_TIMEOUT_MS,
        MODEL_RESTORE_RETRY_MS,
        () => mountedRef.current && refreshGenerationRef.current === generation,
      );

      if (!mountedRef.current || refreshGenerationRef.current !== generation) {
        return;
      }

      applyCatalog(latest.providers, latest.models, preferredModel, true);
    } catch (error) {
      if (!mountedRef.current || refreshGenerationRef.current !== generation) {
        return;
      }
      console.error('Failed to refresh models:', error);
      // Keep the preferred selection; don't wipe it on a transient refresh failure.
    } finally {
      if (mountedRef.current && refreshGenerationRef.current === generation) {
        setIsLoadingModels(false);
      }
    }
  }, [applyCatalog]);

  useEffect(() => {
    const generation = ++refreshGenerationRef.current;

    const loadProvidersAndModels = async () => {
      setIsLoadingModels(true);
      try {
        const storedModel = await window.assistant.storeLoadModel().catch((error) => {
          console.error('Failed to load stored model:', error);
          return '';
        });

        if (!mountedRef.current || refreshGenerationRef.current !== generation) {
          return;
        }

        const preferredModel = storedModel || null;
        preferredModelRef.current = preferredModel;
        if (preferredModel) {
          selectedModelRef.current = preferredModel;
          setSelectedModelState(preferredModel);
          setSelectionSettled(false);
        }

        const latest = await fetchUntilPreferredAvailable(
          preferredModel,
          MODEL_RESTORE_TIMEOUT_MS,
          MODEL_RESTORE_RETRY_MS,
          () => mountedRef.current && refreshGenerationRef.current === generation,
        );

        if (!mountedRef.current || refreshGenerationRef.current !== generation) {
          return;
        }

        applyCatalog(latest.providers, latest.models, preferredModel, true);
      } catch (error) {
        if (!mountedRef.current || refreshGenerationRef.current !== generation) {
          return;
        }
        console.error('Failed to load providers/models:', error);
        setModels([]);
        setSelectionSettled(true);
      } finally {
        if (mountedRef.current && refreshGenerationRef.current === generation) {
          setIsLoadingModels(false);
        }
      }
    };

    void loadProvidersAndModels();
  }, [applyCatalog]);

  const selectedProvider = models.find(m => m.id === selectedModel)?.provider || 'ollama';

  useEffect(() => {
    if (!hasHydratedStore || !selectionSettled) return;
    if (!selectedModel || !modelIsAvailable(models, selectedModel)) return;

    window.assistant.storeSaveModel(selectedModel).catch(err => {
      console.error('Failed to save selected model:', err);
    });
    const provider = models.find(m => m.id === selectedModel)?.provider || 'ollama';
    window.assistant.storeSaveProvider(provider).catch(err => {
      console.error('Failed to save selected provider:', err);
    });
  }, [selectedModel, models, hasHydratedStore, selectionSettled]);

  return {
    models,
    providers,
    selectedModel,
    isLoadingModels,
    selectedProvider,
    setSelectedModel,
    refreshModels,
    hasHydratedStore,
  };
}
