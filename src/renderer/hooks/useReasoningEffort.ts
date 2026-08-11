import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ModelInfo } from '../types';

function resolveReasoningEffort(model: ModelInfo | undefined, requestedEffort: string): string | null {
  const efforts = model?.reasoningEfforts;
  if (!model || !efforts?.length) return null;
  if (efforts.some(effort => effort.value === requestedEffort)) return requestedEffort;
  if (model.defaultReasoningEffort && efforts.some(effort => effort.value === model.defaultReasoningEffort)) {
    return model.defaultReasoningEffort;
  }
  return efforts[0].value;
}

export function useReasoningEffort(
  models: ModelInfo[],
  selectedModel: string | null,
  hasHydratedStore: boolean,
) {
  const [requestedEffort, setRequestedEffort] = useState('');
  const [hasLoadedPreference, setHasLoadedPreference] = useState(false);

  useEffect(() => {
    let active = true;
    window.assistant.storeLoadReasoningEffort()
      .then(effort => {
        if (active) setRequestedEffort(effort);
      })
      .catch(error => console.error('Failed to load reasoning effort:', error))
      .finally(() => {
        if (active) setHasLoadedPreference(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const selectedModelInfo = useMemo(
    () => models.find(model => model.id === selectedModel),
    [models, selectedModel],
  );
  const selectedReasoningEffort = resolveReasoningEffort(selectedModelInfo, requestedEffort);

  useEffect(() => {
    if (!hasHydratedStore || !hasLoadedPreference || !selectedReasoningEffort) return;
    if (selectedReasoningEffort === requestedEffort) return;
    setRequestedEffort(selectedReasoningEffort);
  }, [hasHydratedStore, hasLoadedPreference, requestedEffort, selectedReasoningEffort]);

  useEffect(() => {
    if (!hasHydratedStore || !hasLoadedPreference || !selectedReasoningEffort) return;
    window.assistant.storeSaveReasoningEffort(selectedReasoningEffort).catch(error => {
      console.error('Failed to save reasoning effort:', error);
    });
  }, [hasHydratedStore, hasLoadedPreference, selectedReasoningEffort]);

  const setSelectedReasoningEffort = useCallback((effort: string) => {
    if (!selectedModelInfo?.reasoningEfforts?.some(option => option.value === effort)) return;
    setRequestedEffort(effort);
  }, [selectedModelInfo]);

  return { selectedReasoningEffort, setSelectedReasoningEffort };
}
