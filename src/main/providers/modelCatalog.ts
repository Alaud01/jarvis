import type { ModelDiscoverySource, ModelInfo, Provider } from './types';

interface SourceEntry {
  models: ModelInfo[];
  refreshAfter: number;
  pending?: Promise<void>;
  controller?: AbortController;
}
interface ProviderEntry {
  sources: Map<ModelDiscoverySource, SourceEntry>;
  pending?: Promise<ModelInfo[]>;
}

export const MODEL_DISCOVERY_TIMEOUT_MS = 5_000;

/** Each discovery source publishes and caches results independently. */
export class ModelCatalog {
  private readonly entries = new Map<Provider, ProviderEntry>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;

  constructor(
    private readonly timeoutMs = MODEL_DISCOVERY_TIMEOUT_MS,
    private readonly ttlMs = 5 * 60_000,
    private readonly retryMs = 30_000,
  ) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private changed(): void {
    this.revision++;
    for (const listener of this.listeners) listener();
  }

  snapshot(providers: readonly Provider[]) {
    return {
      revision: this.revision,
      models: providers.flatMap(provider => this.models(provider)),
      loading: providers.some(provider => [...(this.entries.get(provider)?.sources.values() ?? [])]
        .some(source => Boolean(source.pending))),
    };
  }

  private models(provider: Provider): ModelInfo[] {
    const models = new Map<string, ModelInfo>();
    for (const source of this.entries.get(provider)?.sources.values() ?? []) {
      for (const model of source.models) if (!models.has(model.id)) models.set(model.id, model);
    }
    return [...models.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(provider: Provider, modelId: string): ModelInfo | undefined {
    const entry = this.entries.get(provider);
    if (!entry || [...entry.sources.values()].some(source => source.refreshAfter <= Date.now())) {
      void this.refresh(provider);
    }
    for (const source of this.entries.get(provider)?.sources.values() ?? []) {
      const model = source.models.find(model => model.id === modelId);
      if (model) return model;
    }
    return undefined;
  }

  refresh(provider: Provider, force = false): Promise<ModelInfo[]> {
    let entry = this.entries.get(provider);
    if (!entry) {
      entry = { sources: new Map((provider.modelSources ?? [provider])
        .map(source => [source, { models: [], refreshAfter: 0 }])) };
      this.entries.set(provider, entry);
    }
    if (entry.pending) return entry.pending;
    const current = entry;
    const requests = [...entry.sources].map(([source, state]) => {
      if (state.pending) return state.pending;
      if (!force && state.refreshAfter > Date.now()) return Promise.resolve();
      const controller = new AbortController();
      state.controller = controller;
      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`Model discovery timed out for ${provider.id}/${source.id}`));
        }, this.timeoutMs);
      });
      state.pending = Promise.race([
        Promise.resolve().then(() => source.fetchModels(controller.signal)), timeout,
      ]).then(models => {
        if (this.entries.get(provider) !== current) return;
        // Explicit sources throw on failure, so an empty successful list is valid.
        // Legacy providers may return [] for a network failure.
        if (models.length || provider.modelSources) state.models = models;
        state.refreshAfter = Date.now() + (models.length || provider.modelSources ? this.ttlMs : this.retryMs);
      }).catch(error => {
        if (this.entries.get(provider) !== current) return;
        console.warn(`[Models] ${provider.id}/${source.id} discovery failed:`, error);
        state.refreshAfter = Date.now() + this.retryMs;
      }).finally(() => {
        clearTimeout(timer);
        state.pending = undefined;
        state.controller = undefined;
        if (this.entries.get(provider) === current) this.changed();
      });
      return state.pending;
    });
    current.pending = Promise.all(requests).then(() => this.models(provider)).finally(() => {
      current.pending = undefined;
    });
    if ([...entry.sources.values()].some(source => source.pending)) this.changed();
    return current.pending;
  }

  clear(): void {
    for (const entry of this.entries.values()) {
      for (const source of entry.sources.values()) source.controller?.abort();
    }
    this.entries.clear();
    this.changed();
  }
}
