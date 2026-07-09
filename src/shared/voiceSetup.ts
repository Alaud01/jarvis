export type LocalVoiceModelStatusKind =
  | 'ready'
  | 'missing'
  | 'installing'
  | 'failed'
  | 'skipped';

export interface LocalVoiceModelStatus {
  status: LocalVoiceModelStatusKind;
  dependenciesInstalled: boolean;
  modelReady: boolean;
  installInProgress: boolean;
  managedServiceDir: string;
  pythonExecutable: string | null;
  modelName: string;
  estimatedDownloadSize: string;
  openRouterFallbackConfigured: boolean;
  lastStep?: string;
  lastError?: string;
  logs?: string[];
}

export interface LocalVoiceModelInstallResult {
  success: boolean;
  status: LocalVoiceModelStatus;
  error?: string;
}
