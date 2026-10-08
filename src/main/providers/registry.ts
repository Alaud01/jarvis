import type { ModelInfo, Provider, ProviderInfo } from './types';
// import { OllamaProvider } from './ollama';
import { OpenCodeGoProvider } from './opencode-go';
// import { OpenRouterProvider } from './openrouter';
import { CodexProvider } from './codex';
import type { CodexAppServerOptions } from '../codexAppServer';
import { ModelCatalog } from './modelCatalog';

const providers: Map<string, Provider> = new Map();
const modelCatalog = new ModelCatalog();

export function initializeProviders(
  opencodeGoApiKey?: string,
  _openRouterApiKey?: string,
  codexOptions?: CodexAppServerOptions,
): void {
  providers.clear();
  modelCatalog.clear();
  // Ollama chat and model discovery are disabled (no active subscription).
  // const ollama = new OllamaProvider();
  // providers.set(ollama.id, ollama);

  const opencodeGo = new OpenCodeGoProvider(opencodeGoApiKey);
  providers.set(opencodeGo.id, opencodeGo);

  // OpenRouter chat and model discovery are temporarily disabled.
  // const openRouter = new OpenRouterProvider(_openRouterApiKey);
  // providers.set(openRouter.id, openRouter);

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

export function getModelCatalog(force = false) {
  for (const provider of providers.values()) void modelCatalog.refresh(provider, force);
  return modelCatalog.snapshot([...providers.values()]);
}

export function onModelCatalogChanged(listener: () => void): () => void {
  return modelCatalog.subscribe(listener);
}

export function getModelCatalogSnapshot() {
  return modelCatalog.snapshot([...providers.values()]);
}

export async function getAllModels(): Promise<ModelInfo[]> {
  return getModelCatalog().models;
}

export function getCachedModel(providerId: string, modelId: string): ModelInfo | undefined {
  const provider = providers.get(providerId);
  return provider ? modelCatalog.get(provider, modelId) : undefined;
}

export async function getModelsForProvider(providerId: string): Promise<ModelInfo[]> {
  const provider = providers.get(providerId);
  if (!provider) return [];
  return modelCatalog.refresh(provider);
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
