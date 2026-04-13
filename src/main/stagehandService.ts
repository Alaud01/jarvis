import {
  Stagehand,
  providerEnvVarMap,
  type AgentResult as StagehandAgentResult,
  type AgentToolMode,
} from '@browserbasehq/stagehand';

const DEFAULT_MAX_STEPS = 12;
const MAX_MAX_STEPS = 25;
const DEFAULT_VIEWPORT = { width: 1440, height: 900 };
const DEFAULT_BROWSER_EXECUTABLE_PATH = '/Applications/Helium.app/Contents/MacOS/Helium';
const DEFAULT_STAGEHAND_MODEL = 'ollama/qwen3';
const OLLAMA_BASE_URL = 'http://localhost:11434';
const OLLAMA_MODEL_CACHE_TTL_MS = 30_000;
const MAX_PROCESSING_LINES = 80;
const NAVIGATION_TIMEOUT_MS = 45000;
const LIKELY_VISION_MODEL_PATTERNS = [
  /^anthropic\/claude/i,
  /^google(?:-vertex)?\/gemini/i,
  /^openai\/.*(?:gpt-4o|gpt-4\.1|o1|o3|computer-use)/i,
  /^azure\/.*(?:gpt-4o|gpt-4\.1|o1|o3)/i,
  /^microsoft\/fara/i,
  /^ollama\/.*(?:vision|vl|llava|bakllava|moondream|minicpm|pixtral|gemma3)/i,
];
const RELIABLE_STAGEHAND_MODEL_PATTERNS = [
  /^anthropic\/claude/i,
  /^google(?:-vertex)?\/gemini/i,
  /^openai\/.*(?:gpt-4o|gpt-4\.1|o1|o3|o4)/i,
  /^azure\/.*(?:gpt-4o|gpt-4\.1|o1|o3|o4)/i,
  /^microsoft\/fara/i,
  /^ollama\/.*(?:qwen|functiongemma)/i,
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
  mode?: AgentToolMode;
  actionsTaken?: number;
  currentUrl?: string;
  pageTitle?: string;
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
  mode: AgentToolMode;
  startedAt: string;
  finishedAt: string;
  error?: string;
}

interface BrowserSession {
  baseModel: string;
  stagehand: Stagehand;
}

interface BrowserAgentExecutionPlan {
  mode: AgentToolMode;
  excludeTools: string[];
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

function isLikelyVisionCapableStagehandModel(model: string): boolean {
  return LIKELY_VISION_MODEL_PATTERNS.some((pattern) => pattern.test(model));
}

function isLikelyReliableStagehandModel(model: string): boolean {
  return RELIABLE_STAGEHAND_MODEL_PATTERNS.some((pattern) => pattern.test(model));
}

function shouldEnableStructuredExtraction(instruction: string): boolean {
  return STRUCTURED_EXTRACTION_PATTERNS.some((pattern) => pattern.test(instruction));
}

function buildBrowserAgentExecutionPlan(model: string, instruction: string): BrowserAgentExecutionPlan {
  const visionCapable = isLikelyVisionCapableStagehandModel(model);
  const excludeTools: string[] = [];

  if (!visionCapable) {
    excludeTools.push('screenshot');
  }

  if (!shouldEnableStructuredExtraction(instruction)) {
    excludeTools.push('extract');
  }

  return {
    mode: visionCapable ? 'hybrid' : 'dom',
    excludeTools: dedupeTools(excludeTools),
  };
}

function buildBrowserAgentInstruction(instruction: string, plan: BrowserAgentExecutionPlan): string {
  return [
    instruction,
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
  return /no object generated|did not match schema|could not parse the response|ai_jsonparseerror|ai_typevalidationerror|invalid response schema/i.test(message);
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
      const method = getStringArgument(input.method) ?? 'interact';
      const description = getStringArgument(input.description) ?? getStringArgument(input.instruction);
      const argumentsSummary = formatUnknownArgument(input.arguments);
      const details = [description, argumentsSummary ? `(${argumentsSummary})` : undefined]
        .filter(Boolean)
        .join(' ');
      return details ? `Action: ${method} ${details}` : `Action: ${method}.`;
    }

    case 'fillForm': {
      const description = getStringArgument(input.description) ?? getStringArgument(input.instruction);
      return description ? `Form: ${description}` : 'Form: filling fields.';
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
  console.log('[BrowserAgent] Starting Stagehand attempt', {
    conversationId,
    model,
    mode: plan.mode,
    excludeTools: plan.excludeTools,
  });

  const agent = session.stagehand.agent({
    model,
    executionModel: model,
    mode: plan.mode,
  });

  return agent.execute({
    instruction: buildBrowserAgentInstruction(instruction, plan),
    maxSteps,
    highlightCursor: true,
    signal,
    excludeTools: plan.excludeTools.length ? plan.excludeTools : undefined,
    callbacks: onStepFinish
      ? {
          onStepFinish: (event) => onStepFinish(event as StagehandStepEvent),
        }
      : undefined,
  });
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

  if (primaryResult.success || plan.mode !== 'hybrid' || !isBadRequestLikeMessage(primaryResult.message)) {
    return {
      result: primaryResult,
      plan,
      model,
    };
  }

  const fallbackPlan: BrowserAgentExecutionPlan = {
    mode: 'dom',
    excludeTools: dedupeTools([...plan.excludeTools, 'screenshot']),
  };

  console.warn('[BrowserAgent] Retrying with DOM fallback', {
    conversationId,
    model,
    previousMode: plan.mode,
    error: primaryResult.message,
  });

  addProcessingLine('Retrying in DOM-only mode because the previous browser attempt required unsupported vision or screenshot capabilities.');
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
  let activeMode: AgentToolMode = 'dom';

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

  const handleStepFinish = (event: StagehandStepEvent) => {
    const reasoning = event.text?.trim();
    if (reasoning) {
      addProcessingLine(`Reasoning: ${reasoning}`);
    }

    for (const toolCall of event.toolCalls ?? []) {
      const formatted = formatStagehandToolCall(toolCall);
      if (formatted) {
        addProcessingLine(formatted);
      }
    }
  };

  activeBrowserProgressReporters.set(conversationId, (logLine) => {
    const formatted = formatStagehandLogLine(logLine);
    if (formatted) {
      addProcessingLine(formatted);
    }
  });

  try {
    throwIfAborted(signal);

    const session = await getOrCreateBrowserSession(conversationId, preferredModel);
    const page = await getActiveSessionPage(session.stagehand);
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

    const executeWithModel = async (model: string): Promise<{
      result: StagehandAgentResult;
      plan: BrowserAgentExecutionPlan;
      model: string;
    }> => {
      const initialPlan = buildBrowserAgentExecutionPlan(model, args.instruction);
      activeModel = model;
      activeMode = initialPlan.mode;
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

    if (!attempt.result.success) {
      const fallbackModel = modelSelection.fallbackModels.find((candidate) => candidate !== attempt.model);

      if (fallbackModel && isSchemaValidationMessage(attempt.result.message)) {
        addProcessingLine(`The browser model \`${attempt.model}\` returned invalid structured actions. Retrying with \`${fallbackModel}\`.`);
        attempt = await executeWithModel(fallbackModel);
      }
    }

    throwIfAborted(signal);

    const context = await getCurrentBrowserContext(session.stagehand);
    const processing = buildProcessingContent(processingLines);

    if (!attempt.result.success) {
      return {
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
      };
    }

    return {
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
    };
  } catch (error) {
    if (isAbortLikeError(error) || signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const context: Pick<BrowserAgentResult, 'currentUrl' | 'pageTitle'> = browserSessions.has(conversationId)
      ? await getCurrentBrowserContext(browserSessions.get(conversationId)!.stagehand).catch(() => ({}))
      : {};

    return {
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
    };
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
