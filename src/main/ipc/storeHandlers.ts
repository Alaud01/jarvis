import { ipcMain, dialog, BrowserWindow } from 'electron';
import {
  loadConversation,
  loadConversationMetadata,
  loadConversations,
  saveConversation,
  saveConversationMetadata,
  saveConversations,
  deleteConversation,
  listDeletedConversations,
  restoreConversation,
  permanentlyDeleteConversation,
  startDeletedConversationCleanup,
  deleteFolderAndConversations,
  loadFolders,
  saveFolders,
  loadSelectedModel,
  saveSelectedModel,
  loadSelectedReasoningEffort,
  saveSelectedReasoningEffort,
  loadSelectedProvider,
  saveSelectedProvider,
  loadCurrentConversationId,
  saveCurrentConversationId,
  loadWorkspaceView,
  saveWorkspaceView,
  loadScrollPositions,
  saveScrollPositions,
  loadConversationDrafts,
  saveConversationDrafts,
  type SerializedConversation,
  type SerializedConversationMetadata,
  type SerializedFolder,
} from '../store';
import type { WorkspaceView } from '../../shared/workspaceViews';
import {
  deleteProviderConversationState,
  getAllModels,
  getModelCatalog,
  getModelCatalogSnapshot,
  onModelCatalogChanged,
  getAvailableProviders,
  getModelsForProvider,
  getProvider,
} from '../providers/registry';
import { ATTACHMENT_DIALOG_FILTERS, readAttachments } from '../attachmentService';
import { getLocalVoiceModelStatus, installLocalVoiceModel } from '../localVoiceModelSetup';
import { stopPythonService, startPythonService } from '../pythonService';
import { ONE_OFF_MODEL_KEEP_ALIVE } from '../app/lifecycle';
import { estimateTokenCount, getUsageDashboard, recordUsageEvent } from '../usageService';
import type { UsageDashboardQuery } from '../../shared/usage';
import type {
  CreateDictionaryEntryInput,
  CreateReplacementRuleInput,
  UpdateDictionaryEntryInput,
  UpdateReplacementRuleInput,
  UpdateVocabularyCandidateInput,
} from '../../shared/dictionary';
import {
  createDictionaryEntry,
  createReplacementRule,
  deleteDictionaryEntry,
  deleteReplacementRule,
  listDictionaryEntries,
  updateDictionaryEntry,
  updateReplacementRule,
  updateVocabularyCandidate,
} from '../dictionaryService';
export function registerStoreHandlers(): void {
  startDeletedConversationCleanup();
  ipcMain.handle('store:list-deleted-conversations', () => listDeletedConversations());
  ipcMain.handle('store:restore-conversation', (_event, id: string) => restoreConversation(id));
  ipcMain.handle('store:permanently-delete-conversation', async (_event, id: string) => {
    await permanentlyDeleteConversation(id);
    return { success: true };
  });
  ipcMain.handle('store:load-conversations', async () => {
    return loadConversations();
  });

  ipcMain.handle('store:load-conversation-list', async () => {
    return loadConversationMetadata();
  });

  ipcMain.handle('store:load-conversation', async (_event, id: string) => {
    return loadConversation(id);
  });

  ipcMain.handle('store:load-conversations-by-id', async (_event, ids: string[]) => {
    return loadConversations(ids);
  });

  ipcMain.handle('store:save-conversations', async (_event, conversations: unknown) => {
    await saveConversations(conversations as SerializedConversation[]);
    return { success: true };
  });

  ipcMain.handle('store:save-conversation-list', async (_event, metadata: unknown) => {
    await saveConversationMetadata(metadata as SerializedConversationMetadata[]);
    return { success: true };
  });

  ipcMain.handle('store:save-conversation', async (_event, conversation: unknown) => {
    await saveConversation(conversation as SerializedConversation);
    return { success: true };
  });

  ipcMain.handle('store:delete-conversation', async (_event, id: string) => {
    await deleteConversation(id);
    try {
      await deleteProviderConversationState([id]);
    } catch (error) {
      console.warn('Conversation deleted, but provider state cleanup failed:', error);
    }
    return { success: true };
  });

  ipcMain.handle('store:load-folders', async () => {
    return loadFolders();
  });

  ipcMain.handle('store:save-folders', async (_event, folders: unknown) => {
    saveFolders(folders as SerializedFolder[]);
    return { success: true };
  });

  ipcMain.handle('store:delete-folder', async (_event, id: string) => {
    const deletedConversationIds = await deleteFolderAndConversations(id);
    try {
      await deleteProviderConversationState(deletedConversationIds);
    } catch (error) {
      console.warn('Folder deleted, but provider state cleanup failed:', error);
    }
    return { success: true };
  });

  ipcMain.handle('store:load-model', async () => {
    return loadSelectedModel();
  });

  ipcMain.handle('store:save-model', async (_event, model: string) => {
    saveSelectedModel(model);
    return { success: true };
  });

  ipcMain.handle('store:load-reasoning-effort', async () => {
    return loadSelectedReasoningEffort();
  });

  ipcMain.handle('store:save-reasoning-effort', async (_event, effort: string) => {
    saveSelectedReasoningEffort(effort);
    return { success: true };
  });

  ipcMain.handle('store:load-provider', async () => {
    return loadSelectedProvider();
  });

  ipcMain.handle('store:save-provider', async (_event, provider: string) => {
    saveSelectedProvider(provider);
    return { success: true };
  });

  ipcMain.handle('store:load-current-conversation-id', async () => {
    return loadCurrentConversationId();
  });

  ipcMain.handle('store:save-current-conversation-id', async (_event, id: string | null) => {
    saveCurrentConversationId(id);
    return { success: true };
  });

  ipcMain.handle('store:load-workspace-view', async () => {
    return loadWorkspaceView();
  });

  ipcMain.handle('store:save-workspace-view', async (_event, view: WorkspaceView) => {
    saveWorkspaceView(view);
    return { success: true };
  });

  ipcMain.handle('store:load-scroll-positions', async () => {
    return loadScrollPositions();
  });

  ipcMain.handle('store:save-scroll-positions', async (_event, positions: Record<string, number>) => {
    saveScrollPositions(positions);
    return { success: true };
  });

  ipcMain.handle('store:load-conversation-drafts', async () => {
    return loadConversationDrafts();
  });

  ipcMain.handle('store:save-conversation-drafts', async (_event, drafts: Record<string, string>) => {
    saveConversationDrafts(drafts);
    return { success: true };
  });
}

export function registerDictionaryHandlers(): void {
  ipcMain.handle('dictionary:list', async () => {
    return listDictionaryEntries();
  });

  ipcMain.handle('dictionary:create', async (_event, input: CreateDictionaryEntryInput) => {
    return createDictionaryEntry(input);
  });

  ipcMain.handle('dictionary:update', async (_event, id: string, input: UpdateDictionaryEntryInput) => {
    return updateDictionaryEntry(id, input);
  });

  ipcMain.handle('dictionary:delete', async (_event, id: string) => {
    return deleteDictionaryEntry(id);
  });

  ipcMain.handle('dictionary:rule-create', async (_event, input: CreateReplacementRuleInput) => {
    return createReplacementRule(input);
  });

  ipcMain.handle('dictionary:rule-update', async (_event, id: string, input: UpdateReplacementRuleInput) => {
    return updateReplacementRule(id, input);
  });

  ipcMain.handle('dictionary:rule-delete', async (_event, id: string) => {
    return deleteReplacementRule(id);
  });

  ipcMain.handle('dictionary:candidate-update', async (_event, id: string, input: UpdateVocabularyCandidateInput) => {
    return updateVocabularyCandidate(id, input);
  });
}

export function registerModelHandlers(): void {
  onModelCatalogChanged(() => {
    const snapshot = getModelCatalogSnapshot();
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.webContents.isDestroyed()) window.webContents.send('model-catalog-changed', snapshot);
    }
  });
  ipcMain.handle('get-model-catalog', (_event, force?: boolean) => getModelCatalog(force === true));

  ipcMain.handle('get-models', async () => {
    return await getAllModels();
  });

  ipcMain.handle('get-models-for-provider', async (_event, providerId: string) => {
    return await getModelsForProvider(providerId);
  });

  ipcMain.handle('get-providers', async () => {
    return getAvailableProviders();
  });
}

export function registerAttachmentHandlers(): void {
  ipcMain.handle('pick-attachment-paths', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: ATTACHMENT_DIALOG_FILTERS,
    });

    if (result.canceled) {
      return [];
    }

    return result.filePaths;
  });

  ipcMain.handle('read-attachments', async (_event, filePaths: unknown) => {
    if (!Array.isArray(filePaths) || filePaths.some(filePath => typeof filePath !== 'string')) {
      return { attachments: [], errors: ['Invalid attachment request.'] };
    }

    return readAttachments(filePaths);
  });
}

export function registerVoiceModelHandlers(): void {
  ipcMain.handle('voice-model:status', async () => {
    return getLocalVoiceModelStatus();
  });

  ipcMain.handle('voice-model:install', async () => {
    const result = await installLocalVoiceModel();
    if (result.success) {
      await stopPythonService();
      void startPythonService().catch((error) => {
        console.error('[Main] Failed to restart Python voice service after local model install:', error);
      });
    }
    return result;
  });
}

export function registerGenerateTitleHandler(): void {
  ipcMain.handle('generate-title', async (_event, message: string, model: string, providerId: string) => {
    try {
      const provider = getProvider(providerId);
      if (!provider) {
        throw new Error(`Unknown provider: ${providerId}`);
      }
      const titleMessages = [
        { role: 'system' as const, content: 'Generate a very short title (3-6 words) for a conversation that starts with the following message. Return ONLY the title, nothing else. No quotes, no punctuation at the end.' },
        { role: 'user' as const, content: message },
      ];
      const startedAtMs = Date.now();
      const result = await provider.sendChat(model, titleMessages, { keepAlive: ONE_OFF_MODEL_KEEP_ALIVE });
      const title = result.trim();
      recordUsageEvent({
        model,
        provider: providerId,
        inputTokens: estimateTokenCount(titleMessages.map((m) => m.content).join('\n')),
        outputTokens: estimateTokenCount(title),
        generationMs: Math.max(1, Date.now() - startedAtMs),
        estimated: true,
      });
      return title;
    } catch (error) {
      console.error('Failed to generate title:', error);
      const words = message.split(' ').slice(0, 5);
      return words.join(' ') + (words.length < message.split(' ').length ? '...' : '');
    }
  });
}

export function registerUsageHandlers(): void {
  ipcMain.handle('usage:dashboard', async (_event, query: UsageDashboardQuery) => {
    return getUsageDashboard(query ?? { range: 'day' });
  });
}
