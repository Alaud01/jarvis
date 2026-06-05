import type { ModelInfo, Provider, ProviderInfo } from './types';
import { OllamaProvider } from './ollama';
import { OpenCodeGoProvider } from './opencode-go';
import { OpenRouterProvider } from './openrouter';

const providers: Map<string, Provider> = new Map();

export function initializeProviders(opencodeGoApiKey?: string, openRouterApiKey?: string): void {
  const ollama = new OllamaProvider();
  providers.set(ollama.id, ollama);

  const opencodeGo = new OpenCodeGoProvider(opencodeGoApiKey);
  providers.set(opencodeGo.id, opencodeGo);

  const openRouter = new OpenRouterProvider(openRouterApiKey);
  providers.set(openRouter.id, openRouter);
}

export function setOpenCodeGoApiKey(key: string): void {
  const provider = providers.get('opencode-go');
  if (provider && provider instanceof OpenCodeGoProvider) {
    provider.setApiKey(key);
  }
}

export function setOpenRouterApiKey(key: string): void {
  const provider = providers.get('openrouter');
  if (provider && provider instanceof OpenRouterProvider) {
    provider.setApiKey(key);
  }
}

export function getProvider(providerId: string): Provider | undefined {
  return providers.get(providerId);
}

export function getAvailableProviders(): ProviderInfo[] {
  const result: ProviderInfo[] = [];
  for (const provider of providers.values()) {
    result.push({
      id: provider.id,
      name: provider.name,
      available: true,
    });
  }
  return result;
}

export async function getAllModels(): Promise<ModelInfo[]> {
  const allModels: ModelInfo[] = [];
  const fetchPromises = [...providers.values()].map(async (provider) => {
    try {
      const models = await provider.fetchModels();
      allModels.push(...models);
    } catch (error) {
      console.error(`[Registry] Error fetching models from ${provider.id}:`, error);
    }
  });

  await Promise.all(fetchPromises);
  return allModels;
}

export async function getModelsForProvider(providerId: string): Promise<ModelInfo[]> {
  const provider = providers.get(providerId);
  if (!provider) return [];
  return provider.fetchModels();
}
