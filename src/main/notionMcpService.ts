import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import { app, safeStorage, shell } from 'electron';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { ToolDefinition, ToolExecutionResult } from './providers/types';
import {
  formatMcpToolResult,
  projectNotionTools,
  validateProjectedNotionArguments,
  type NativeMcpTool,
  type ProjectedNotionTool,
} from './tools/notionMcpTools';

const NOTION_MCP_URL = new URL('https://mcp.notion.com/mcp');
const AUTH_FILE_NAME = 'notion-mcp-auth.json';
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

interface StoredNotionAuth {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  discoveryState?: OAuthDiscoveryState;
  redirectUrl?: string;
}

export type NotionConnectionState = 'disconnected' | 'connecting' | 'connected' | 'expired' | 'error';

export interface NotionConnectionStatus {
  state: NotionConnectionState;
  availableCapabilities: string[];
  unavailableCoreCapabilities: string[];
  message?: string;
}

interface CallbackServer {
  redirectUrl: string;
  waitForCode: Promise<string>;
  close(): Promise<void>;
}

class SecureNotionAuthStore {
  private get filePath(): string {
    return path.join(app.getPath('userData'), AUTH_FILE_NAME);
  }

  async load(): Promise<StoredNotionAuth> {
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as { encrypted?: unknown };
      if (typeof raw.encrypted !== 'string') return {};
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('Electron secure credential storage is unavailable.');
      }
      return JSON.parse(safeStorage.decryptString(Buffer.from(raw.encrypted, 'base64'))) as StoredNotionAuth;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }

  async save(value: StoredNotionAuth): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Electron secure credential storage is unavailable.');
    }
    const encrypted = safeStorage.encryptString(JSON.stringify(value)).toString('base64');
    const target = this.filePath;
    const temporary = `${target}.${process.pid}.tmp`;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(temporary, JSON.stringify({ version: 1, encrypted }), { mode: 0o600 });
    await fs.rename(temporary, target);
  }

  async clear(): Promise<void> {
    await fs.rm(this.filePath, { force: true });
  }
}

class PersistentNotionOAuthProvider implements OAuthClientProvider {
  private verifier = '';

  constructor(
    private readonly stored: StoredNotionAuth,
    private readonly persist: () => Promise<void>,
    private readonly authorizationState: string,
    private readonly interactive: boolean,
  ) {}

  get redirectUrl(): string | undefined {
    return this.stored.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    if (!this.stored.redirectUrl) throw new Error('Notion OAuth redirect URL is unavailable.');
    return {
      redirect_uris: [this.stored.redirectUrl],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'Jarvis',
      client_uri: 'https://github.com/Alaud01/assistant-app',
      software_id: 'com.jarvis.app',
      software_version: '1.0.0',
    };
  }

  state(): string {
    return this.authorizationState;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.stored.clientInformation;
  }

  async saveClientInformation(value: OAuthClientInformationMixed): Promise<void> {
    this.stored.clientInformation = value;
    await this.persist();
  }

  tokens(): OAuthTokens | undefined {
    return this.stored.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.stored.tokens = tokens;
    await this.persist();
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.interactive) throw new Error('Notion authorization must be restarted from Notion > Connect.');
    await shell.openExternal(url.toString());
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error('Notion OAuth PKCE verifier is unavailable.');
    return this.verifier;
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'all' || scope === 'client') delete this.stored.clientInformation;
    if (scope === 'all' || scope === 'tokens') delete this.stored.tokens;
    if (scope === 'all' || scope === 'discovery') delete this.stored.discoveryState;
    if (scope === 'all' || scope === 'verifier') this.verifier = '';
    await this.persist();
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    this.stored.discoveryState = state;
    await this.persist();
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.stored.discoveryState;
  }
}

function createCallbackServer(expectedState: string): Promise<CallbackServer> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let resolveCode: (code: string) => void;
    let rejectCode: (error: Error) => void;
    const waitForCode = new Promise<string>((innerResolve, innerReject) => {
      resolveCode = innerResolve;
      rejectCode = innerReject;
    });

    const server = http.createServer((request, response) => {
      const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
      if (requestUrl.pathname !== '/oauth/callback') {
        response.writeHead(404).end('Not found');
        return;
      }

      const error = requestUrl.searchParams.get('error');
      const code = requestUrl.searchParams.get('code');
      const state = requestUrl.searchParams.get('state');
      if (error) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Notion authorization was not completed. You may close this window.');
        rejectCode(new Error(`Notion authorization failed: ${error}`));
        return;
      }
      if (!code || state !== expectedState) {
        response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Invalid Notion authorization callback. You may close this window.');
        rejectCode(new Error('Notion authorization callback failed state validation.'));
        return;
      }

      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Notion is connected to Jarvis. You may close this window.');
      resolveCode(code);
    });

    server.once('error', (error) => {
      if (!settled) reject(error);
      rejectCode?.(error);
    });
    server.listen(0, '127.0.0.1', () => {
      settled = true;
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Unable to allocate the Notion OAuth callback port.'));
        return;
      }
      const timeout = setTimeout(() => rejectCode(new Error('Notion authorization timed out.')), AUTH_TIMEOUT_MS);
      waitForCode.finally(() => clearTimeout(timeout)).catch(() => undefined);
      resolve({
        redirectUrl: `http://127.0.0.1:${address.port}/oauth/callback`,
        waitForCode,
        close: () => new Promise<void>((closeResolve) => server.close(() => closeResolve())),
      });
    });
  });
}

const authStore = new SecureNotionAuthStore();
let storedAuth: StoredNotionAuth = {};
let persistenceQueue = Promise.resolve();
let client: Client | null = null;
let transport: StreamableHTTPClientTransport | null = null;
let projectedTools: ProjectedNotionTool[] = [];
let initialized = false;
let connectPromise: Promise<NotionConnectionStatus> | null = null;
let status: NotionConnectionStatus = {
  state: 'disconnected',
  availableCapabilities: [],
  unavailableCoreCapabilities: [],
};

function persistStoredAuth(): Promise<void> {
  persistenceQueue = persistenceQueue.catch(() => undefined).then(() => authStore.save(storedAuth));
  return persistenceQueue;
}

function setStatus(state: NotionConnectionState, message?: string): void {
  const availableCapabilities = projectedTools.map(tool => tool.definition.function.name);
  const expected = [
    'notion_search',
    'notion_fetch_page',
    'notion_query_data_source',
    'notion_create_page',
    'notion_append_blocks',
    'notion_update_page_properties',
    'notion_update_page_content',
    'notion_create_database',
    'notion_update_data_source',
    'notion_create_view',
    'notion_update_view',
    'notion_move_pages',
  ];
  status = {
    state,
    availableCapabilities,
    unavailableCoreCapabilities: state === 'connected'
      ? expected.filter(name => !availableCapabilities.includes(name))
      : [],
    ...(message ? { message } : {}),
  };
}

async function closeConnection(): Promise<void> {
  projectedTools = [];
  const activeClient = client;
  const activeTransport = transport;
  client = null;
  transport = null;
  await activeClient?.close().catch(() => undefined);
  await activeTransport?.close().catch(() => undefined);
}

async function listAllNativeTools(activeClient: Client): Promise<NativeMcpTool[]> {
  const tools: NativeMcpTool[] = [];
  let cursor: string | undefined;
  do {
    const result = await activeClient.listTools(cursor ? { cursor } : undefined);
    for (const tool of result.tools) {
      if (tool.inputSchema && typeof tool.inputSchema === 'object') {
        tools.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema as Record<string, unknown> });
      }
    }
    cursor = result.nextCursor;
  } while (cursor);
  return tools;
}

async function establishConnection(provider: PersistentNotionOAuthProvider): Promise<void> {
  const nextTransport = new StreamableHTTPClientTransport(NOTION_MCP_URL, { authProvider: provider });
  const nextClient = new Client({ name: 'jarvis', version: '1.0.0' });
  try {
    await nextClient.connect(nextTransport);
    const nativeTools = await listAllNativeTools(nextClient);
    client = nextClient;
    transport = nextTransport;
    projectedTools = projectNotionTools(nativeTools);
    setStatus('connected');
  } catch (error) {
    await nextClient.close().catch(() => undefined);
    await nextTransport.close().catch(() => undefined);
    throw error;
  }
}

export async function initializeNotionMcp(): Promise<NotionConnectionStatus> {
  if (initialized) return getNotionConnectionStatus();
  initialized = true;
  let hadStoredTokens = false;
  try {
    storedAuth = await authStore.load();
    hadStoredTokens = Boolean(storedAuth.tokens);
    if (!storedAuth.tokens || !storedAuth.redirectUrl) {
      setStatus('disconnected');
      return getNotionConnectionStatus();
    }
    const provider = new PersistentNotionOAuthProvider(storedAuth, persistStoredAuth, randomUUID(), false);
    await establishConnection(provider);
  } catch (error) {
    await closeConnection();
    const message = error instanceof Error ? error.message : 'Notion MCP connection could not be restored.';
    setStatus(hadStoredTokens ? 'expired' : 'error', message);
  }
  return getNotionConnectionStatus();
}

export async function connectNotionMcp(): Promise<NotionConnectionStatus> {
  if (status.state === 'connected') return getNotionConnectionStatus();
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    await initializeNotionMcp();
    await closeConnection();
    setStatus('connecting');
    const authorizationState = randomUUID();
    const callback = await createCallbackServer(authorizationState);
    try {
      storedAuth = { redirectUrl: callback.redirectUrl };
      await persistStoredAuth();
      const provider = new PersistentNotionOAuthProvider(storedAuth, persistStoredAuth, authorizationState, true);
      const authTransport = new StreamableHTTPClientTransport(NOTION_MCP_URL, { authProvider: provider });
      const authClient = new Client({ name: 'jarvis', version: '1.0.0' });
      try {
        await authClient.connect(authTransport);
        await authClient.close();
      } catch (error) {
        if (!(error instanceof UnauthorizedError)) throw error;
        const code = await callback.waitForCode;
        await authTransport.finishAuth(code);
      } finally {
        await authTransport.close().catch(() => undefined);
      }
      await establishConnection(provider);
      return getNotionConnectionStatus();
    } catch (error) {
      await closeConnection();
      const message = error instanceof Error ? error.message : 'Notion connection failed.';
      setStatus('error', message);
      throw error;
    } finally {
      await callback.close();
    }
  })().finally(() => {
    connectPromise = null;
  });

  return connectPromise;
}

export async function disconnectNotionMcp(): Promise<void> {
  await closeConnection();
  storedAuth = {};
  await persistenceQueue.catch(() => undefined);
  await authStore.clear();
  setStatus('disconnected');
}

export async function shutdownNotionMcp(): Promise<void> {
  await closeConnection();
}

export function getNotionConnectionStatus(): NotionConnectionStatus {
  return {
    ...status,
    availableCapabilities: [...status.availableCapabilities],
    unavailableCoreCapabilities: [...status.unavailableCoreCapabilities],
  };
}

export function getNotionPromptStatusLine(): string {
  if (status.state === 'connected') {
    const unavailable = status.unavailableCoreCapabilities;
    return unavailable.length > 0
      ? `Notion: connected; unavailable: ${unavailable.join(', ')}. Use only the available notion_* tools and clarify ambiguous targets. Prefer database, data-source, and view tools over emulating databases with page markdown or Browser Control.`
      : 'Notion: connected. Use only the available notion_* tools and clarify ambiguous targets. Prefer database, data-source, and view tools over emulating databases with page markdown or Browser Control.';
  }
  return 'Notion: disconnected. Ask the user to use Notion > Connect before Notion work.';
}

export function getNotionToolDefinitions(): ToolDefinition[] {
  return projectedTools.map(tool => tool.definition);
}

export function isNotionToolName(name: string): boolean {
  return projectedTools.some(tool => tool.definition.function.name === name);
}

export async function executeNotionMcpTool(
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  const tool = projectedTools.find(candidate => candidate.definition.function.name === name);
  if (!tool || !client || status.state !== 'connected') {
    return { success: false, content: 'Notion is not connected, or this Notion capability is unavailable.' };
  }
  const validationError = validateProjectedNotionArguments(tool, args);
  if (validationError) return { success: false, content: validationError };

  try {
    const result = await client.callTool(
      { name: tool.nativeName, arguments: args },
      undefined,
      signal ? { signal } : undefined,
    );
    return formatMcpToolResult(result);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown Notion MCP error.';
    if (error instanceof UnauthorizedError || /invalid_grant/i.test(errorMessage)) {
      delete storedAuth.tokens;
      await persistStoredAuth().catch(() => undefined);
      await closeConnection();
      setStatus('expired', 'Notion authorization expired. Reconnect from Notion > Connect.');
    }
    return {
      success: false,
      content: `Notion MCP tool failed.\nError: ${errorMessage}`,
    };
  }
}
