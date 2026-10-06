import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as readline from 'node:readline';
import {
  isSharedCredentialExpired,
  readSharedCodexCredential,
  SHARED_AUTH_EXPIRED_MESSAGE,
  SHARED_AUTH_MANAGED_MESSAGE,
  SHARED_AUTH_MISSING_MESSAGE,
  SharedCodexAuthError,
  sharedCredentialIdentity,
  type SharedCodexCredential,
} from './codexSharedAuth';

const APP_SERVER_REQUEST_TIMEOUT_MS = 30_000;
const CODEX_TURN_TIMEOUT_MS = 15 * 60_000;
const CODEX_LOGIN_TIMEOUT_MS = 5 * 60_000;
const STATE_VERSION = 1;
const SHARED_AUTH_REREAD_DELAY_MS = 100;

const PLATFORM_PACKAGE_BY_TARGET: Record<string, string> = {
  'x86_64-unknown-linux-musl': '@openai/codex-linux-x64',
  'aarch64-unknown-linux-musl': '@openai/codex-linux-arm64',
  'x86_64-apple-darwin': '@openai/codex-darwin-x64',
  'aarch64-apple-darwin': '@openai/codex-darwin-arm64',
  'x86_64-pc-windows-msvc': '@openai/codex-win32-x64',
  'aarch64-pc-windows-msvc': '@openai/codex-win32-arm64',
};

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface TurnWaiter {
  threadId: string;
  text: string;
  onDelta: (delta: string, phase?: CodexMessagePhase) => void;
  onTokenUsage?: (usage: CodexTokenUsageBreakdown) => void;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  error?: TurnFailure;
}

export interface CodexDynamicToolFunction {
  type: 'function';
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface CodexDynamicToolNamespace {
  type: 'namespace';
  name: string;
  description: string;
  tools: CodexDynamicToolFunction[];
}

export type CodexDynamicTool = CodexDynamicToolFunction | CodexDynamicToolNamespace;

export interface CodexDynamicToolResult {
  content: string;
  success: boolean;
  imageUrls?: string[];
}

export type CodexDynamicToolContentItem =
  | { type: 'inputText'; text: string }
  | { type: 'inputImage'; imageUrl: string };

export type CodexDynamicToolHandler = (
  tool: string,
  argumentsValue: Record<string, unknown>,
) => Promise<CodexDynamicToolResult>;

interface EarlyTurnEvents {
  deltas: Array<{ delta: string; phase?: CodexMessagePhase }>;
  tokenUsage?: CodexTokenUsageBreakdown[];
  completion?: TurnCompletion;
  error?: TurnFailure;
}

interface TurnFailure {
  message: string;
  codexErrorInfo: unknown;
}

interface TurnCompletion {
  status: string;
  error?: TurnFailure;
}

interface LoginCompletion {
  success: boolean;
  error?: string | null;
}

interface LoginWaiter {
  resolve: (completion: LoginCompletion) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export interface CodexConversationThreadRecord {
  threadId: string;
  syncedMessageCount: number;
  syncedPrefixFingerprint: string;
  toolSchemaFingerprint: string;
}

interface CodexRuntimeState {
  version: number;
  conversations: Record<string, CodexConversationThreadRecord>;
  pendingDeleteThreadIds: string[];
}

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  hidden?: boolean;
  isDefault?: boolean;
  supportedReasoningEfforts?: Array<{ reasoningEffort: string; description?: string }>;
  defaultReasoningEffort?: string;
}

export interface CodexAccountStatus {
  connected: boolean;
  type: 'chatgpt' | 'apiKey' | 'amazonBedrock' | null;
  email?: string;
  planType?: string;
}

export type CodexUserInput =
  | { type: 'text'; text: string; text_elements: [] }
  | { type: 'image'; url: string };

export type CodexMessagePhase = 'commentary' | 'final_answer';

export interface CodexTokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface RunCodexTurnOptions {
  threadId: string;
  model: string;
  effort?: string;
  input: CodexUserInput[];
  signal?: AbortSignal;
  onDelta: (delta: string, phase?: CodexMessagePhase) => void;
  onTokenUsage?: (usage: CodexTokenUsageBreakdown) => void;
  onToolCall?: CodexDynamicToolHandler;
}

export interface StartCodexThreadOptions {
  model: string;
  developerInstructions: string;
  ephemeral: boolean;
  dynamicTools: CodexDynamicTool[];
}

export interface CodexAppServerOptions {
  codexHome: string;
  workspaceRoot: string;
  openExternal: (url: string) => Promise<void>;
  binaryPath?: string;
  /**
   * auth.json managed by Codex Switcher. When set, Jarvis supplies that
   * file's access token to the app-server as external auth instead of using
   * its private login.
   */
  sharedAuthPath?: string;
}

export function buildChatGptLoginParams(): {
  type: 'chatgpt';
  useHostedLoginSuccessPage: false;
} {
  return {
    type: 'chatgpt',
    useHostedLoginSuccessPage: false,
  };
}

/** A failed Codex turn, carrying the app-server's structured error code. */
export class CodexTurnError extends Error {
  constructor(message: string, readonly codexErrorInfo: unknown) {
    super(message);
    this.name = 'CodexTurnError';
  }
}

export class CodexAppServerError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'CodexAppServerError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSupportedCodexToolImageUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export function buildCodexDynamicToolContentItems(
  result: CodexDynamicToolResult,
): CodexDynamicToolContentItem[] {
  const contentItems: CodexDynamicToolContentItem[] = [
    { type: 'inputText', text: result.content },
  ];
  for (const imageUrl of result.imageUrls ?? []) {
    // The ChatGPT-account Codex backend rejects data: URLs in dynamic-tool
    // outputs even though the public Responses API accepts them as user input.
    // Keep the text result usable and only forward remotely fetchable images.
    if (isSupportedCodexToolImageUrl(imageUrl)) {
      contentItems.push({ type: 'inputImage', imageUrl });
    }
  }
  return contentItems;
}

function parseTokenUsageBreakdown(value: unknown): CodexTokenUsageBreakdown | null {
  if (!isRecord(value)) return null;
  const fields = [
    'totalTokens',
    'inputTokens',
    'cachedInputTokens',
    'outputTokens',
    'reasoningOutputTokens',
  ] as const;
  if (fields.some((field) => typeof value[field] !== 'number' || !Number.isFinite(value[field]))) {
    return null;
  }
  return {
    totalTokens: Math.max(0, value.totalTokens as number),
    inputTokens: Math.max(0, value.inputTokens as number),
    cachedInputTokens: Math.max(0, value.cachedInputTokens as number),
    outputTokens: Math.max(0, value.outputTokens as number),
    reasoningOutputTokens: Math.max(0, value.reasoningOutputTokens as number),
  };
}

function subtractTokenUsage(
  current: CodexTokenUsageBreakdown,
  previous: CodexTokenUsageBreakdown,
): CodexTokenUsageBreakdown {
  return {
    totalTokens: Math.max(0, current.totalTokens - previous.totalTokens),
    inputTokens: Math.max(0, current.inputTokens - previous.inputTokens),
    cachedInputTokens: Math.max(0, current.cachedInputTokens - previous.cachedInputTokens),
    outputTokens: Math.max(0, current.outputTokens - previous.outputTokens),
    reasoningOutputTokens: Math.max(0, current.reasoningOutputTokens - previous.reasoningOutputTokens),
  };
}

function targetTripleForCurrentPlatform(): string {
  if (process.platform === 'darwin') {
    if (process.arch === 'arm64') return 'aarch64-apple-darwin';
    if (process.arch === 'x64') return 'x86_64-apple-darwin';
  }
  if (process.platform === 'linux') {
    if (process.arch === 'arm64') return 'aarch64-unknown-linux-musl';
    if (process.arch === 'x64') return 'x86_64-unknown-linux-musl';
  }
  if (process.platform === 'win32') {
    if (process.arch === 'arm64') return 'aarch64-pc-windows-msvc';
    if (process.arch === 'x64') return 'x86_64-pc-windows-msvc';
  }
  throw new Error(`Codex is not bundled for ${process.platform} (${process.arch}).`);
}

function unpackedAsarPath(candidate: string): string {
  return candidate.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
}

export function resolveBundledCodexBinary(): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    const packagedBinary = path.join(
      resourcesPath,
      'codex',
      'bin',
      process.platform === 'win32' ? 'codex.exe' : 'codex',
    );
    if (existsSync(packagedBinary)) return packagedBinary;
  }

  const targetTriple = targetTripleForCurrentPlatform();
  const platformPackage = PLATFORM_PACKAGE_BY_TARGET[targetTriple];
  if (!platformPackage) {
    throw new Error(`No bundled Codex package is configured for ${targetTriple}.`);
  }

  let packageJsonPath: string;
  try {
    const codexPackageJsonPath = require.resolve('@openai/codex/package.json');
    const requireFromCodexPackage = createRequire(codexPackageJsonPath);
    packageJsonPath = requireFromCodexPackage.resolve(`${platformPackage}/package.json`);
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : '';
    const missingRuntimeError = new Error(
      `The bundled Codex runtime (${platformPackage}) is missing. Reinstall Jarvis dependencies.${detail}`,
    );
    (missingRuntimeError as Error & { cause?: unknown }).cause = error;
    throw missingRuntimeError;
  }

  const executableName = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const candidate = path.join(
    path.dirname(packageJsonPath),
    'vendor',
    targetTriple,
    'bin',
    executableName,
  );
  const unpackedCandidate = unpackedAsarPath(candidate);
  const resolvedCandidate = unpackedCandidate !== candidate && existsSync(unpackedCandidate)
    ? unpackedCandidate
    : candidate;

  if (!existsSync(resolvedCandidate)) {
    throw new Error(`The bundled Codex executable was not found at ${resolvedCandidate}.`);
  }
  return resolvedCandidate;
}

export function buildIsolatedCodexEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
  codexHome: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...baseEnvironment,
    CODEX_HOME: codexHome,
    CODEX_SQLITE_HOME: codexHome,
  };

  // Jarvis intentionally authenticates through its private app-server home.
  // Do not let a parent-shell API key silently change the account mode.
  delete environment.OPENAI_API_KEY;
  return environment;
}

function createEmptyState(): CodexRuntimeState {
  return {
    version: STATE_VERSION,
    conversations: {},
    pendingDeleteThreadIds: [],
  };
}

function parseRuntimeState(value: unknown): CodexRuntimeState {
  if (!isRecord(value) || value.version !== STATE_VERSION || !isRecord(value.conversations)) {
    return createEmptyState();
  }

  const conversations: Record<string, CodexConversationThreadRecord> = {};
  for (const [conversationId, rawRecord] of Object.entries(value.conversations)) {
    if (
      isRecord(rawRecord)
      && typeof rawRecord.threadId === 'string'
      && typeof rawRecord.syncedMessageCount === 'number'
      && Number.isInteger(rawRecord.syncedMessageCount)
      && rawRecord.syncedMessageCount >= 0
    ) {
      conversations[conversationId] = {
        threadId: rawRecord.threadId,
        syncedMessageCount: rawRecord.syncedMessageCount,
        syncedPrefixFingerprint: typeof rawRecord.syncedPrefixFingerprint === 'string'
          ? rawRecord.syncedPrefixFingerprint
          : '',
        toolSchemaFingerprint: typeof rawRecord.toolSchemaFingerprint === 'string'
          ? rawRecord.toolSchemaFingerprint
          : '',
      };
    }
  }

  const pendingDeleteThreadIds = Array.isArray(value.pendingDeleteThreadIds)
    ? value.pendingDeleteThreadIds.filter((item): item is string => typeof item === 'string')
    : [];

  return {
    version: STATE_VERSION,
    conversations,
    pendingDeleteThreadIds: [...new Set(pendingDeleteThreadIds)],
  };
}

function abortError(): Error {
  const error = new Error('Codex generation was cancelled.');
  error.name = 'AbortError';
  return error;
}

function turnCompletionFromParams(params: Record<string, unknown>): TurnCompletion {
  const turn = isRecord(params.turn) ? params.turn : {};
  return {
    status: typeof turn.status === 'string' ? turn.status : 'failed',
    error: turnFailureFromValue(turn.error),
  };
}

function turnFailureFromValue(value: unknown): TurnFailure | undefined {
  if (!isRecord(value) || typeof value.message !== 'string') return undefined;
  return { message: value.message, codexErrorInfo: value.codexErrorInfo ?? null };
}

function accountStatusFromResponse(response: unknown): CodexAccountStatus {
  if (!isRecord(response) || !isRecord(response.account)) {
    return { connected: false, type: null };
  }

  const account = response.account;
  const type = account.type;
  if (type === 'chatgpt') {
    return {
      connected: true,
      type,
      email: typeof account.email === 'string' ? account.email : undefined,
      planType: typeof account.planType === 'string' ? account.planType : undefined,
    };
  }
  if (type === 'apiKey' || type === 'amazonBedrock') {
    return { connected: true, type };
  }
  return { connected: false, type: null };
}

export function isMissingThreadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /thread|rollout|session/i.test(error.message)
    && /not found|no (?:thread|rollout|session) found|missing|does not exist/i.test(error.message);
}

function validateLoginUrl(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Codex did not return a ChatGPT sign-in URL.');
  }
  const url = new URL(value);
  const allowedHost = url.hostname === 'chatgpt.com'
    || url.hostname === 'auth.openai.com'
    || url.hostname.endsWith('.openai.com')
    || url.hostname.endsWith('.chatgpt.com');
  if (url.protocol !== 'https:' || !allowedHost) {
    throw new Error('Codex returned an unexpected ChatGPT sign-in URL.');
  }
  return url.toString();
}

export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private startPromise: Promise<void> | null = null;
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly turnWaiters = new Map<string, TurnWaiter>();
  private readonly earlyTurnEvents = new Map<string, EarlyTurnEvents>();
  private readonly threadTokenUsageTotals = new Map<string, CodexTokenUsageBreakdown>();
  private readonly agentMessagePhases = new Map<string, CodexMessagePhase>();
  private readonly activeToolHandlers = new Map<string, CodexDynamicToolHandler>();
  private readonly loginWaiters = new Map<string, LoginWaiter>();
  private readonly earlyLoginCompletions = new Map<string, LoginCompletion>();
  private loginPromise: Promise<CodexAccountStatus> | null = null;
  private runtimeState: CodexRuntimeState | null = null;
  private stateLoadPromise: Promise<void> | null = null;
  private stateWritePromise: Promise<void> = Promise.resolve();
  private stopping = false;
  private stderrTail = '';
  private suppliedSharedCredential: SharedCodexCredential | null = null;
  private sharedAuthQueue: Promise<unknown> = Promise.resolve();
  private sharedTurnReservations = 0;

  constructor(private readonly options: CodexAppServerOptions) {}

  private get statePath(): string {
    return path.join(this.options.codexHome, 'jarvis-thread-map.json');
  }

  private async prepareDirectories(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.options.codexHome, { recursive: true, mode: 0o700 }),
      fs.mkdir(this.options.workspaceRoot, { recursive: true, mode: 0o700 }),
    ]);
    if (process.platform !== 'win32') {
      await Promise.allSettled([
        fs.chmod(this.options.codexHome, 0o700),
        fs.chmod(this.options.workspaceRoot, 0o700),
      ]);
    }
  }

  private async loadRuntimeState(): Promise<void> {
    if (this.runtimeState) return;
    if (this.stateLoadPromise) return this.stateLoadPromise;

    this.stateLoadPromise = (async () => {
      await this.prepareDirectories();
      try {
        const serialized = await fs.readFile(this.statePath, 'utf8');
        this.runtimeState = parseRuntimeState(JSON.parse(serialized));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && !(error instanceof SyntaxError)) {
          throw error;
        }
        this.runtimeState = createEmptyState();
      }
    })().finally(() => {
      this.stateLoadPromise = null;
    });

    return this.stateLoadPromise;
  }

  private async persistRuntimeState(): Promise<void> {
    await this.loadRuntimeState();
    this.stateWritePromise = this.stateWritePromise.catch(() => undefined).then(async () => {
      const temporaryPath = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
      const serialized = `${JSON.stringify(this.runtimeState, null, 2)}\n`;
      await fs.writeFile(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporaryPath, this.statePath);
      if (process.platform !== 'win32') {
        await fs.chmod(this.statePath, 0o600);
      }
    });
    return this.stateWritePromise;
  }

  private send(message: unknown): void {
    if (!this.child || this.child.stdin.destroyed) {
      throw new Error('Codex app-server is not running.');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private requestStarted<T>(method: string, params?: unknown, timeoutMs = APP_SERVER_REQUEST_TIMEOUT_MS): Promise<T> {
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new CodexAppServerError(`Codex app-server timed out handling ${method}.`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        method,
        resolve: value => resolve(value as T),
        reject,
        timeout,
      });

      try {
        this.send({ method, id, params });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(error);
      }
    });
  }

  private async request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    await this.ensureStarted();
    return this.requestStarted<T>(method, params, timeoutMs);
  }

  private handleResponse(message: Record<string, unknown>): void {
    if (typeof message.id !== 'number') return;
    const pending = this.pendingRequests.get(message.id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(message.id);
    if (isRecord(message.error)) {
      const rpcError = message.error as unknown as JsonRpcError;
      pending.reject(new CodexAppServerError(
        typeof rpcError.message === 'string'
          ? rpcError.message
          : `Codex app-server failed handling ${pending.method}.`,
        typeof rpcError.code === 'number' ? rpcError.code : undefined,
        rpcError.data,
      ));
      return;
    }
    pending.resolve(message.result);
  }

  private handleTurnDelta(params: Record<string, unknown>): void {
    const turnId = typeof params.turnId === 'string' ? params.turnId : null;
    const itemId = typeof params.itemId === 'string' ? params.itemId : null;
    const delta = typeof params.delta === 'string' ? params.delta : null;
    if (!turnId || delta === null) return;
    const phase = itemId ? this.agentMessagePhases.get(itemId) : undefined;

    const waiter = this.turnWaiters.get(turnId);
    if (waiter) {
      if (phase !== 'commentary') waiter.text += delta;
      waiter.onDelta(delta, phase);
      return;
    }

    const early = this.earlyTurnEvents.get(turnId) ?? { deltas: [] };
    early.deltas.push({ delta, phase });
    this.earlyTurnEvents.set(turnId, early);
  }

  private handleTokenUsage(params: Record<string, unknown>): void {
    const threadId = typeof params.threadId === 'string' ? params.threadId : null;
    const turnId = typeof params.turnId === 'string' ? params.turnId : null;
    const tokenUsage = isRecord(params.tokenUsage) ? params.tokenUsage : null;
    const total = parseTokenUsageBreakdown(tokenUsage?.total);
    const last = parseTokenUsageBreakdown(tokenUsage?.last);
    if (!threadId || !turnId || !total || !last) return;

    const previousTotal = this.threadTokenUsageTotals.get(threadId);
    const turnUsage = previousTotal ? subtractTokenUsage(total, previousTotal) : last;
    this.threadTokenUsageTotals.set(threadId, total);
    if (turnUsage.inputTokens <= 0 && turnUsage.outputTokens <= 0) return;

    const waiter = this.turnWaiters.get(turnId);
    if (waiter) {
      waiter.onTokenUsage?.(turnUsage);
      return;
    }

    const early = this.earlyTurnEvents.get(turnId) ?? { deltas: [] };
    (early.tokenUsage ??= []).push(turnUsage);
    this.earlyTurnEvents.set(turnId, early);
  }

  private handleItemLifecycle(params: Record<string, unknown>): void {
    const item = isRecord(params.item) ? params.item : null;
    if (!item || item.type !== 'agentMessage' || typeof item.id !== 'string') return;
    if (item.phase === 'commentary' || item.phase === 'final_answer') {
      this.agentMessagePhases.set(item.id, item.phase);
    }
  }

  private settleTurn(turnId: string, completion: TurnCompletion): void {
    const waiter = this.turnWaiters.get(turnId);
    if (!waiter) {
      const early = this.earlyTurnEvents.get(turnId) ?? { deltas: [] };
      early.completion = completion;
      this.earlyTurnEvents.set(turnId, early);
      return;
    }

    clearTimeout(waiter.timeout);
    this.turnWaiters.delete(turnId);
    const completionError = completion.error ?? waiter.error;
    if (completion.status === 'completed' && !completionError) {
      waiter.resolve(waiter.text);
      return;
    }
    if (completion.status === 'interrupted') {
      waiter.reject(abortError());
      return;
    }
    waiter.reject(completionError
      ? new CodexTurnError(completionError.message, completionError.codexErrorInfo)
      : new Error(`Codex turn ended with status ${completion.status}.`));
  }

  private handleTurnCompletion(params: Record<string, unknown>): void {
    const turn = isRecord(params.turn) ? params.turn : null;
    const turnId = turn && typeof turn.id === 'string' ? turn.id : null;
    if (!turnId) return;
    this.settleTurn(turnId, turnCompletionFromParams(params));
  }

  private handleTurnError(params: Record<string, unknown>): void {
    const threadId = typeof params.threadId === 'string' ? params.threadId : null;
    // Codex retries transient stream errors itself; only terminal ones fail the turn.
    if (!threadId || params.willRetry === true) return;
    const failure = turnFailureFromValue(params.error)
      ?? { message: 'Codex turn failed.', codexErrorInfo: null };

    const waiterEntry = [...this.turnWaiters.entries()].find(([, waiter]) => waiter.threadId === threadId);
    if (waiterEntry) {
      const [, waiter] = waiterEntry;
      waiter.error = failure;
    }
  }

  private handleLoginCompletion(params: Record<string, unknown>): void {
    const loginId = typeof params.loginId === 'string' ? params.loginId : null;
    if (!loginId) return;
    const completion: LoginCompletion = {
      success: params.success === true,
      error: typeof params.error === 'string' ? params.error : null,
    };
    const waiter = this.loginWaiters.get(loginId);
    if (!waiter) {
      this.earlyLoginCompletions.set(loginId, completion);
      return;
    }
    clearTimeout(waiter.timeout);
    this.loginWaiters.delete(loginId);
    waiter.resolve(completion);
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case 'item/agentMessage/delta':
        this.handleTurnDelta(params);
        break;
      case 'item/started':
      case 'item/completed':
        this.handleItemLifecycle(params);
        break;
      case 'turn/completed':
        this.handleTurnCompletion(params);
        break;
      case 'thread/tokenUsage/updated':
        this.handleTokenUsage(params);
        break;
      case 'error':
        this.handleTurnError(params);
        break;
      case 'account/login/completed':
        this.handleLoginCompletion(params);
        break;
      default:
        break;
    }
  }

  private async handleServerRequest(message: Record<string, unknown>): Promise<void> {
    const id = message.id;
    if (message.method === 'account/chatgptAuthTokens/refresh' && this.options.sharedAuthPath) {
      await this.answerSharedAuthRefresh(id);
      return;
    }
    if (message.method !== 'item/tool/call') {
      this.send({
        id,
        error: { code: -32601, message: `Jarvis does not support ${String(message.method)}.` },
      });
      return;
    }

    const params = isRecord(message.params) ? message.params : {};
    const threadId = typeof params.threadId === 'string' ? params.threadId : null;
    const namespace = typeof params.namespace === 'string' ? params.namespace : null;
    const tool = typeof params.tool === 'string' ? params.tool : null;
    const argumentsValue = isRecord(params.arguments) ? params.arguments : null;
    const handler = threadId ? this.activeToolHandlers.get(threadId) : undefined;

    if (!handler || namespace !== 'jarvis' || !tool || !argumentsValue) {
      this.send({
        id,
        result: {
          success: false,
          contentItems: [{
            type: 'inputText',
            text: 'Jarvis rejected an unavailable or invalid dynamic tool call.',
          }],
        },
      });
      return;
    }

    try {
      const result = await handler(tool, argumentsValue);
      this.send({
        id,
        result: {
          success: result.success,
          contentItems: buildCodexDynamicToolContentItems(result),
        },
      });
    } catch (error) {
      this.send({
        id,
        result: {
          success: false,
          contentItems: [{
            type: 'inputText',
            text: error instanceof Error ? error.message : 'Jarvis tool execution failed.',
          }],
        },
      });
    }
  }

  private handleServerMessage(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      console.warn('[Codex] Ignored a non-JSON app-server output line.');
      return;
    }
    if (!isRecord(parsed)) return;

    if ('id' in parsed && typeof parsed.method !== 'string') {
      this.handleResponse(parsed);
      return;
    }

    if (typeof parsed.method !== 'string') return;
    if ('id' in parsed) {
      void this.handleServerRequest(parsed).catch(error => {
        console.error('[Codex] Failed to handle an app-server request:', error);
      });
      return;
    }

    this.handleNotification(parsed.method, isRecord(parsed.params) ? parsed.params : {});
  }

  private rejectOutstanding(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();

    for (const waiter of this.turnWaiters.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.turnWaiters.clear();
    this.earlyTurnEvents.clear();
    this.agentMessagePhases.clear();
    this.activeToolHandlers.clear();

    for (const waiter of this.loginWaiters.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.loginWaiters.clear();
    this.earlyLoginCompletions.clear();
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    const wasStopping = this.stopping;
    this.child = null;
    // External auth lives only in the app-server's memory.
    this.suppliedSharedCredential = null;
    this.startPromise = null;
    this.stopping = false;
    const detail = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
    const stderrDetail = this.stderrTail.trim() ? ` ${this.stderrTail.trim().slice(-500)}` : '';
    this.stderrTail = '';
    const error = wasStopping
      ? new Error('Codex app-server stopped.')
      : new Error(`Codex app-server stopped unexpectedly (${detail}).${stderrDetail}`);
    this.rejectOutstanding(error);
  }

  private async start(): Promise<void> {
    await this.prepareDirectories();
    await this.loadRuntimeState();
    const binaryPath = this.options.binaryPath ?? resolveBundledCodexBinary();
    const child = spawn(binaryPath, ['app-server', '--listen', 'stdio://'], {
      cwd: this.options.workspaceRoot,
      env: buildIsolatedCodexEnvironment(process.env, this.options.codexHome),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.stderrTail = '';

    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', line => this.handleServerMessage(line));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4_000);
    });
    child.on('error', error => {
      this.rejectOutstanding(new Error(`Unable to start the bundled Codex app-server. ${error.message}`));
    });
    child.on('exit', (code, signal) => this.handleExit(code, signal));

    await this.requestStarted('initialize', {
      clientInfo: {
        name: 'jarvis_desktop',
        title: 'Jarvis Desktop',
        version: '1.0.0',
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    this.send({ method: 'initialized', params: {} });
    await this.flushPendingDeletesStarted();
  }

  private async ensureStarted(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.child) return;
    this.startPromise = this.start().catch(error => {
      const child = this.child;
      this.child = null;
      if (child && !child.killed) child.kill('SIGTERM');
      throw error;
    }).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async flushPendingDeletesStarted(): Promise<void> {
    if (!this.runtimeState || this.runtimeState.pendingDeleteThreadIds.length === 0) return;
    const remaining: string[] = [];
    for (const threadId of this.runtimeState.pendingDeleteThreadIds) {
      try {
        await this.requestStarted('thread/delete', { threadId });
      } catch (error) {
        if (!isMissingThreadError(error)) remaining.push(threadId);
      }
    }
    this.runtimeState.pendingDeleteThreadIds = remaining;
    await this.persistRuntimeState();
  }

  get followsSharedAuth(): boolean {
    return Boolean(this.options.sharedAuthPath);
  }

  /** Identity of the Codex Switcher account currently selected on disk. */
  async readSharedAccountIdentity(): Promise<string | null> {
    if (!this.options.sharedAuthPath) return null;
    const credential = await readSharedCodexCredential(this.options.sharedAuthPath);
    return credential ? sharedCredentialIdentity(credential) : null;
  }

  private async readUsableSharedCredential(): Promise<SharedCodexCredential> {
    const authPath = this.options.sharedAuthPath as string;
    let credential = await readSharedCodexCredential(authPath);
    if (!credential) {
      // Codex Switcher may be mid-rewrite; give it a moment before giving up.
      await new Promise(resolve => setTimeout(resolve, SHARED_AUTH_REREAD_DELAY_MS));
      credential = await readSharedCodexCredential(authPath);
    }
    if (!credential) throw new SharedCodexAuthError(SHARED_AUTH_MISSING_MESSAGE);
    if (isSharedCredentialExpired(credential)) throw new SharedCodexAuthError(SHARED_AUTH_EXPIRED_MESSAGE);
    return credential;
  }

  /**
   * Supplies the Codex Switcher account to the app-server. Switching accounts
   * takes effect for later requests without a restart. Returns the identity
   * of the supplied account (null in private mode).
   */
  async syncSharedAuth(): Promise<string | null> {
    if (!this.options.sharedAuthPath) return null;
    return this.syncSharedAuthStep(false);
  }

  /**
   * Syncs, then holds the supplied account fixed until `release` so the turn
   * opens its model connection as the account it reports.
   */
  async reserveSharedAccountForTurn(): Promise<{ identity: string | null; release: () => void }> {
    if (!this.options.sharedAuthPath) return { identity: null, release: () => undefined };
    const identity = await this.syncSharedAuthStep(true);
    let released = false;
    return {
      identity,
      release: () => {
        if (released) return;
        released = true;
        this.sharedTurnReservations -= 1;
      },
    };
  }

  private syncSharedAuthStep(reserve: boolean): Promise<string> {
    // Serialized so reading, supplying, and reserving are one atomic step.
    const sync = this.sharedAuthQueue.catch(() => undefined).then(async () => {
      await this.ensureStarted();
      const credential = await this.readUsableSharedCredential();
      const supplied = this.suppliedSharedCredential;
      if (
        supplied
        && this.sharedTurnReservations > 0
        && sharedCredentialIdentity(supplied) !== sharedCredentialIdentity(credential)
      ) {
        // A running turn's connection belongs to the supplied account. Defer
        // the switch until no turn holds it rather than waiting, which could
        // deadlock a request nested inside a turn.
        if (reserve) this.sharedTurnReservations += 1;
        return sharedCredentialIdentity(supplied);
      }
      if (credential.accessToken !== supplied?.accessToken) {
        await this.requestStarted('account/login/start', {
          type: 'chatgptAuthTokens',
          accessToken: credential.accessToken,
          chatgptAccountId: credential.accountId,
          chatgptPlanType: credential.planType,
        });
        this.suppliedSharedCredential = credential;
      }
      if (reserve) this.sharedTurnReservations += 1;
      return sharedCredentialIdentity(credential);
    });
    this.sharedAuthQueue = sync;
    return sync;
  }

  /**
   * The app-server asks for a new token after a 401; Codex Switcher owns
   * refreshing it, so answer with whatever the file holds now. The rejected
   * token may be older than the last one Jarvis supplied, and Codex retries
   * only once after a refresh, so this cannot loop.
   */
  private async answerSharedAuthRefresh(id: unknown): Promise<void> {
    try {
      const credential = await this.readUsableSharedCredential();
      this.suppliedSharedCredential = credential;
      this.send({
        id,
        result: {
          accessToken: credential.accessToken,
          chatgptAccountId: credential.accountId,
          chatgptPlanType: credential.planType,
        },
      });
    } catch (error) {
      this.send({
        id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : SHARED_AUTH_EXPIRED_MESSAGE,
        },
      });
    }
  }

  async listModels(): Promise<CodexModel[]> {
    await this.syncSharedAuth();
    const result = await this.request<unknown>('model/list', { limit: 100, includeHidden: false });
    if (!isRecord(result) || !Array.isArray(result.data)) return [];
    return result.data.flatMap(rawModel => {
      if (!isRecord(rawModel) || typeof rawModel.model !== 'string') return [];
      return [{
        id: typeof rawModel.id === 'string' ? rawModel.id : rawModel.model,
        model: rawModel.model,
        displayName: typeof rawModel.displayName === 'string' ? rawModel.displayName : rawModel.model,
        hidden: rawModel.hidden === true,
        isDefault: rawModel.isDefault === true,
        supportedReasoningEfforts: Array.isArray(rawModel.supportedReasoningEfforts)
          ? rawModel.supportedReasoningEfforts.flatMap(rawEffort => (
            isRecord(rawEffort) && typeof rawEffort.reasoningEffort === 'string'
              ? [{
                  reasoningEffort: rawEffort.reasoningEffort,
                  ...(typeof rawEffort.description === 'string' ? { description: rawEffort.description } : {}),
                }]
              : []
          ))
          : undefined,
        defaultReasoningEffort: typeof rawModel.defaultReasoningEffort === 'string'
          ? rawModel.defaultReasoningEffort
          : undefined,
      }];
    });
  }

  async getAccountStatus(refreshToken = false): Promise<CodexAccountStatus> {
    if (this.options.sharedAuthPath) {
      try {
        await this.syncSharedAuth();
      } catch (error) {
        if (error instanceof SharedCodexAuthError) return { connected: false, type: null };
        throw error;
      }
    }
    const response = await this.request<unknown>('account/read', { refreshToken });
    return accountStatusFromResponse(response);
  }

  private waitForLogin(loginId: string): Promise<LoginCompletion> {
    const early = this.earlyLoginCompletions.get(loginId);
    if (early) {
      this.earlyLoginCompletions.delete(loginId);
      return Promise.resolve(early);
    }

    return new Promise<LoginCompletion>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.loginWaiters.delete(loginId);
        reject(new Error('Timed out waiting for ChatGPT sign-in to finish.'));
      }, CODEX_LOGIN_TIMEOUT_MS);
      this.loginWaiters.set(loginId, { resolve, reject, timeout });
    });
  }

  private discardLoginWaiter(loginId: string): void {
    const waiter = this.loginWaiters.get(loginId);
    if (waiter) clearTimeout(waiter.timeout);
    this.loginWaiters.delete(loginId);
    this.earlyLoginCompletions.delete(loginId);
  }

  async loginChatGpt(): Promise<CodexAccountStatus> {
    if (this.options.sharedAuthPath) {
      // Never open a browser login: it would replace the Switcher's account.
      await this.syncSharedAuth();
      return this.getAccountStatus();
    }
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = (async () => {
      const current = await this.getAccountStatus();
      if (current.connected && current.type === 'chatgpt') return current;
      if (current.connected) {
        await this.clearConversationThreads();
        await this.request('account/logout');
      }

      const login = await this.request<unknown>(
        'account/login/start',
        buildChatGptLoginParams(),
      );
      if (!isRecord(login) || typeof login.loginId !== 'string') {
        throw new Error('Codex did not start a ChatGPT sign-in flow.');
      }
      const authUrl = validateLoginUrl(login.authUrl);
      const completionPromise = this.waitForLogin(login.loginId);
      let completion: LoginCompletion;
      try {
        await this.options.openExternal(authUrl);
        completion = await completionPromise;
      } catch (error) {
        this.discardLoginWaiter(login.loginId);
        await this.request('account/login/cancel', { loginId: login.loginId }).catch(() => undefined);
        throw error;
      }
      if (!completion.success) {
        throw new Error(completion.error ?? 'ChatGPT sign-in failed.');
      }
      const account = await this.getAccountStatus(true);
      if (!account.connected || account.type !== 'chatgpt') {
        throw new Error('ChatGPT sign-in completed, but Codex did not return a ChatGPT account.');
      }
      return account;
    })().finally(() => {
      this.loginPromise = null;
    });
    return this.loginPromise;
  }

  async ensureChatGptAccount(): Promise<CodexAccountStatus> {
    if (this.options.sharedAuthPath) {
      await this.syncSharedAuth();
      return this.getAccountStatus();
    }
    const account = await this.getAccountStatus();
    if (account.connected && account.type === 'chatgpt') return account;
    return this.loginChatGpt();
  }

  async logout(): Promise<void> {
    if (this.options.sharedAuthPath) throw new Error(SHARED_AUTH_MANAGED_MESSAGE);
    await this.clearConversationThreads();
    await this.request('account/logout');
  }

  async startThread(options: StartCodexThreadOptions): Promise<string> {
    const response = await this.request<unknown>('thread/start', {
      model: options.model,
      cwd: this.options.workspaceRoot,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      developerInstructions: options.developerInstructions,
      serviceName: 'jarvis_desktop',
      ephemeral: options.ephemeral,
      dynamicTools: options.dynamicTools,
    });
    if (!isRecord(response) || !isRecord(response.thread) || typeof response.thread.id !== 'string') {
      throw new Error('Codex did not return a thread id.');
    }
    return response.thread.id;
  }

  async resumeThread(threadId: string, model: string, developerInstructions: string): Promise<void> {
    await this.request('thread/resume', {
      threadId,
      model,
      cwd: this.options.workspaceRoot,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      developerInstructions,
    });
  }

  private waitForTurn(
    turnId: string,
    threadId: string,
    onDelta: (delta: string, phase?: CodexMessagePhase) => void,
    onTokenUsage?: (usage: CodexTokenUsageBreakdown) => void,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.turnWaiters.delete(turnId);
        void this.request('turn/interrupt', { threadId, turnId }).catch(() => undefined);
        reject(new Error('Codex turn timed out.'));
      }, CODEX_TURN_TIMEOUT_MS);
      const waiter: TurnWaiter = { threadId, text: '', onDelta, onTokenUsage, resolve, reject, timeout };
      this.turnWaiters.set(turnId, waiter);

      const early = this.earlyTurnEvents.get(turnId);
      if (!early) return;
      this.earlyTurnEvents.delete(turnId);
      for (const { delta, phase } of early.deltas) {
        if (phase !== 'commentary') waiter.text += delta;
        waiter.onDelta(delta, phase);
      }
      for (const usage of early.tokenUsage ?? []) waiter.onTokenUsage?.(usage);
      if (early.completion) {
        const completion = early.error && !early.completion.error
          ? { ...early.completion, error: early.error }
          : early.completion;
        this.settleTurn(turnId, completion);
      }
    });
  }

  async runTurn(options: RunCodexTurnOptions): Promise<string> {
    if (options.signal?.aborted) throw abortError();
    if (options.onToolCall) {
      if (this.activeToolHandlers.has(options.threadId)) {
        throw new Error('Codex already has an active tool-enabled turn for this thread.');
      }
      this.activeToolHandlers.set(options.threadId, options.onToolCall);
    }
    try {
      const response = await this.request<unknown>('turn/start', {
        threadId: options.threadId,
        input: options.input,
        cwd: this.options.workspaceRoot,
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        model: options.model,
        effort: options.effort,
      });
      if (!isRecord(response) || !isRecord(response.turn) || typeof response.turn.id !== 'string') {
        throw new Error('Codex did not return a turn id.');
      }

      const turnId = response.turn.id;
      const completion = this.waitForTurn(
        turnId,
        options.threadId,
        options.onDelta,
        options.onTokenUsage,
      );
      const abortListener = () => {
        void this.request('turn/interrupt', { threadId: options.threadId, turnId }).catch(() => undefined);
      };
      options.signal?.addEventListener('abort', abortListener, { once: true });
      if (options.signal?.aborted) abortListener();

      try {
        return await completion;
      } finally {
        options.signal?.removeEventListener('abort', abortListener);
      }
    } finally {
      if (options.onToolCall && this.activeToolHandlers.get(options.threadId) === options.onToolCall) {
        this.activeToolHandlers.delete(options.threadId);
      }
    }
  }

  async getConversationThread(conversationId: string): Promise<CodexConversationThreadRecord | null> {
    await this.loadRuntimeState();
    return this.runtimeState?.conversations[conversationId] ?? null;
  }

  async saveConversationThread(
    conversationId: string,
    record: CodexConversationThreadRecord,
  ): Promise<void> {
    await this.loadRuntimeState();
    if (!this.runtimeState) return;
    this.runtimeState.conversations[conversationId] = record;
    await this.persistRuntimeState();
  }

  async replaceConversationThread(
    conversationId: string,
    record: CodexConversationThreadRecord,
  ): Promise<void> {
    await this.loadRuntimeState();
    if (!this.runtimeState) return;
    const previous = this.runtimeState.conversations[conversationId];
    if (previous && previous.threadId !== record.threadId) {
      this.runtimeState.pendingDeleteThreadIds = [...new Set([
        ...this.runtimeState.pendingDeleteThreadIds,
        previous.threadId,
      ])];
    }
    this.runtimeState.conversations[conversationId] = record;
    await this.persistRuntimeState();
    await this.ensureStarted();
    await this.flushPendingDeletesStarted();
  }

  async deleteConversationThread(conversationId: string): Promise<void> {
    await this.loadRuntimeState();
    if (!this.runtimeState) return;
    const record = this.runtimeState.conversations[conversationId];
    if (!record) return;

    delete this.runtimeState.conversations[conversationId];
    this.runtimeState.pendingDeleteThreadIds = [...new Set([
      ...this.runtimeState.pendingDeleteThreadIds,
      record.threadId,
    ])];
    await this.persistRuntimeState();

    try {
      await this.ensureStarted();
      await this.flushPendingDeletesStarted();
    } catch (error) {
      console.warn('[Codex] Thread deletion was queued for the next app-server start:', error);
    }
  }

  async clearConversationThreads(): Promise<void> {
    await this.loadRuntimeState();
    if (!this.runtimeState) return;

    const threadIds = Object.values(this.runtimeState.conversations)
      .map(record => record.threadId);
    this.runtimeState.conversations = {};
    this.runtimeState.pendingDeleteThreadIds = [...new Set([
      ...this.runtimeState.pendingDeleteThreadIds,
      ...threadIds,
    ])];

    // Clear the addressable mappings before attempting physical deletion so
    // a crash or deletion failure cannot expose an old thread to a new account.
    await this.persistRuntimeState();
    if (this.runtimeState.pendingDeleteThreadIds.length === 0) return;

    try {
      await this.ensureStarted();
      await this.flushPendingDeletesStarted();
    } catch (error) {
      console.warn('[Codex] Account-boundary thread deletion was queued:', error);
    }
  }

  async stop(): Promise<void> {
    if (this.startPromise) {
      await this.startPromise.catch(() => undefined);
    }
    const child = this.child;
    if (!child) return;
    this.stopping = true;

    await new Promise<void>(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const forceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        finish();
      }, 3_000);
      child.once('exit', () => {
        clearTimeout(forceTimer);
        finish();
      });
      child.kill('SIGTERM');
    });
  }
}
