import type { ModelInfo, Provider, ProviderInfo } from './types';
import { OllamaProvider } from './ollama';
import { OpenCodeGoProvider } from './opencode-go';
import { OpenRouterProvider } from './openrouter';
import { CodexProvider } from './codex';
import type { CodexAppServerOptions } from '../codexAppServer';

const providers: Map<string, Provider> = new Map();

export function initializeProviders(
  opencodeGoApiKey?: string,
  openRouterApiKey?: string,
  codexOptions?: CodexAppServerOptions,
): void {
  providers.clear();
  const ollama = new OllamaProvider();
  providers.set(ollama.id, ollama);

  const opencodeGo = new OpenCodeGoProvider(opencodeGoApiKey);
  providers.set(opencodeGo.id, opencodeGo);

  const openRouter = new OpenRouterProvider(openRouterApiKey);
  providers.set(openRouter.id, openRouter);

  if (codexOptions) {
    const codex = new CodexProvider(codexOptions);
    providers.set(codex.id, codex);
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

export function getCodexProvider(): CodexProvider | undefined {
  const provider = providers.get('codex');
  return provider instanceof CodexProvider ? provider : undefined;
}

export async function deleteProviderConversationState(conversationIds: string[]): Promise<void> {
  const deletions: Promise<void>[] = [];
  for (const provider of providers.values()) {
    if (!provider.deleteConversation) continue;
    for (const conversationId of conversationIds) {
      deletions.push(provider.deleteConversation(conversationId).catch(error => {
        console.warn(`[Registry] Failed to delete ${provider.id} state for ${conversationId}:`, error);
      }));
    }
  }
  await Promise.all(deletions);
}

export async function shutdownProviders(): Promise<void> {
  await Promise.all([...providers.values()].map(provider => (
    provider.shutdown?.().catch(error => {
      console.warn(`[Registry] Failed to stop ${provider.id}:`, error);
    }) ?? Promise.resolve()
  )));
}
