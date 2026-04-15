import {
  Stagehand,
  providerEnvVarMap,
  type AgentResult as StagehandAgentResult,
} from '@browserbasehq/stagehand';
import { app } from 'electron';
import { randomUUID } from 'crypto';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import path from 'path';
import type { BrowserLLMTrace, BrowserLLMTraceStep, BrowserScreenshotArtifact, BrowserToolMode } from '../shared/browser';

const DEFAULT_MAX_STEPS = 20;
const MAX_MAX_STEPS = 40;
const DEFAULT_VIEWPORT = { width: 1440, height: 900 };
const DEFAULT_BROWSER_EXECUTABLE_PATH = '/Applications/Helium.app/Contents/MacOS/Helium';
const DEFAULT_STAGEHAND_MODEL = 'ollama/qwen3';
const OLLAMA_BASE_URL = 'http://localhost:11434';
const OLLAMA_MODEL_CACHE_TTL_MS = 30_000;
const MAX_PROCESSING_LINES = 80;
const NAVIGATION_TIMEOUT_MS = 45000;
const BROWSER_ARTIFACTS_DIR_NAME = 'browser-artifacts';
const SCREENSHOT_EXTENSION = 'jpg';
const SCREENSHOT_MIME_TYPE = 'image/jpeg';
const SCREENSHOT_QUALITY = 80;
const GEMINI_FAMILY_PATTERN = /gemini/i;
const CUA_STAGEHAND_MODEL_PATTERNS = [
  /^anthropic\/claude/i,
  /^google(?:-vertex)?\/gemini/i,
  /^openai\/computer-use/i,
  /^microsoft\/fara/i,
];
const HYBRID_STAGEHAND_MODEL_PATTERNS = [
  /^anthropic\/claude/i,
  /^google(?:-vertex)?\/gemini/i,
  /^openai\/.*(?:gpt-4o|gpt-4\.1|o1|o3|computer-use)/i,
  /^azure\/.*(?:gpt-4o|gpt-4\.1|o1|o3)/i,
  /^microsoft\/fara/i,
  /^ollama\/.*(?:vision|vl|llava|bakllava|moondream|minicpm|pixtral)/i,
  /gemini/i,
  /gemma/i,
  /kimi/i,
];
const RELIABLE_STAGEHAND_MODEL_PATTERNS = [
  /^anthropic\/claude/i,
  /^google(?:-vertex)?\/gemini/i,
  /^openai\/.*(?:gpt-4o|gpt-4\.1|o1|o3|o4)/i,
  /^azure\/.*(?:gpt-4o|gpt-4\.1|o1|o3|o4)/i,
  /^microsoft\/fara/i,
  /^ollama\/.*(?:qwen|functiongemma)/i,
  /gemini/i,
];

const PREFERRED_OLLAMA_BROWSER_MODEL_PATTERNS = [
  /^qwen3(?::|$)/i,
  /^qwen2\.5(?::|$)/i,
  /^qwen2\.5-coder(?::|$)/i,
  /^functiongemma(?::|$)/i,
];
const STRUCTURED_EXTRACTION_PATTERNS = [
  /\bstructured\b/i,
  /\b(?:json|csv|table|spreadsheet)\b/i,
  /\b(?:extract|scrape|collect|pull)\b.*\b(?:data|details|fields|prices|names|links|emails?|phones?|addresses|rows|items|products|jobs|listings|results)\b/i,
  /\b(?:all|every)\b.*\b(?:results|rows|items|products|jobs|links|emails?)\b/i,
];
const STAGEHAND_SCHEMA_VALIDATION_PATTERN = /no object generated|did not match schema|could not parse the response|ai_jsonparseerror|ai_typevalidationerror|invalid response schema|schema validation|schema mismatch|tool call validation|invalid tool (?:call|input)|invalid arguments(?: for tool)?|zod(?:error| schema)?|missing required(?: property| field)?/i;

export interface BrowserAgentToolArgs {
  instruction: string;
  startUrl?: string;
  maxSteps?: number;
}

export interface BrowserSessionSummary {
  hasActiveSession: boolean;
  currentUrl?: string;
  pageTitle?: string;
}

export interface BrowserAgentProgressUpdate {
  processing?: string;
  model?: string;
  mode?: BrowserToolMode;
  actionsTaken?: number;
  currentUrl?: string;
  pageTitle?: string;
  screenshots?: BrowserScreenshotArtifact[];
  llmTraceStep?: BrowserLLMTraceStep;
}

export interface BrowserAgentResult {
  success: boolean;
  completed: boolean;
  summary: string;
  instruction: string;
  startUrl?: string;
  currentUrl?: string;
  pageTitle?: string;
  actionsTaken: number;
  processing?: string;
  model: string;
  mode: BrowserToolMode;
  startedAt: string;
  finishedAt: string;
  error?: string;
  screenshots?: BrowserScreenshotArtifact[];
  llmTrace?: BrowserLLMTrace;
}

interface BrowserSession {
  baseModel: string;
  stagehand: Stagehand;
}

interface BrowserAgentExecutionPlan {
  mode: BrowserToolMode;
  excludeTools: string[];
  retryContext?: BrowserAgentRetryContext;
}

type BrowserAgentRetryReason = 'schema_validation' | 'vision_capability';

interface BrowserAgentRetryContext {
  reason: BrowserAgentRetryReason;
  previousError?: string;
  previousModel?: string;
  previousMode?: BrowserToolMode;
}

interface BrowserModelSelection {
  model: string;
  fallbackModels: string[];
  note?: string;
}

interface CachedOllamaModels {
  names: string[];
  fetchedAt: number;
}

interface StagehandLogLine {
  message: string;
  category?: string;
  level?: 0 | 1 | 2;
  auxiliary?: Record<
    string,
    {
      value: string;
      type: 'object' | 'string' | 'html' | 'integer' | 'float' | 'boolean';
    }
  >;
}

interface StagehandStepToolCall {
  toolName?: string;
  input?: Record<string, unknown>;
}

interface StagehandStepEvent {
  text?: string;
  finishReason?: string;
  toolCalls?: StagehandStepToolCall[];
}

const browserSessions = new Map<string, BrowserSession>();
const activeBrowserProgressReporters = new Map<string, (logLine: StagehandLogLine) => void>();
let cachedOllamaModels: CachedOllamaModels | null = null;

function normalizeStagehandModel(model?: string): string | undefined {
  const trimmed = model?.trim();

  if (!trimmed) {
    return undefined;
  }

  if (trimmed.includes('/')) {
    return trimmed;
  }

  return `ollama/${trimmed}`;
}

function getStagehandBootstrapModel(preferredModel?: string): string {
  return (
    normalizeStagehandModel(process.env.STAGEHAND_MODEL) ??
    normalizeStagehandModel(preferredModel) ??
    DEFAULT_STAGEHAND_MODEL
  );
}

function ensureStagehandProviderCredentials(model: string): void {
  const [provider] = model.split('/', 1);
  const envConfig = provider ? providerEnvVarMap[provider] : undefined;

  if (!envConfig) {
    return;
  }

  const candidateVars = Array.isArray(envConfig) ? envConfig : [envConfig];
  const hasCredential = candidateVars.some((envVar) => Boolean(process.env[envVar]?.trim()));

  if (!hasCredential) {
    throw new Error(
      `Browser automation model "${model}" requires ${candidateVars.join(' or ')} to be set.`
    );
  }
}

function getBrowserExecutablePath(): string | undefined {
  const executablePath = process.env.STAGEHAND_BROWSER_EXECUTABLE_PATH?.trim();
  return executablePath || DEFAULT_BROWSER_EXECUTABLE_PATH;
}

function clampMaxSteps(value?: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_MAX_STEPS;
  }

  const rounded = Math.floor(value as number);
  return Math.min(Math.max(rounded, 1), MAX_MAX_STEPS);
}

function dedupeTools(tools: string[]): string[] {
  return [...new Set(tools)];
}

function getErrorMessage(error: unknown): string {
  if (typeof error === 'string') {
    return error.trim();
  }

  if (error instanceof Error) {
    return error.message.trim();
  }

  return String(error ?? '').trim();
}

function isGeminiFamilyStagehandModel(model: string): boolean {
  return GEMINI_FAMILY_PATTERN.test(model);
}

function isLikelyReliableStagehandModel(model: string): boolean {
  return RELIABLE_STAGEHAND_MODEL_PATTERNS.some((pattern) => pattern.test(model));
}

function isLikelyCuaCapableStagehandModel(model: string): boolean {
  return CUA_STAGEHAND_MODEL_PATTERNS.some((pattern) => pattern.test(model));
}

function isLikelyHybridCapableStagehandModel(model: string): boolean {
  return HYBRID_STAGEHAND_MODEL_PATTERNS.some((pattern) => pattern.test(model));
}

function resolveBrowserAutomationMode(model: string): BrowserToolMode {
  if (isLikelyCuaCapableStagehandModel(model)) {
    return 'cua';
  }

  if (isLikelyHybridCapableStagehandModel(model) || isGeminiFamilyStagehandModel(model)) {
    return 'hybrid';
  }

  return 'dom';
}

function shouldAllowStagehandScreenshotTool(mode: BrowserToolMode): boolean {
  return mode !== 'dom';
}

function shouldEnableStructuredExtraction(instruction: string): boolean {
  return STRUCTURED_EXTRACTION_PATTERNS.some((pattern) => pattern.test(instruction));
}

function buildBrowserAgentExecutionPlan(
  model: string,
  instruction: string,
  retryContext?: BrowserAgentRetryContext
): BrowserAgentExecutionPlan {
  const mode = resolveBrowserAutomationMode(model);
  const excludeTools: string[] = [];

  if (!shouldAllowStagehandScreenshotTool(mode)) {
    excludeTools.push('screenshot');
  }

  excludeTools.push('click', 'type', 'dragAndDrop', 'clickAndHold');

  if (!shouldEnableStructuredExtraction(instruction)) {
    excludeTools.push('extract');
  }

  return {
    mode,
    excludeTools: dedupeTools(excludeTools),
    retryContext,
  };
}

function buildBrowserAgentSystemPrompt(plan: BrowserAgentExecutionPlan): string {
  const modeGuidance = plan.mode === 'dom'
    ? 'You are in DOM mode. Prefer semantic DOM tools such as act and fillForm. Do not rely on screenshots or coordinate clicks.'
    : plan.mode === 'hybrid'
      ? 'You are in hybrid mode. Prefer semantic DOM tools such as act and fillForm. Use screenshots for visual context only — never use coordinate-based actions.'
      : 'You are in CUA mode. Use screenshot-aware actions for visual context, but prefer semantic DOM tools such as act and fillForm for interactions.';
  const retryGuidance = plan.retryContext?.reason === 'schema_validation'
    ? [
      'The previous attempt failed because the model emitted an invalid structured Stagehand tool call.',
      'Never return Playwright-style selector or method JSON such as {"method":"click","selector":"..."} unless a tool schema explicitly asks for those exact fields.',
      'For the act tool, send exactly one plain-English action string such as "click the Submit button".',
      'If the task needs multiple browser interactions, emit multiple tool calls across multiple steps instead of a list or array of actions.',
    ].join(' ')
    : plan.retryContext?.reason === 'vision_capability'
      ? 'The previous attempt requested unsupported screenshot or vision behavior. Stay strictly within the available DOM-oriented tools.'
      : undefined;

  return [
    'You are a browser automation agent running inside Stagehand.',
    'Call only the tools provided by the runtime and match each tool schema exactly.',
    'Do not invent your own action format and never send arrays of actions.',
    'For the act tool, provide one natural-language action string that describes the interaction to perform.',
    'Do not emit unsupported fields such as element, elementId, selector, method, args, or arguments unless the current tool schema explicitly requires them.',
    'Take one deliberate browser action at a time, verify navigation-sensitive steps, and stop to report blockers instead of fabricating a tool call.',
    modeGuidance,
    retryGuidance,
  ].join(' ');
}

function buildBrowserAgentInstruction(instruction: string, plan: BrowserAgentExecutionPlan): string {
  const retryErrorSnippet = plan.retryContext?.previousError
    ? toInlineSnippet(plan.retryContext.previousError, 220)
    : undefined;
  const retryLines = plan.retryContext?.reason === 'schema_validation'
    ? [
      retryErrorSnippet
        ? `Recovery note: the previous browser attempt failed with a schema error: ${retryErrorSnippet}`
        : 'Recovery note: the previous browser attempt failed with an invalid structured Stagehand tool call.',
      'Recover by emitting exactly one valid Stagehand tool call at a time.',
      'If the next interaction is a click, type, hover, or press, prefer the act tool with a single natural-language action sentence rather than selector or method JSON.',
    ]
    : plan.retryContext?.reason === 'vision_capability'
      ? [
        retryErrorSnippet
          ? `Recovery note: the previous attempt requested unsupported screenshot or vision behavior: ${retryErrorSnippet}`
          : 'Recovery note: the previous attempt requested unsupported screenshot or vision behavior.',
        'Stay in DOM-oriented tools only and avoid screenshot-dependent actions.',
      ]
      : [];

  return [
    instruction,
    ...retryLines,
    plan.mode === 'dom'
      ? 'Stick to DOM-based interactions whenever possible.'
      : 'Use visual tools only when they meaningfully improve reliability.',
    'Reuse the existing browser state when it helps.',
    plan.excludeTools.includes('extract')
      ? 'Avoid structured extraction unless the task explicitly requires scraped or structured output.'
      : 'Use structured extraction only when it is genuinely needed for the final answer.',
    'Leave the page in the most useful final state for the next browser instruction.',
  ].join('\n\n');
}

function normalizeStartUrl(startUrl?: string): string | undefined {
  const trimmed = startUrl?.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed;
}

function sanitizeArtifactPathSegment(value: string): string {
  return value.replace(/[^a-z0-9._-]/gi, '_');
}

function getBrowserArtifactsRootDirectory(): string {
  return path.join(app.getPath('userData'), BROWSER_ARTIFACTS_DIR_NAME);
}

function getConversationBrowserArtifactsDirectory(conversationId: string): string {
  return path.join(getBrowserArtifactsRootDirectory(), sanitizeArtifactPathSegment(conversationId));
}

function isPathInsideDirectory(targetPath: string, directoryPath: string): boolean {
  const relativePath = path.relative(directoryPath, targetPath);
  return relativePath !== '' && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

async function ensureConversationBrowserArtifactsDirectory(conversationId: string): Promise<string> {
  const directoryPath = getConversationBrowserArtifactsDirectory(conversationId);
  await mkdir(directoryPath, { recursive: true });
  return directoryPath;
}

async function captureBrowserScreenshotArtifact(
  conversationId: string,
  page: Awaited<ReturnType<typeof getActiveSessionPage>>,
  kind: BrowserScreenshotArtifact['kind']
): Promise<BrowserScreenshotArtifact | undefined> {
  const directoryPath = await ensureConversationBrowserArtifactsDirectory(conversationId);
  const artifactId = randomUUID();
  const filePath = path.join(directoryPath, `${artifactId}-${kind}.${SCREENSHOT_EXTENSION}`);

  try {
    await page.screenshot({
      path: filePath,
      type: 'jpeg',
      quality: SCREENSHOT_QUALITY,
      fullPage: false,
      scale: 'css',
    });

    return {
      id: artifactId,
      kind,
      path: filePath,
      mimeType: SCREENSHOT_MIME_TYPE,
      createdAt: new Date().toISOString(),
      label: kind === 'error' ? 'Failure screenshot' : 'Final screenshot',
    };
  } catch (error) {
    console.warn('[BrowserAgent] Failed to capture browser screenshot artifact', {
      conversationId,
      kind,
      error: getErrorMessage(error),
    });
    return undefined;
  }
}

async function persistBrowserLLMTrace(
  conversationId: string,
  trace: BrowserLLMTrace
): Promise<string | undefined> {
  const directoryPath = await ensureConversationBrowserArtifactsDirectory(conversationId);
  const traceId = randomUUID();
  const filePath = path.join(directoryPath, `${traceId}-llm-trace.json`);

  try {
    await writeFile(filePath, JSON.stringify(trace, null, 2), 'utf-8');
    return filePath;
  } catch (error) {
    console.warn('[BrowserAgent] Failed to persist LLM trace', {
      conversationId,
      error: getErrorMessage(error),
    });
    return undefined;
  }
}

export async function readBrowserArtifactAsBase64(filePath: string): Promise<string | null> {
  const trimmedPath = filePath?.trim();
  if (!trimmedPath) {
    return null;
  }

  const resolvedPath = path.resolve(trimmedPath);
  if (!isPathInsideDirectory(resolvedPath, getBrowserArtifactsRootDirectory())) {
    return null;
  }

  try {
    const buffer = await readFile(resolvedPath);
    return buffer.toString('base64');
  } catch {
    return null;
  }
}

export async function readBrowserArtifactAsPreviewDataUrl(filePath: string): Promise<string | null> {
  const base64 = await readBrowserArtifactAsBase64(filePath);
  if (!base64) {
    return null;
  }

  const mimeType = filePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
  return `data:${mimeType};base64,${base64}`;
}

export async function deleteBrowserArtifacts(conversationId: string): Promise<void> {
  await rm(getConversationBrowserArtifactsDirectory(conversationId), {
    recursive: true,
    force: true,
  }).catch(() => undefined);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

function isAbortLikeError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === 'AbortError'
  ) || (
    error instanceof Error && (error.name === 'AbortError' || error.name === 'AgentAbortError')
  );
}

function isSchemaValidationMessage(message: string): boolean {
  return STAGEHAND_SCHEMA_VALIDATION_PATTERN.test(message);
}

function isBadRequestLikeMessage(message: string): boolean {
  return /\bbad request\b|unsupported|vision|image|media/i.test(message);
}

function formatStagehandError(error: unknown, model?: string): string {
  const message = getErrorMessage(error);

  if (!message) {
    return 'Unknown browser automation error.';
  }

  if (isSchemaValidationMessage(message)) {
    return `The browser model "${model ?? 'unknown'}" returned invalid structured browser actions, so Stagehand could not perform the requested click or typing step. This is a model-compatibility issue rather than a page-state issue.`;
  }

  if (/extract\(\) timed out/i.test(message)) {
    return 'Browser automation timed out while trying to extract structured data from the page.';
  }

  if (/\bbad request\b/i.test(message)) {
    return 'The browser automation model rejected the request. Text-only models need DOM-only browser actions, while screenshot-driven browsing requires a multimodal model.';
  }

  if (/Ollama|ollama/i.test(message)) {
    return `${message} If you want to override the browser model, set STAGEHAND_MODEL to a provider/model value.`;
  }

  if (/STAGEHAND_MODEL|API_KEY|api key|credentials|environment/i.test(message)) {
    return message;
  }

  if (/Chrome|Chromium|executablePath|browser/i.test(message)) {
    return 'Stagehand could not launch a local browser. Install Chrome or Chromium, or set STAGEHAND_BROWSER_EXECUTABLE_PATH to your browser executable.';
  }

  return message || 'Unknown browser automation error.';
}

async function fetchAvailableOllamaModels(): Promise<string[]> {
  if (cachedOllamaModels && Date.now() - cachedOllamaModels.fetchedAt < OLLAMA_MODEL_CACHE_TTL_MS) {
    return cachedOllamaModels.names;
  }

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), 2000);

  try {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: abortController.signal,
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch Ollama models: ${response.statusText}`);
    }

    const data = (await response.json()) as {
      models?: Array<{ name?: string }>;
    };

    const names = data.models
      ?.map((model) => model.name?.trim() ?? '')
      .filter(Boolean) ?? [];

    cachedOllamaModels = {
      names,
      fetchedAt: Date.now(),
    };

    return names;
  } catch {
    return cachedOllamaModels?.names ?? [];
  } finally {
    clearTimeout(timeoutId);
  }
}

function getInstalledSafeOllamaModels(names: string[]): string[] {
  return names
    .filter((name) => PREFERRED_OLLAMA_BROWSER_MODEL_PATTERNS.some((pattern) => pattern.test(name)))
    .sort((left, right) => {
      const leftRank = PREFERRED_OLLAMA_BROWSER_MODEL_PATTERNS.findIndex((pattern) => pattern.test(left));
      const rightRank = PREFERRED_OLLAMA_BROWSER_MODEL_PATTERNS.findIndex((pattern) => pattern.test(right));
      return leftRank - rightRank || left.localeCompare(right);
    })
    .map((name) => `ollama/${name}`);
}

async function resolveBrowserAutomationModel(preferredModel?: string): Promise<BrowserModelSelection> {
  const forcedModel = normalizeStagehandModel(process.env.STAGEHAND_MODEL);
  if (forcedModel) {
    return {
      model: forcedModel,
      fallbackModels: [],
      note: `Using \`${forcedModel}\` for browser automation because \`STAGEHAND_MODEL\` is set.`,
    };
  }

  const normalizedPreferred = normalizeStagehandModel(preferredModel);
  const installedSafeOllamaModels = getInstalledSafeOllamaModels(await fetchAvailableOllamaModels());

  if (normalizedPreferred && isLikelyReliableStagehandModel(normalizedPreferred)) {
    return {
      model: normalizedPreferred,
      fallbackModels: installedSafeOllamaModels.filter((model) => model !== normalizedPreferred),
      note: `Using \`${normalizedPreferred}\` for browser automation.`,
    };
  }

  if (installedSafeOllamaModels.length > 0) {
    const [model, ...fallbackModels] = installedSafeOllamaModels;
    return {
      model,
      fallbackModels,
      note: normalizedPreferred && normalizedPreferred !== model
        ? `Using \`${model}\` for browser automation because the selected chat model \`${normalizedPreferred}\` is unreliable for Stagehand's structured browser actions.`
        : `Using \`${model}\` for browser automation.`,
    };
  }

  if (normalizedPreferred) {
    return {
      model: normalizedPreferred,
      fallbackModels: [],
      note: `No safer browser model was detected locally, so browser automation is using \`${normalizedPreferred}\`.`,
    };
  }

  return {
    model: DEFAULT_STAGEHAND_MODEL,
    fallbackModels: [],
    note: `Using default browser automation model \`${DEFAULT_STAGEHAND_MODEL}\`.`,
  };
}

async function getActiveSessionPage(stagehand: Stagehand) {
  return stagehand.context.activePage() ?? stagehand.context.pages()[0] ?? stagehand.context.newPage();
}

async function getCurrentBrowserContext(stagehand: Stagehand): Promise<Pick<BrowserAgentResult, 'currentUrl' | 'pageTitle'>> {
  const page = stagehand.context.activePage() ?? stagehand.context.pages()[0];

  if (!page) {
    return {};
  }

  let pageTitle: string | undefined;

  try {
    pageTitle = await page.title();
  } catch {
    pageTitle = undefined;
  }

  return {
    currentUrl: page.url() || undefined,
    pageTitle: pageTitle || undefined,
  };
}

function emitBrowserSessionLog(conversationId: string, logLine: StagehandLogLine): void {
  activeBrowserProgressReporters.get(conversationId)?.(logLine);
}

async function createBrowserSession(conversationId: string, model: string): Promise<BrowserSession> {
  ensureStagehandProviderCredentials(model);

  const executablePath = getBrowserExecutablePath();
  const stagehand = new Stagehand({
    env: 'LOCAL',
    model,
    experimental: true,
    verbose: 0,
    logger: (logLine) => emitBrowserSessionLog(conversationId, logLine as StagehandLogLine),
    localBrowserLaunchOptions: {
      headless: false,
      viewport: DEFAULT_VIEWPORT,
      executablePath,
    },
  });

  try {
    await stagehand.init();
    await getActiveSessionPage(stagehand);

    return {
      baseModel: model,
      stagehand,
    };
  } catch (error) {
    await stagehand.close({ force: true }).catch(() => undefined);
    throw error;
  }
}

async function getOrCreateBrowserSession(conversationId: string, preferredModel?: string): Promise<BrowserSession> {
  const existingSession = browserSessions.get(conversationId);
  if (existingSession) {
    return existingSession;
  }

  const session = await createBrowserSession(conversationId, getStagehandBootstrapModel(preferredModel));
  browserSessions.set(conversationId, session);
  return session;
}

export async function getBrowserSessionSummary(conversationId: string): Promise<BrowserSessionSummary> {
  const session = browserSessions.get(conversationId);

  if (!session) {
    return { hasActiveSession: false };
  }

  const context = await getCurrentBrowserContext(session.stagehand);
  return {
    hasActiveSession: true,
    ...context,
  };
}

async function navigateToStartUrl(page: Awaited<ReturnType<typeof getActiveSessionPage>>, startUrl?: string): Promise<void> {
  if (!startUrl) {
    return;
  }

  await page.goto(startUrl, {
    waitUntil: 'networkidle',
    timeoutMs: NAVIGATION_TIMEOUT_MS,
  });
}

function appendProcessingLine(lines: string[], line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }

  if (lines[lines.length - 1] === trimmed) {
    return false;
  }

  lines.push(trimmed);

  if (lines.length > MAX_PROCESSING_LINES) {
    lines.splice(0, lines.length - MAX_PROCESSING_LINES);
  }

  return true;
}

function buildProcessingContent(lines: string[]): string | undefined {
  if (lines.length === 0) {
    return undefined;
  }

  return lines.join('\n\n');
}

function getFirstAuxiliaryValue(auxiliary: StagehandLogLine['auxiliary'], keys: string[]): string | undefined {
  if (!auxiliary) {
    return undefined;
  }

  for (const key of keys) {
    const value = auxiliary[key]?.value?.trim();
    if (value) {
      return value;
    }
  }

  for (const entry of Object.values(auxiliary)) {
    const value = entry.value?.trim();
    if (value) {
      return value;
    }
  }

  return undefined;
}

function toInlineSnippet(value: string, maxLength = 180): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, maxLength - 3)}...`;
}

function logBrowserAgent(
  level: 'log' | 'warn' | 'error',
  message: string,
  details?: Record<string, unknown>
): void {
  const prefix = `[BrowserAgent] ${message}`;
  if (level === 'error') {
    if (details) {
      console.error(prefix, details);
      return;
    }
    console.error(prefix);
    return;
  }

  if (level === 'warn') {
    if (details) {
      console.warn(prefix, details);
      return;
    }
    console.warn(prefix);
    return;
  }

  if (details) {
    console.log(prefix, details);
    return;
  }

  console.log(prefix);
}

function logStagehandLogLine(
  conversationId: string,
  model: string,
  logLine: StagehandLogLine
): void {
  const message = logLine.message?.trim();
  if (!message) {
    return;
  }

  const rawResponse = getFirstAuxiliaryValue(logLine.auxiliary, ['text', 'value', 'cause']);
  const details: Record<string, unknown> = {
    conversationId,
    model,
    category: logLine.category,
    level: logLine.level,
    message,
  };

  if (rawResponse) {
    details.rawResponse = rawResponse;
  }

  if (logLine.category === 'AISDK error' || isSchemaValidationMessage(message)) {
    logBrowserAgent('error', 'Stagehand schema or AI SDK error', details);
    return;
  }

  if (logLine.level === 0 || /warning|failed|error/i.test(message)) {
    logBrowserAgent('warn', 'Stagehand diagnostic', details);
  }
}

function formatStagehandLogLine(logLine: StagehandLogLine): string | null {
  const message = logLine.message?.trim();
  if (!message) {
    return null;
  }

  if (logLine.category === 'AISDK error' || isSchemaValidationMessage(message)) {
    const rawResponse = getFirstAuxiliaryValue(logLine.auxiliary, ['text', 'value', 'cause']);
    if (rawResponse) {
      return `Schema error: Stagehand expected a structured browser action but received \`${toInlineSnippet(rawResponse)}\`.`;
    }

    return `Schema error: ${message}`;
  }

  if (logLine.level === 0 || /warning|failed|error/i.test(message)) {
    return message;
  }

  return null;
}

function getStringArgument(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function formatUnknownArgument(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    const parts = value.map((entry) => formatUnknownArgument(entry)).filter(Boolean);
    return parts.length ? parts.join(', ') : undefined;
  }

  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function humanizeToolName(toolName: string): string {
  const normalized = toolName
    .replace(/([A-Z])/g, ' $1')
    .replace(/_/g, ' ')
    .trim();

  return normalized
    ? normalized[0].toUpperCase() + normalized.slice(1)
    : 'Tool';
}

function formatStagehandToolCall(toolCall: StagehandStepToolCall): string | null {
  const toolName = toolCall.toolName?.trim();
  if (!toolName) {
    return null;
  }

  const input = toolCall.input ?? {};

  switch (toolName) {
    case 'act': {
      const action = getStringArgument(input.action)
        ?? getStringArgument(input.instruction)
        ?? getStringArgument(input.description);
      return action ? `Action: ${action}` : 'Action: interact.';
    }

    case 'fillForm': {
      const instruction = getStringArgument(input.instruction)
        ?? getStringArgument(input.description)
        ?? formatUnknownArgument(input.fields);
      return instruction ? `Form: ${instruction}` : 'Form: filling fields.';
    }

    case 'fillFormVision': {
      const instruction = getStringArgument(input.instruction)
        ?? getStringArgument(input.description)
        ?? 'filling fields visually';
      return `Form: ${instruction}`;
    }

    case 'screenshot': {
      const description = getStringArgument(input.instruction)
        ?? getStringArgument(input.description)
        ?? 'capturing a screenshot';
      return `Vision: ${description}`;
    }

    case 'done': {
      const reasoning = getStringArgument(input.reasoning);
      const taskComplete = typeof input.taskComplete === 'boolean' ? input.taskComplete : undefined;

      if (reasoning) {
        return `Done: ${reasoning}`;
      }

      return taskComplete === false ? 'Done: task still incomplete.' : 'Done: task complete.';
    }

    default: {
      const description = getStringArgument(input.description) ?? getStringArgument(input.instruction);
      const argumentsSummary = formatUnknownArgument(input.arguments);
      const label = humanizeToolName(toolName);
      const details = description ?? argumentsSummary;
      return details ? `${label}: ${details}` : `${label}.`;
    }
  }
}

async function executeBrowserAgentAttempt(
  conversationId: string,
  session: BrowserSession,
  model: string,
  instruction: string,
  maxSteps: number,
  signal: AbortSignal | undefined,
  plan: BrowserAgentExecutionPlan,
  onStepFinish?: (event: StagehandStepEvent) => void
): Promise<StagehandAgentResult> {
  const stagehandInstruction = buildBrowserAgentInstruction(instruction, plan);

  logBrowserAgent('log', 'Starting Stagehand attempt', {
    conversationId,
    model,
    mode: plan.mode,
    excludeTools: plan.excludeTools,
    retryReason: plan.retryContext?.reason,
    previousModel: plan.retryContext?.previousModel,
    previousMode: plan.retryContext?.previousMode,
    previousError: plan.retryContext?.previousError
      ? toInlineSnippet(plan.retryContext.previousError, 240)
      : undefined,
    instructionPreview: toInlineSnippet(stagehandInstruction, 280),
  });

  const agent = session.stagehand.agent({
    model,
    executionModel: model,
    mode: plan.mode,
    systemPrompt: buildBrowserAgentSystemPrompt(plan),
  });

  const executeOptions: Parameters<typeof agent.execute>[0] = {
    instruction: stagehandInstruction,
    maxSteps,
    highlightCursor: false,
    callbacks: onStepFinish
      ? {
          onStepFinish: (event) => onStepFinish(event as StagehandStepEvent),
        }
      : undefined,
  };

  if (plan.mode !== 'cua') {
    executeOptions.signal = signal;
    executeOptions.excludeTools = plan.excludeTools.length ? plan.excludeTools : undefined;
  }

  try {
    const result = await agent.execute(executeOptions);
    logBrowserAgent(result.success ? 'log' : 'warn', 'Stagehand attempt finished', {
      conversationId,
      model,
      mode: plan.mode,
      success: result.success,
      completed: result.completed,
      actionsTaken: result.actions.length,
      message: result.message,
    });
    return result;
  } catch (error) {
    logBrowserAgent('error', 'Stagehand attempt threw', {
      conversationId,
      model,
      mode: plan.mode,
      error: getErrorMessage(error),
    });
    throw error;
  }
}

async function runBrowserAgentAttemptWithDomFallback(
  conversationId: string,
  session: BrowserSession,
  page: Awaited<ReturnType<typeof getActiveSessionPage>>,
  model: string,
  instruction: string,
  maxSteps: number,
  signal: AbortSignal | undefined,
  plan: BrowserAgentExecutionPlan,
  startUrl: string | undefined,
  onPlanChange: (nextPlan: BrowserAgentExecutionPlan) => void,
  onStepFinish: (event: StagehandStepEvent) => void,
  addProcessingLine: (line: string) => void
): Promise<{ result: StagehandAgentResult; plan: BrowserAgentExecutionPlan; model: string }> {
  const primaryResult = await executeBrowserAgentAttempt(
    conversationId,
    session,
    model,
    instruction,
    maxSteps,
    signal,
    plan,
    onStepFinish
  );

  const shouldRetryInDomMode = !primaryResult.success
    && plan.mode !== 'dom'
    && (
      isBadRequestLikeMessage(primaryResult.message)
      || isSchemaValidationMessage(primaryResult.message)
    );

  if (!shouldRetryInDomMode) {
    return {
      result: primaryResult,
      plan,
      model,
    };
  }

  const fallbackPlan: BrowserAgentExecutionPlan = {
    mode: 'dom',
    excludeTools: dedupeTools([...plan.excludeTools, 'screenshot']),
    retryContext: {
      reason: isSchemaValidationMessage(primaryResult.message) ? 'schema_validation' : 'vision_capability',
      previousError: primaryResult.message,
      previousModel: model,
      previousMode: plan.mode,
    },
  };

  logBrowserAgent('warn', 'Retrying with DOM fallback', {
    conversationId,
    model,
    previousMode: plan.mode,
    error: primaryResult.message,
    retryReason: fallbackPlan.retryContext?.reason,
  });

  addProcessingLine(
    isSchemaValidationMessage(primaryResult.message)
      ? 'Retrying in DOM-only mode because the previous browser attempt returned invalid structured actions.'
      : 'Retrying in DOM-only mode because the previous browser attempt required unsupported vision or screenshot capabilities.'
  );
  onPlanChange(fallbackPlan);

  if (startUrl) {
    addProcessingLine(`Reloading \`${startUrl}\` before the DOM-only retry.`);
    await navigateToStartUrl(page, startUrl);
  }

  const fallbackResult = await executeBrowserAgentAttempt(
    conversationId,
    session,
    model,
    instruction,
    maxSteps,
    signal,
    fallbackPlan,
    onStepFinish
  );

  return {
    result: fallbackResult,
    plan: fallbackPlan,
    model,
  };
}

export async function executeBrowserAgent(
  conversationId: string,
  args: BrowserAgentToolArgs,
  signal?: AbortSignal,
  preferredModel?: string,
  onUpdate?: (update: BrowserAgentProgressUpdate) => void
): Promise<BrowserAgentResult> {
  const startedAt = new Date().toISOString();
  const startUrl = normalizeStartUrl(args.startUrl);
  const processingLines: string[] = [];
  let activeModel = normalizeStagehandModel(preferredModel) ?? DEFAULT_STAGEHAND_MODEL;
  let activeMode: BrowserToolMode = 'dom';
  let traceSystemPrompt = '';
  let traceInstruction = '';
  const traceSteps: BrowserLLMTraceStep[] = [];
  let traceStepIndex = 0;
  let stepLogLines: string[] = [];
  let page!: Awaited<ReturnType<typeof getActiveSessionPage>>;

  const publishUpdate = (extra: Partial<BrowserAgentProgressUpdate> = {}) => {
    onUpdate?.({
      processing: buildProcessingContent(processingLines),
      model: activeModel,
      mode: activeMode,
      ...extra,
    });
  };

  const addProcessingLine = (line: string) => {
    if (appendProcessingLine(processingLines, line)) {
      publishUpdate();
    }
  };

  const flushTraceStep = (partial?: Partial<BrowserLLMTraceStep>) => {
    if (stepLogLines.length === 0 && !partial?.reasoning && !(partial?.toolCalls?.length)) {
      return;
    }

    const step: BrowserLLMTraceStep = {
      stepIndex: traceStepIndex,
      timestamp: new Date().toISOString(),
      reasoning: partial?.reasoning,
      finishReason: partial?.finishReason,
      toolCalls: partial?.toolCalls,
      rawLogLines: stepLogLines.length > 0 ? [...stepLogLines] : undefined,
    };

    traceSteps.push(step);
    traceStepIndex++;
    stepLogLines = [];

    publishUpdate({ llmTraceStep: step });
  };

  const handleStepFinish = (event: StagehandStepEvent) => {
    const reasoning = event.text?.trim();
    if (reasoning) {
      logBrowserAgent('log', 'Stagehand reasoning', {
        conversationId,
        model: activeModel,
        mode: activeMode,
        text: reasoning,
        finishReason: event.finishReason,
      });
      addProcessingLine(`Reasoning: ${reasoning}`);
    }

    const toolCalls = event.toolCalls?.map((tc) => ({
      toolName: tc.toolName ?? '',
      input: tc.input ?? {},
    }));

    for (const toolCall of event.toolCalls ?? []) {
      const formatted = formatStagehandToolCall(toolCall);
      logBrowserAgent('log', 'Stagehand tool call', {
        conversationId,
        model: activeModel,
        mode: activeMode,
        toolName: toolCall.toolName,
        formatted: formatted ?? undefined,
        input: toolCall.input,
      });
      if (formatted) {
        addProcessingLine(formatted);
      }

    }

    flushTraceStep({
      reasoning,
      finishReason: event.finishReason,
      toolCalls: toolCalls?.length ? toolCalls : undefined,
    });
  };

  activeBrowserProgressReporters.set(conversationId, (logLine) => {
    logStagehandLogLine(conversationId, activeModel, logLine);

    const message = logLine.message?.trim();
    if (message) {
      stepLogLines.push(message);
    }

    const formatted = formatStagehandLogLine(logLine);
    if (formatted) {
      addProcessingLine(formatted);
    }
  });

  try {
    throwIfAborted(signal);

    const session = await getOrCreateBrowserSession(conversationId, preferredModel);
    page = await getActiveSessionPage(session.stagehand);
    const maxSteps = clampMaxSteps(args.maxSteps);
    const modelSelection = await resolveBrowserAutomationModel(preferredModel);

    activeModel = modelSelection.model;
    publishUpdate();

    if (modelSelection.note) {
      addProcessingLine(modelSelection.note);
    }

    if (startUrl) {
      addProcessingLine(`Starting from \`${startUrl}\`.`);
    }

    const executeWithModel = async (
      model: string,
      retryContext?: BrowserAgentRetryContext
    ): Promise<{
      result: StagehandAgentResult;
      plan: BrowserAgentExecutionPlan;
      model: string;
    }> => {
      const initialPlan = buildBrowserAgentExecutionPlan(model, args.instruction, retryContext);
      activeModel = model;
      activeMode = initialPlan.mode;

      traceSystemPrompt = buildBrowserAgentSystemPrompt(initialPlan);
      traceInstruction = buildBrowserAgentInstruction(args.instruction, initialPlan);

      publishUpdate();

      addProcessingLine(`Using browser model \`${model}\` in \`${initialPlan.mode}\` mode.`);

      if (startUrl) {
        addProcessingLine(`Navigating to \`${startUrl}\`.`);
        await navigateToStartUrl(page, startUrl);
        publishUpdate(await getCurrentBrowserContext(session.stagehand));
      }

      return runBrowserAgentAttemptWithDomFallback(
        conversationId,
        session,
        page,
        model,
        args.instruction,
        maxSteps,
        signal,
        initialPlan,
        startUrl,
        (nextPlan) => {
          activeMode = nextPlan.mode;
          publishUpdate();
        },
        handleStepFinish,
        addProcessingLine
      );
    };

    let attempt = await executeWithModel(modelSelection.model);

    if (!attempt.result.success && isSchemaValidationMessage(attempt.result.message)) {
      const attemptedModels = new Set([attempt.model]);

      for (const fallbackModel of modelSelection.fallbackModels) {
        if (attemptedModels.has(fallbackModel)) {
          continue;
        }

        addProcessingLine(`The browser model \`${attempt.model}\` returned invalid structured actions. Retrying with \`${fallbackModel}\`.`);
        logBrowserAgent('warn', 'Retrying with fallback browser model after schema error', {
          conversationId,
          previousModel: attempt.model,
          previousMode: attempt.plan.mode,
          fallbackModel,
          error: attempt.result.message,
        });

        attempt = await executeWithModel(fallbackModel, {
          reason: 'schema_validation',
          previousError: attempt.result.message,
          previousModel: attempt.model,
          previousMode: attempt.plan.mode,
        });
        attemptedModels.add(fallbackModel);

        if (attempt.result.success || !isSchemaValidationMessage(attempt.result.message)) {
          break;
        }
      }
    }

    throwIfAborted(signal);

    const context = await getCurrentBrowserContext(session.stagehand);
    const processing = buildProcessingContent(processingLines);
    const llmTrace: BrowserLLMTrace = {
      model: attempt.model,
      mode: attempt.plan.mode,
      systemPrompt: traceSystemPrompt,
      instruction: traceInstruction,
      startedAt,
      finishedAt: new Date().toISOString(),
      steps: traceSteps,
    };

    if (!attempt.result.success) {
      const errorScreenshot = await captureBrowserScreenshotArtifact(conversationId, page, 'error');
      if (llmTrace.steps.length > 0) {
        llmTrace.error = formatStagehandError(attempt.result.message, attempt.model);
        await persistBrowserLLMTrace(conversationId, llmTrace);
      }
      const failureResult: BrowserAgentResult = {
        success: false,
        completed: attempt.result.completed,
        summary: 'Browser task failed.',
        instruction: args.instruction,
        startUrl,
        currentUrl: context.currentUrl,
        pageTitle: context.pageTitle,
        actionsTaken: attempt.result.actions.length,
        processing,
        model: attempt.model,
        mode: attempt.plan.mode,
        startedAt,
        finishedAt: new Date().toISOString(),
        error: formatStagehandError(attempt.result.message, attempt.model),
        screenshots: errorScreenshot ? [errorScreenshot] : undefined,
        llmTrace: llmTrace.steps.length > 0 ? llmTrace : undefined,
      };
      logBrowserAgent('warn', 'Browser task failed', {
        conversationId,
        model: failureResult.model,
        mode: failureResult.mode,
        completed: failureResult.completed,
        actionsTaken: failureResult.actionsTaken,
        currentUrl: failureResult.currentUrl,
        pageTitle: failureResult.pageTitle,
        error: failureResult.error,
      });
      return failureResult;
    }

    const finalScreenshot = await captureBrowserScreenshotArtifact(conversationId, page, 'final');
    if (llmTrace.steps.length > 0) {
      await persistBrowserLLMTrace(conversationId, llmTrace);
    }
    const successResult: BrowserAgentResult = {
      success: attempt.result.success,
      completed: attempt.result.completed,
      summary: attempt.result.message || 'Browser task finished.',
      instruction: args.instruction,
      startUrl,
      currentUrl: context.currentUrl,
      pageTitle: context.pageTitle,
      actionsTaken: attempt.result.actions.length,
      processing,
      model: attempt.model,
      mode: attempt.plan.mode,
      startedAt,
      finishedAt: new Date().toISOString(),
      screenshots: finalScreenshot ? [finalScreenshot] : undefined,
      llmTrace: llmTrace.steps.length > 0 ? llmTrace : undefined,
    };
    logBrowserAgent('log', 'Browser task completed', {
      conversationId,
      model: successResult.model,
      mode: successResult.mode,
      completed: successResult.completed,
      actionsTaken: successResult.actionsTaken,
      currentUrl: successResult.currentUrl,
      pageTitle: successResult.pageTitle,
      summary: successResult.summary,
    });
    return successResult;
  } catch (error) {
    if (isAbortLikeError(error) || signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const session = browserSessions.get(conversationId);
    const context: Pick<BrowserAgentResult, 'currentUrl' | 'pageTitle'> = browserSessions.has(conversationId)
      ? await getCurrentBrowserContext(session!.stagehand).catch(() => ({}))
      : {};
    const errorScreenshot = session
      ? await getActiveSessionPage(session.stagehand)
        .then((page) => captureBrowserScreenshotArtifact(conversationId, page, 'error'))
        .catch(() => undefined)
      : undefined;

    const failureResult: BrowserAgentResult = {
      success: false,
      completed: false,
      summary: 'Browser task failed.',
      instruction: args.instruction,
      startUrl,
      currentUrl: context.currentUrl,
      pageTitle: context.pageTitle,
      actionsTaken: 0,
      processing: buildProcessingContent(processingLines),
      model: activeModel,
      mode: activeMode,
      startedAt,
      finishedAt: new Date().toISOString(),
      error: formatStagehandError(error, activeModel),
      screenshots: errorScreenshot ? [errorScreenshot] : undefined,
      llmTrace: traceSteps.length > 0 ? {
        model: activeModel,
        mode: activeMode,
        systemPrompt: traceSystemPrompt,
        instruction: traceInstruction,
        startedAt,
        finishedAt: new Date().toISOString(),
        steps: traceSteps,
        error: getErrorMessage(error),
      } : undefined,
    };
    logBrowserAgent('error', 'Browser task threw', {
      conversationId,
      model: failureResult.model,
      mode: failureResult.mode,
      currentUrl: failureResult.currentUrl,
      pageTitle: failureResult.pageTitle,
      error: getErrorMessage(error),
      userFacingError: failureResult.error,
    });
    return failureResult;
  } finally {
    activeBrowserProgressReporters.delete(conversationId);
  }
}

export async function closeBrowserSession(conversationId: string): Promise<void> {
  const session = browserSessions.get(conversationId);
  if (!session) {
    return;
  }

  browserSessions.delete(conversationId);
  await session.stagehand.close({ force: true }).catch(() => undefined);
}

export async function closeAllBrowserSessions(): Promise<void> {
  const conversationIds = [...browserSessions.keys()];
  await Promise.all(conversationIds.map((conversationId) => closeBrowserSession(conversationId)));
}
