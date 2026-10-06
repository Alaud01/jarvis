import type { ModelInfo } from '../main/providers/types';

export interface ModelCatalogSnapshot {
  revision: number;
  models: ModelInfo[];
  loading: boolean;
}
