import { useCallback, useEffect, useState } from 'react';
import type { ModelInfo, ProviderInfo } from '../types';

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
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [isLoadingModels, setIsLoadingModels] = useState(true);

  const refreshModels = useCallback(async () => {
    setIsLoadingModels(true);
    try {
      const [fetchedProviders, fetchedModels] = await Promise.all([
        window.assistant.getProviders(),
        window.assistant.getModels(),
      ]);
      setProviders(fetchedProviders);
      setModels(fetchedModels);
      const currentStillValid = fetchedModels.some(m => m.id === selectedModel);
      if (!currentStillValid && fetchedModels.length > 0) {
        setSelectedModel(fetchedModels[0].id);
      } else if (fetchedModels.length === 0) {
        setSelectedModel(null);
      }
    } catch (error) {
      console.error('Failed to refresh models:', error);
      setModels([]);
    } finally {
      setIsLoadingModels(false);
    }
  }, [selectedModel]);

  useEffect(() => {
    const loadProvidersAndModels = async () => {
      setIsLoadingModels(true);
      try {
        const [fetchedProviders, fetchedModels, storedModel] = await Promise.all([
          window.assistant.getProviders(),
          window.assistant.getModels(),
          window.assistant.storeLoadModel().catch((error) => {
            console.error('Failed to load stored model:', error);
            return '';
          }),
        ]);
        setProviders(fetchedProviders);
        setModels(fetchedModels);
        const storedModelIsAvailable = fetchedModels.some(model => model.id === storedModel);
        setSelectedModel(storedModelIsAvailable ? storedModel : (fetchedModels[0]?.id ?? null));
      } catch (error) {
        console.error('Failed to load providers/models:', error);
        setModels([]);
      } finally {
        setIsLoadingModels(false);
      }
    };
    loadProvidersAndModels();
  }, []);

  const selectedProvider = models.find(m => m.id === selectedModel)?.provider || 'ollama';

  useEffect(() => {
    if (!hasHydratedStore) return;

    if (selectedModel) {
      window.assistant.storeSaveModel(selectedModel).catch(err => {
        console.error('Failed to save selected model:', err);
      });
      const provider = models.find(m => m.id === selectedModel)?.provider || 'ollama';
      window.assistant.storeSaveProvider(provider).catch(err => {
        console.error('Failed to save selected provider:', err);
      });
    }
  }, [selectedModel, models, hasHydratedStore]);

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
