import { generateText, stepCountIs, streamText } from 'ai';
import {
  applyCompaction,
  buildCompactionSummaryMessage,
  DEFAULT_COMPACTION_SETTINGS,
  SUMMARIZATION_PROMPT,
  SUMMARIZATION_SYSTEM_PROMPT,
  UPDATE_SUMMARIZATION_PROMPT,
  estimateContextTokens,
  findCutPoint,
  serializeConversation,
  shouldCompact,
} from './ai/compaction.js';
import { normalizeConversationHistory } from './ai/message-schema.js';
import type { Message } from './ai/message-schema.js';
import { toModelMessages } from './ai/model-convert.js';
import { createExponentialBackoff, isValidFinalResponse } from './ai/retry-engine.js';
import { buildToolSet, describeImageWithModel, resolveLanguageModel } from './ai/sdk-client.js';
import { BrowserTools } from './tools/browser-tools.js';
import { buildRunPlan } from './types/plan.js';
import type { RunPlan } from './types/plan.js';
import { RUNTIME_MESSAGE_SCHEMA_VERSION } from './types/runtime-messages.js';

type RunMeta = {
  runId: string;
  turnId: string;
  sessionId: string;
};

type ExecutionEvent = {
  id: string;
  runId: string;
  turnId: string;
  sessionId: string;
  toolName: string;
  callId: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  tabId: number | null;
  url: string;
  success: boolean;
  errorCode: string;
  errorMessage: string;
  resultPreview: string;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const EXECUTION_EVENTS_KEY = 'executionEvents';
const MAX_EXECUTION_EVENTS = 500;
const EXECUTION_PREVIEW_LIMIT = 500;
const EXECUTION_TEXT_LIMIT = 500;
const BROWSER_ACTION_TOOLS = ['navigate', 'click', 'type', 'scroll', 'pressKey'] as const;
const DEDICATED_RUN_TAB_URL = 'https://example.com';
const LOCKED_TAB_ALLOWED_BROWSER_TOOLS = new Set([
  'navigate',
  'click',
  'type',
  'pressKey',
  'scroll',
  'getContent',
  'screenshot',
]);

type FailureClass = 'selector' | 'timing' | 'permission' | 'navigation' | 'unknown';
type RecoveryStage = 'none' | 'structure' | 'retry' | 'screenshot' | 'vision';
type EvidenceConfidence = 'low' | 'medium' | 'high';
type QualityMode = 'speed' | 'balanced' | 'max';
type QualityGateState = 'passed' | 'blocked' | 'forced_retry';

type EvidenceEntry = {
  key: string;
  section:
    | 'sidebar'
    | 'workspace'
    | 'cards'
    | 'tables'
    | 'actions'
    | 'filters'
    | 'tabs'
    | 'badges'
    | 'kpis'
    | 'visual'
    | 'content'
    | 'unknown';
  source: string;
  mode?: string;
  text: string;
  url?: string;
  title?: string;
  timestamp: number;
};

const resolveTimeoutMs = (value: unknown, fallback = DEFAULT_REQUEST_TIMEOUT_MS) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1000, Math.floor(parsed));
};

const isAbortError = (error: unknown) => {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: string }).name;
  return name === 'AbortError';
};

const isNoOutputGeneratedError = (error: unknown) => {
  const message = String((error as { message?: string })?.message || error || '').toLowerCase();
  if (!message) return false;
  return message.includes('no output generated') || message.includes('check the stream for errors');
};

const GENERIC_TOOL_COMPLETION_TEXT = 'Task completed. See tool results above for details.';

const mapScreenshotQuality = (value: unknown) => {
  const normalized = String(value || 'high').toLowerCase();
  if (normalized === 'low') return 50;
  if (normalized === 'medium') return 70;
  return 90;
};

const DEFAULT_LOCAL_API_ENDPOINT = 'http://localhost:11434';
const DEFAULT_KIMI_API_ENDPOINT = 'https://api.kimi.com/coding';

const isLikelyOllamaEndpoint = (endpoint: unknown) => {
  const value = String(endpoint || '').toLowerCase();
  if (!value) return false;
  return value.includes('localhost:11434') || value.includes(':11434') || value.includes('ollama');
};

const normalizeEndpointForProvider = (provider: unknown, endpoint: unknown) => {
  const normalizedProvider = String(provider || 'openai').toLowerCase();
  const normalizedEndpoint = String(endpoint || '').trim();
  if (normalizedProvider === 'ollama') {
    return normalizedEndpoint || DEFAULT_LOCAL_API_ENDPOINT;
  }
  if (normalizedProvider === 'kimi') {
    return normalizedEndpoint || DEFAULT_KIMI_API_ENDPOINT;
  }
  if (normalizedProvider === 'custom') {
    return normalizedEndpoint;
  }
  return '';
};

const profileRequiresApiKey = (profile: Record<string, any>) => {
  const provider = String(profile?.provider || '').toLowerCase();
  const endpoint = String(profile?.customEndpoint || '').toLowerCase();
  if (provider === 'ollama') return false;
  if ((provider === 'custom' || provider === 'openai') && isLikelyOllamaEndpoint(endpoint)) {
    return false;
  }
  return true;
};

const clampInt = (value: unknown, fallback: number, min: number, max: number) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const fixedTemperatureForQuality = (qualityMode: QualityMode) => {
  if (qualityMode === 'max') return 0.2;
  if (qualityMode === 'balanced') return 0.3;
  return 0.5;
};

class BackgroundService {
  browserTools: BrowserTools;
  currentSettings: Record<string, any> | null;
  currentPlan: RunPlan | null;
  subAgentCount: number;
  subAgentProfileCursor: number;
  activeRunId: string | null;
  dedicatedTabId: number | null;
  dedicatedTabWindowId: number | null;
  activeRunLockedTabId: number | null;
  executionEvents: ExecutionEvent[];
  executionEventsHydrated: boolean;
  executionEventsFlushTimerId: ReturnType<typeof setTimeout> | null;
  // State tracking for enforcement
  lastBrowserAction: string | null;
  awaitingVerification: boolean;
  currentStepVerified: boolean;
  // Layer 2: Failure tracking for anti-desistance
  consecutiveFailures: number;
  failedTools: Array<{ tool: string; error: string; selector?: string }>;
  evidenceLedger: EvidenceEntry[];

  constructor() {
    this.browserTools = new BrowserTools();
    this.currentSettings = null;
    this.currentPlan = null;
    this.subAgentCount = 0;
    this.subAgentProfileCursor = 0;
    this.activeRunId = null;
    this.dedicatedTabId = null;
    this.dedicatedTabWindowId = null;
    this.activeRunLockedTabId = null;
    this.executionEvents = [];
    this.executionEventsHydrated = false;
    this.executionEventsFlushTimerId = null;
    // State tracking for enforcement
    this.lastBrowserAction = null;
    this.awaitingVerification = false;
    this.currentStepVerified = false;
    this.consecutiveFailures = 0;
    this.failedTools = [];
    this.evidenceLedger = [];
    this.init();
  }

  init() {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => console.error(error));
    void this.hydrateExecutionEvents();

    // Kimi API requires a coding-agent User-Agent header.
    // Chrome MV3 service workers cannot set User-Agent via fetch(),
    // so we use declarativeNetRequest to inject it at the network level.
    chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [9000],
      addRules: [{
        id: 9000,
        priority: 1,
        action: {
          type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
          requestHeaders: [{
            header: 'User-Agent',
            operation: chrome.declarativeNetRequest.HeaderOperation.SET,
            value: 'claude-code/1.0',
          }],
        },
        condition: {
          urlFilter: '||api.kimi.com',
          resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST],
        },
      }],
    }).catch((e) => console.warn('Failed to set Kimi UA rule:', e));

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) =>
      this.handleMessage(message, sendResponse),
    );
  }

  handleMessage(message, sendResponse) {
    try {
      switch (message.type) {
        case 'user_message': {
          sendResponse?.({ success: true, queued: true });
          void this.processUserMessage(
            message.conversationHistory,
            message.selectedTabs || [],
            message.sessionId || `session-${Date.now()}`,
          ).catch((error) => {
            console.error('Error processing user_message:', error);
            this.sendRunErrorFallback(
              message.sessionId || `session-${Date.now()}`,
              error?.message || String(error),
            );
          });
          return false;
        }

        case 'execute_tool': {
          if (this.activeRunId) {
            sendResponse?.({
              success: false,
              error: 'A run is currently in progress. Wait for completion before using manual tools.',
            });
            return false;
          }
          const runMeta: RunMeta = {
            runId: `manual-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            turnId: `manual-turn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            sessionId: message.sessionId || `manual-session-${Date.now()}`,
          };

          void this.loadRuntimeSettings()
            .then((settings) =>
              this.executeToolByName(
                String(message.tool || ''),
                (message.args && typeof message.args === 'object' ? message.args : {}) as Record<string, any>,
                { runMeta, settings, visionProfile: null },
                typeof message.toolCallId === 'string' ? message.toolCallId : undefined,
              ),
            )
            .then((result: any) =>
              sendResponse?.({
                success: !(result && typeof result === 'object' && result.success === false),
                result,
              }),
            )
            .catch((error) =>
              sendResponse?.({
                success: false,
                error: error?.message || String(error),
              }),
            );
          return true;
        }

        case 'get_execution_events': {
          void this.hydrateExecutionEvents()
            .then(() => sendResponse?.({ success: true, events: this.getExecutionEventsSnapshot() }))
            .catch((error) =>
              sendResponse?.({
                success: false,
                error: error?.message || String(error) || 'Failed to load execution events.',
              }),
            );
          return true;
        }

        case 'content_script_ready': {
          sendResponse?.({ success: true, ack: true });
          return false;
        }

        default:
          console.warn('Unknown message type:', message.type);
          sendResponse?.({ success: false, error: `Unknown message type: ${message.type}` });
          return false;
      }
    } catch (error) {
      console.error('Error handling message:', error);
      this.sendRunErrorFallback(message?.sessionId || `session-${Date.now()}`, error?.message || String(error));
      sendResponse?.({ success: false, error: error?.message || String(error) });
      return false;
    }
  }

  async loadRuntimeSettings() {
    const settings = await chrome.storage.local.get([
      'provider',
      'apiKey',
      'model',
      'customEndpoint',
      'systemPrompt',
      'sendScreenshotsAsImages',
      'screenshotQuality',
      'showThinking',
      'streamResponses',
      'useOrchestrator',
      'visionBridge',
      'enableScreenshots',
      'maxTokens',
      'contextLimit',
      'timeout',
      'toolPermissions',
      'allowedDomains',
      'autoRecoveryMode',
      'screenshotOnFailure',
      'screenshotRetention',
      'qualityMode',
      'autoTuneSafety',
      'minimumReportSections',
    ]);

    if (settings.enableScreenshots === undefined) settings.enableScreenshots = true;
    if (settings.sendScreenshotsAsImages === undefined) settings.sendScreenshotsAsImages = false;
    if (settings.visionBridge === undefined) settings.visionBridge = true;
    if (!settings.toolPermissions) {
      settings.toolPermissions = {
        read: true,
        interact: true,
        navigate: true,
        tabs: true,
        screenshots: true,
      };
    }
    if (settings.allowedDomains === undefined) settings.allowedDomains = '';
    if (settings.autoRecoveryMode === undefined) settings.autoRecoveryMode = 'balanced';
    if (settings.screenshotOnFailure === undefined) settings.screenshotOnFailure = true;
    if (settings.screenshotRetention === undefined) settings.screenshotRetention = 'ephemeral';
    if (settings.qualityMode === undefined) settings.qualityMode = 'max';
    if (settings.autoTuneSafety === undefined) settings.autoTuneSafety = true;
    if (settings.minimumReportSections === undefined) settings.minimumReportSections = 5;

    return settings as Record<string, any>;
  }

  normalizeQualityMode(value: unknown): QualityMode {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return 'max';
    if (normalized === 'max' || normalized === 'maximum' || normalized === 'quality') return 'max';
    if (normalized === 'speed' || normalized === 'fast') return 'speed';
    return 'balanced';
  }

  resolveQualityPolicy(
    settings: Record<string, any>,
    profile: Record<string, any>,
  ): {
    qualityMode: QualityMode;
    autoTuneSafety: boolean;
    minimumReportSections: number;
  } {
    const qualityMode = this.normalizeQualityMode(profile.qualityMode ?? settings.qualityMode);
    const autoTuneSafety =
      profile.autoTuneSafety !== undefined
        ? profile.autoTuneSafety !== false
        : settings.autoTuneSafety !== false;
    const minimumReportSections = clampInt(
      profile.minimumReportSections ?? settings.minimumReportSections,
      5,
      3,
      8,
    );
    return {
      qualityMode,
      autoTuneSafety,
      minimumReportSections,
    };
  }

  applyRuntimeQualityTuning(
    settings: Record<string, any>,
    profile: Record<string, any>,
  ): {
    tunedSettings: Record<string, any>;
    tunedProfile: Record<string, any>;
    qualityMode: QualityMode;
    minimumReportSections: number;
    maxOrchestrationPasses: number;
    maxModelSteps: number;
    adjustments: string[];
    strictPlanCompletion: boolean;
  } {
    const tunedSettings = { ...settings };
    const tunedProfile = { ...profile };
    const policy = this.resolveQualityPolicy(tunedSettings, tunedProfile);
    const qualityMode = policy.qualityMode;

    const adjustments: string[] = [];
    const timeoutFloor = qualityMode === 'max' ? 120000 : qualityMode === 'balanced' ? 90000 : 30000;
    const maxTokensFloor = qualityMode === 'max' ? 4096 : qualityMode === 'balanced' ? 3072 : 2048;
    const fixedTemperature = fixedTemperatureForQuality(qualityMode);
    const maxModelSteps = qualityMode === 'max' ? 80 : qualityMode === 'balanced' ? 64 : 40;
    const maxOrchestrationPasses = qualityMode === 'max' ? 16 : qualityMode === 'balanced' ? 12 : 8;

    if (policy.autoTuneSafety) {
      const currentTimeout = resolveTimeoutMs(tunedProfile.timeout ?? tunedSettings.timeout);
      if (currentTimeout < timeoutFloor) {
        tunedProfile.timeout = timeoutFloor;
        tunedSettings.timeout = timeoutFloor;
        adjustments.push(`timeout raised to ${timeoutFloor}ms`);
      }

      const currentMaxTokens = clampInt(
        tunedProfile.maxTokens ?? tunedSettings.maxTokens,
        maxTokensFloor,
        256,
        64000,
      );
      if (currentMaxTokens < maxTokensFloor) {
        tunedProfile.maxTokens = maxTokensFloor;
        tunedSettings.maxTokens = maxTokensFloor;
        adjustments.push(`maxTokens raised to ${maxTokensFloor}`);
      }
    }

    const currentTemperature = Number(tunedProfile.temperature ?? tunedSettings.temperature);
    tunedProfile.temperature = fixedTemperature;
    tunedSettings.temperature = fixedTemperature;
    if (!Number.isFinite(currentTemperature) || Math.abs(currentTemperature - fixedTemperature) > 0.001) {
      adjustments.push(`temperature fixed to ${fixedTemperature}`);
    }

    const modelId = String(tunedProfile.model || tunedSettings.model || '').toLowerCase();
    if (qualityMode === 'max' && /(flash|mini|preview)/.test(modelId)) {
      adjustments.push(
        'selected model may prioritize speed over depth; quality gates and report synthesis were hardened automatically',
      );
    }

    tunedSettings.qualityMode = qualityMode;
    tunedSettings.autoTuneSafety = policy.autoTuneSafety;
    tunedSettings.minimumReportSections = policy.minimumReportSections;
    tunedProfile.qualityMode = qualityMode;
    tunedProfile.autoTuneSafety = policy.autoTuneSafety;
    tunedProfile.minimumReportSections = policy.minimumReportSections;

    return {
      tunedSettings,
      tunedProfile,
      qualityMode,
      minimumReportSections: policy.minimumReportSections,
      maxOrchestrationPasses,
      maxModelSteps,
      adjustments,
      strictPlanCompletion: true,
    };
  }

  async ensureDedicatedRunTab() {
    if (typeof this.dedicatedTabId === 'number') {
      try {
        const existingTab = await chrome.tabs.get(this.dedicatedTabId);
        if (typeof existingTab?.id === 'number') {
          this.dedicatedTabId = existingTab.id;
          if (typeof existingTab.windowId === 'number') {
            this.dedicatedTabWindowId = existingTab.windowId;
          }
          return existingTab.id;
        }
      } catch {
        this.dedicatedTabId = null;
        this.dedicatedTabWindowId = null;
      }
    }

    let targetWindowId: number | undefined;
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (typeof activeTab?.windowId === 'number') {
      targetWindowId = activeTab.windowId;
    } else if (typeof this.dedicatedTabWindowId === 'number') {
      targetWindowId = this.dedicatedTabWindowId;
    }

    const createOptions: chrome.tabs.CreateProperties = {
      url: DEDICATED_RUN_TAB_URL,
      active: false,
    };
    if (typeof targetWindowId === 'number') {
      createOptions.windowId = targetWindowId;
    }

    const createdTab = await chrome.tabs.create(createOptions);
    if (!createdTab || typeof createdTab.id !== 'number') {
      throw new Error('Unable to create dedicated Glide run tab.');
    }
    this.dedicatedTabId = createdTab.id;
    this.dedicatedTabWindowId =
      typeof createdTab.windowId === 'number' ? createdTab.windowId : (targetWindowId ?? null);
    return createdTab.id;
  }

  async processUserMessage(conversationHistory: Message[], _selectedTabs: chrome.tabs.Tab[], sessionId: string) {
    const runMeta: RunMeta = {
      runId: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      turnId: `turn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      sessionId,
    };
    let lockedTabId: number | null = null;

    try {
      if (this.activeRunId) {
        this.sendRuntime(runMeta, {
          type: 'run_error',
          message: 'Another run is already in progress. Wait for completion before starting a new one.',
        });
        return;
      }
      this.activeRunId = runMeta.runId;
      const settings = await this.loadRuntimeSettings();

      // Fix 4: Isolate mutable execution state per call to prevent races between parallel prompts.
      this.currentSettings = settings;
      // Keep instance-level fields in sync for backwards-compat with helpers that read them.
      this.currentPlan = null;
      this.subAgentCount = 0;
      this.subAgentProfileCursor = 0;
      this.lastBrowserAction = null;
      this.awaitingVerification = false;
      this.currentStepVerified = false;
      // Layer 2: Failure tracking for anti-desistance resilience
      this.consecutiveFailures = 0;
      this.failedTools = [];
      this.evidenceLedger = [];

      lockedTabId = await this.ensureDedicatedRunTab();
      this.activeRunLockedTabId = lockedTabId;

      let lockedTab: chrome.tabs.Tab;
      try {
        lockedTab = await chrome.tabs.get(lockedTabId);
      } catch (error) {
        throw new Error(`Failed to load dedicated run tab ${lockedTabId}: ${error?.message || String(error)}`);
      }

      try {
        await this.browserTools.configureSessionTabs([lockedTab], {
          title: 'Glide Locked Run',
          color: 'blue',
        });
      } catch (error) {
        console.warn('Failed to configure dedicated session tab:', error);
      }
      this.sendRuntime(runMeta, {
        type: 'run_warning',
        message: `Run travado na aba dedicada ${lockedTabId}. Todas as acoes do browser usam apenas essa aba.`,
      });

      const orchestratorEnabled = settings.useOrchestrator === true;
      const teamProfiles: Array<{ name: string; provider: string; model: string }> = [];
      const baseProfile = this.resolveProfile(settings);
      const qualityRuntime = this.applyRuntimeQualityTuning(settings, baseProfile);
      const runtimeSettings = qualityRuntime.tunedSettings;
      const runtimeProfile = qualityRuntime.tunedProfile;
      const visionProfile =
        runtimeSettings.visionBridge !== false
          ? runtimeProfile
          : null;
      if (profileRequiresApiKey(runtimeProfile) && !runtimeProfile.apiKey) {
        this.sendRuntime(runMeta, {
          type: 'run_error',
          message: 'Please configure your API key before running.',
        });
        return;
      }

      this.currentSettings = runtimeSettings;
      if (qualityRuntime.adjustments.length > 0) {
        this.sendRuntime(runMeta, {
          type: 'run_warning',
          message: `Auto safety tuning applied (${qualityRuntime.qualityMode}): ${qualityRuntime.adjustments.join('; ')}`,
        });
      }

      const tools = this.getToolsForSession(runtimeSettings, orchestratorEnabled, teamProfiles, lockedTabId);

      const [activeTab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      const sessionTabs = this.browserTools.getSessionTabSummaries();
      const sessionTabContext = sessionTabs
        .filter((tab) => typeof tab.id === 'number')
        .map((tab) => ({
          id: tab.id as number,
          title: tab.title,
          url: tab.url,
        }));
      const workingTabId: number | null = this.browserTools.getCurrentSessionTabId() ?? activeTab?.id ?? null;
      const workingTab = sessionTabs.find((tab) => tab.id === workingTabId);
      const context = {
        currentUrl: workingTab?.url || activeTab?.url || 'unknown',
        currentTitle: workingTab?.title || activeTab?.title || 'unknown',
        tabId: workingTabId,
        availableTabs: sessionTabContext,
        orchestratorEnabled,
        teamProfiles,
      };

      const normalizedHistory = normalizeConversationHistory(conversationHistory || []);
      const model = resolveLanguageModel({
        provider: String(runtimeProfile.provider || 'openai'),
        apiKey: String(runtimeProfile.apiKey || ''),
        model: String(runtimeProfile.model || runtimeSettings.model || ''),
        customEndpoint: String(runtimeProfile.customEndpoint || ''),
      });

      const toolSet = buildToolSet(tools, async (toolName, args, options) =>
        this.executeToolByName(
          toolName,
          args,
                {
                  runMeta,
                  settings: runtimeSettings,
                  visionProfile,
                  lockedTabId,
                },
                options.toolCallId,
              ),
      );

      const streamEnabled = runtimeSettings.streamResponses !== false;
      const maxRecoveryAttempts = 2;
      const maxInvalidFinalRetries = 1;
      const maxOrchestrationPasses = qualityRuntime.maxOrchestrationPasses;
      let recoveryAttempt = 0;
      let invalidFinalRetryCount = 0;
      let currentHistory = normalizedHistory;
      let finalText = '';
      let reasoningText: string | null = null;

      let totalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      let toolResults: Array<Record<string, any>> = [];
      let responseMessages: Message[] = [];
      let qualityReport: Record<string, any> | null = null;

      // Fix 3: Backoff for transient provider errors.
      const providerBackoff = createExponentialBackoff({ baseMs: 500, maxMs: 8000 });
      const MAX_PROVIDER_RETRIES = 3;

      const runModelPass = async (messages: Message[]) => {
        const modelMessages = toModelMessages(messages);
        const timeoutMs = resolveTimeoutMs(runtimeProfile.timeout ?? runtimeSettings.timeout);

        // Fix 5: batch streaming deltas instead of sending one message per chunk.
        let deltaBuffer = '';
        let deltaFlushId: ReturnType<typeof setTimeout> | null = null;
        const flushDeltaBuffer = () => {
          if (!deltaBuffer) return;
          this.sendRuntime(runMeta, { type: 'assistant_stream_delta', content: deltaBuffer, channel: 'text' });
          deltaBuffer = '';
          deltaFlushId = null;
        };

        for (let providerAttempt = 0; providerAttempt < MAX_PROVIDER_RETRIES; providerAttempt += 1) {
          const abortController = new AbortController();
          let timedOut = false;
          let streamStopSent = false;
          let streamedTextBuffer = '';
          const timeoutId = setTimeout(() => {
            timedOut = true;
            abortController.abort();
          }, timeoutMs);

          if (streamEnabled && providerAttempt === 0) {
            this.sendRuntime(runMeta, { type: 'assistant_stream_start' });
          }

          try {
            const result = streamText({
              model,
              system: this.enhanceSystemPrompt(runtimeProfile.systemPrompt || '', context),
              messages: modelMessages,
              tools: toolSet,
              temperature: runtimeProfile.temperature ?? 0.3,
              maxOutputTokens: runtimeProfile.maxTokens ?? 2048,
              stopWhen: stepCountIs(qualityRuntime.maxModelSteps),
              abortSignal: abortController.signal,
              onChunk: ({ chunk }) => {
                if (chunk.type === 'reasoning-delta') {
                  this.sendRuntime(runMeta, {
                    type: 'assistant_stream_delta',
                    content: chunk.text || '',
                    channel: 'reasoning',
                  });
                }
              },
            });

            if (streamEnabled) {
              try {
                for await (const textPart of result.textStream) {
                  streamedTextBuffer += textPart || '';
                  deltaBuffer += textPart || '';
                  // Fix 5: batch at ~16ms to avoid flooding the message channel.
                  if (!deltaFlushId) deltaFlushId = setTimeout(flushDeltaBuffer, 16);
                }
              } finally {
                // Flush any remaining buffered text before sending stream stop.
                if (deltaFlushId) { clearTimeout(deltaFlushId); flushDeltaBuffer(); }
                this.sendRuntime(runMeta, { type: 'assistant_stream_stop' });
                streamStopSent = true;
              }
            } else {
              await result.text;
            }

            const textPromise = (async () => {
              try {
                return await result.text;
              } catch (error) {
                if (isNoOutputGeneratedError(error)) {
                  return streamedTextBuffer || '';
                }
                throw error;
              }
            })();

            const [text, reasoning, usage, steps] = await Promise.all([
              textPromise,
              Promise.resolve(result.reasoningText).catch(() => null),
              Promise.resolve(result.totalUsage).catch(() => ({
                inputTokens: 0,
                outputTokens: 0,
                totalTokens: 0,
              })),
              Promise.resolve(result.steps).catch(() => []),
            ]);

            const normalizedUsage = {
              inputTokens: Number(usage?.inputTokens || 0),
              outputTokens: Number(usage?.outputTokens || 0),
              totalTokens: Number(usage?.totalTokens || 0),
            };

            return {
              text: text || '',
              reasoningText: reasoning || null,
              totalUsage: normalizedUsage,
              toolResults: steps.flatMap((step) => step.toolResults || []),
            };
          } catch (error) {
            if (streamEnabled && !streamStopSent) {
              this.sendRuntime(runMeta, { type: 'assistant_stream_stop' });
            }
            if (deltaFlushId) {
              clearTimeout(deltaFlushId);
              deltaFlushId = null;
            }
            deltaBuffer = '';
            // Fatal errors: timeout or explicit abort — do not retry.
            if (timedOut || isAbortError(error)) {
              throw new Error(`Model request timed out after ${timeoutMs}ms`);
            }
            const attemptNumber = providerAttempt + 1;
            if (attemptNumber >= MAX_PROVIDER_RETRIES) {
              throw error;
            }
            const delayMs = providerBackoff(attemptNumber);
            this.sendRuntime(runMeta, {
              type: 'run_warning',
              message: `Provider error (attempt ${attemptNumber}/${MAX_PROVIDER_RETRIES}), retrying in ${delayMs}ms...`,
            });
            await new Promise((r) => setTimeout(r, delayMs));
          } finally {
            clearTimeout(timeoutId);
          }
        }
        throw new Error('Model retries exhausted before producing a response.');
      };

      let orchestrationPassCount = 0;
      while (true) {
        orchestrationPassCount += 1;
        if (orchestrationPassCount > maxOrchestrationPasses) {
          this.sendRuntime(runMeta, {
            type: 'run_warning',
            message: `Safety stop triggered after ${maxOrchestrationPasses} orchestration passes.`,
          });
          throw new Error(`Safety stop: exceeded ${maxOrchestrationPasses} orchestration passes.`);
        }
        const passResult = await runModelPass(currentHistory);
        const xmlToolCalls = this.extractXmlToolCalls(passResult.text);
        toolResults = passResult.toolResults || [];

        if (xmlToolCalls.length > 0 && toolResults.length === 0 && recoveryAttempt < maxRecoveryAttempts) {
          this.sendRuntime(runMeta, {
            type: 'run_warning',
            message: 'Detected XML tool call output. Executing tools and retrying.',
          });

          const cleanedText = this.stripXmlToolCalls(passResult.text);
          if (cleanedText) {
            currentHistory = normalizeConversationHistory([
              ...currentHistory,
              {
                role: 'assistant',
                content: cleanedText,
                thinking: passResult.reasoningText || null,
              },
            ]);
          }

          const toolMessages: Message[] = [];
          for (const call of xmlToolCalls) {
            const toolCallId = `xml_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const output = await this.executeToolByName(
              call.name,
              call.args,
                {
                  runMeta,
                  settings: runtimeSettings,
                  visionProfile,
                  lockedTabId,
                },
              toolCallId,
            );
            toolMessages.push({
              role: 'tool',
              toolCallId,
              toolName: call.name,
              content: [
                {
                  type: 'tool-result',
                  toolCallId,
                  toolName: call.name,
                  output: (() => {
                    const compactOutput = this.compactToolOutputForHistory(output, call.name);
                    return compactOutput && typeof compactOutput === 'object'
                      ? { type: 'json' as const, value: compactOutput }
                      : { type: 'text' as const, value: String(compactOutput ?? '') };
                  })(),
                },
              ],
            });
          }

          currentHistory = normalizeConversationHistory([
            ...currentHistory,
            ...toolMessages,
            {
              role: 'system',
              content:
                'Previous response included XML tool call markup. Tools were executed. Continue without XML tool tags.',
            },
          ]);

          recoveryAttempt += 1;
          continue;
        }

        // Quality gate: strict plan completion before finalizing.
        const hasFailedTools = (passResult.toolResults || []).some((r: Record<string, any>) => {
          const out = this.extractToolResultOutput(r);
          return out?.success === false;
        });
        const activePlan = this.currentPlan as RunPlan | null;
        const planSteps = activePlan ? activePlan.steps : [];
        const hasPlan = Boolean(activePlan && planSteps.length > 0);
        const pendingSteps = hasPlan ? planSteps.filter((s) => s.status !== 'done') : [];
        const hasPendingPlanSteps = !hasPlan || pendingSteps.length > 0;

        if (qualityRuntime.strictPlanCompletion && hasPendingPlanSteps) {
          const gateReason = hasPlan ? 'plan_incomplete' : 'missing_plan';
          const gateRetryBudget = qualityRuntime.qualityMode === 'max' ? 6 : qualityRuntime.qualityMode === 'balanced' ? 4 : 2;
          if (recoveryAttempt < maxRecoveryAttempts + gateRetryBudget) {
            const partialText = this.stripXmlToolCalls(passResult.text);
            const pendingTitles = pendingSteps.slice(0, 4).map((step) => step.title).join(' | ');
            currentHistory = normalizeConversationHistory([
              ...currentHistory,
              ...(partialText
                ? [{ role: 'assistant' as const, content: partialText, thinking: passResult.reasoningText || null }]
                : []),
              {
                role: 'system' as const,
                content: hasPlan
                  ? `QUALITY GATE: Final response blocked because ${pendingSteps.length} plan step(s) are still pending (${pendingTitles || 'untitled'}). Continue execution with evidence, then call update_plan.`
                  : 'QUALITY GATE: Final response blocked because no plan exists. Your next call must be set_plan with concrete actionable steps.',
              },
            ]);
            recoveryAttempt += 1;
            this.sendRuntime(runMeta, {
              type: 'run_quality_gate',
              state: 'forced_retry',
              reason: gateReason,
              details: {
                hasPlan,
                pendingSteps: pendingSteps.length,
                retryAttempt: recoveryAttempt,
                hasFailedTools,
                qualityMode: qualityRuntime.qualityMode,
              },
            });
            this.sendRuntime(runMeta, {
              type: 'run_warning',
              message: hasPlan
                ? `Quality gate retry ${recoveryAttempt}: ${pendingSteps.length} plan step(s) still pending.`
                : `Quality gate retry ${recoveryAttempt}: no plan created yet.`,
            });
            continue;
          }

          this.sendRuntime(runMeta, {
            type: 'run_quality_gate',
            state: 'blocked',
            reason: gateReason,
            details: {
              hasPlan,
              pendingSteps: pendingSteps.length,
              hasFailedTools,
              qualityMode: qualityRuntime.qualityMode,
            },
          });
          throw new Error(
            hasPlan
              ? `Quality gate blocked finalization: ${pendingSteps.length} plan steps are still pending.`
              : 'Quality gate blocked finalization: no active plan.',
          );
        }

        this.sendRuntime(runMeta, {
          type: 'run_quality_gate',
          state: 'passed',
          reason: 'plan_complete',
          details: {
            totalSteps: planSteps.length,
            qualityMode: qualityRuntime.qualityMode,
          },
        });

        reasoningText = passResult.reasoningText || null;
        totalUsage = passResult.totalUsage || totalUsage;
        const cleanedText = this.stripXmlToolCalls(passResult.text);
        const hadToolCalls = toolResults.length > 0;
        const fallbackText = hadToolCalls ? GENERIC_TOOL_COMPLETION_TEXT : 'Done.';
        const hasValidText = isValidFinalResponse(cleanedText, { allowEmpty: hadToolCalls });
        const structuredFallback = this.buildComprehensiveFallbackReport(
          toolResults,
          qualityRuntime.minimumReportSections,
        );
        const shouldUseToolFallback =
          hadToolCalls &&
          (!hasValidText || !cleanedText || this.isGenericCompletionText(cleanedText));
        const shouldRetryInvalidFinal =
          !hadToolCalls &&
          invalidFinalRetryCount < maxInvalidFinalRetries &&
          (!hasValidText || !cleanedText || this.isGenericCompletionText(cleanedText));

        if (shouldRetryInvalidFinal) {
          invalidFinalRetryCount += 1;
          const retryHistory = [...currentHistory];
          if (cleanedText) {
            retryHistory.push({
              role: 'assistant',
              content: cleanedText,
              thinking: passResult.reasoningText || null,
            });
          }
          retryHistory.push({
            role: 'system',
            content:
              'Previous attempt returned no usable final answer. Respond to the user now with a direct final answer in the user language. Do not mention internal errors or ask to retry unless strictly necessary. If you lack critical data, clearly say what is missing and provide the next concrete step.',
          });
          currentHistory = normalizeConversationHistory(retryHistory);
          this.sendRuntime(runMeta, {
            type: 'run_warning',
            message: 'Model returned no usable final text; retrying final answer once.',
          });
          continue;
        }

        if (shouldUseToolFallback) {
          finalText = structuredFallback || this.buildToolResultFallback(toolResults) || fallbackText;
        } else if (hasValidText) {
          const baseText = cleanedText || fallbackText;
          finalText = this.isLowDetailFinal(baseText, qualityRuntime.minimumReportSections)
            ? `${baseText}\n\n${structuredFallback}`.trim()
            : baseText;
        } else {
          finalText =
            structuredFallback ||
            this.buildToolResultFallback(toolResults) ||
            'Nao consegui gerar uma resposta final confiavel neste turno. Tente novamente em alguns segundos.';
        }
        qualityReport = this.buildQualityReport({
          qualityMode: qualityRuntime.qualityMode,
          minimumReportSections: qualityRuntime.minimumReportSections,
          plan: this.currentPlan,
          toolResults,
          finalText,
        });

        responseMessages = [
          {
            role: 'assistant',
            content: finalText,
            thinking: reasoningText || null,
          },
        ];
        if (toolResults.length > 0) {
          responseMessages.push({
            role: 'tool',
            content: this.buildToolResultMessageContent(toolResults),
          });
        }

        break;
      }

      this.sendRuntime(runMeta, {
        type: 'assistant_final',
        content: finalText,
        thinking: reasoningText || null,
        model: runtimeProfile.model || runtimeSettings.model || '',
        usage: {
          inputTokens: totalUsage.inputTokens || 0,
          outputTokens: totalUsage.outputTokens || 0,
          totalTokens: totalUsage.totalTokens || 0,
        },
        responseMessages,
        qualityReport,
      });

      const nextHistory = normalizeConversationHistory([...currentHistory, ...responseMessages]);
      const contextLimit = runtimeProfile.contextLimit || runtimeSettings.contextLimit || 200000;
      const compactionSettings = DEFAULT_COMPACTION_SETTINGS;
      const contextUsage = estimateContextTokens(nextHistory);
      const compactionCheck = shouldCompact({
        contextTokens: contextUsage.tokens,
        contextLimit,
        settings: compactionSettings,
      });

      if (compactionCheck.shouldCompact) {
        let summaryIndex = -1;
        for (let i = nextHistory.length - 1; i >= 0; i -= 1) {
          const msg = nextHistory[i];
          if (msg.role === 'system' && msg.meta?.kind === 'summary') {
            summaryIndex = i;
            break;
          }
        }

        const previousSummary =
          summaryIndex >= 0
            ? typeof nextHistory[summaryIndex].content === 'string'
              ? nextHistory[summaryIndex].content
              : JSON.stringify(nextHistory[summaryIndex].content)
            : undefined;

        const compactionStart = summaryIndex >= 0 ? summaryIndex + 1 : 0;
        const cutIndex = findCutPoint(nextHistory, compactionStart, compactionSettings.keepRecentTokens);
        const messagesToSummarize = nextHistory.slice(compactionStart, cutIndex);
        const preserved = nextHistory.slice(cutIndex);

        if (messagesToSummarize.length > 0) {
          const conversationText = serializeConversation(messagesToSummarize);
          let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
          if (previousSummary) {
            promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
          }
          promptText += previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;

          const compactionTimeoutMs = resolveTimeoutMs(runtimeProfile.timeout ?? runtimeSettings.timeout);
          const compactionAbort = new AbortController();
          let compactionTimedOut = false;
          const compactionTimer = setTimeout(() => {
            compactionTimedOut = true;
            compactionAbort.abort();
          }, compactionTimeoutMs);

          let summaryResult: { text: string } | null = null;
          try {
            summaryResult = await generateText({
              model,
              system: SUMMARIZATION_SYSTEM_PROMPT,
              messages: [
                {
                  role: 'user',
                  content: promptText,
                },
              ],
              temperature: 0.2,
              maxOutputTokens: Math.floor(0.8 * compactionSettings.reserveTokens),
              abortSignal: compactionAbort.signal,
            });
          } catch (summaryError) {
            if (compactionTimedOut || isAbortError(summaryError)) {
              this.sendRuntime(runMeta, {
                type: 'run_warning',
                message: `Context compaction timed out after ${compactionTimeoutMs}ms; keeping current context.`,
              });
            } else {
              console.warn('Context compaction failed:', summaryError);
            }
          } finally {
            clearTimeout(compactionTimer);
          }

          if (!summaryResult) {
            return;
          }

          const summaryMessage = buildCompactionSummaryMessage(summaryResult.text, messagesToSummarize.length);
          const compaction = applyCompaction({
            summaryMessage,
            preserved,
            trimmedCount: messagesToSummarize.length,
          });
          const newSessionId = `session-${Date.now()}`;

          this.sendRuntime(runMeta, {
            type: 'context_compacted',
            summary: summaryResult.text,
            trimmedCount: messagesToSummarize.length,
            preservedCount: compaction.preservedCount,
            newSessionId,
            contextMessages: compaction.compacted,
            contextUsage: {
              approxTokens: compactionCheck.approxTokens,
              contextLimit,
              percent: Math.round(compactionCheck.percent * 100),
            },
          });
        }
      }
    } catch (error) {
      console.error('Error processing user message:', error);
      this.sendRuntime(runMeta, {
        type: 'run_error',
        message: error?.message || 'Unknown error',
      });
    } finally {
      if (this.activeRunId === runMeta.runId) {
        this.activeRunId = null;
      }
      if (this.activeRunLockedTabId === lockedTabId) {
        this.activeRunLockedTabId = null;
      }
    }
  }

  async executeToolByName(
    toolName: string,
    args: Record<string, any>,
    options: {
      runMeta: RunMeta;
      settings: Record<string, any>;
      visionProfile?: Record<string, any> | null;
      lockedTabId?: number | null;
    },
    toolCallId?: string,
  ) {
    const effectiveSettings = (options.settings || this.currentSettings || {}) as Record<string, any>;
    const lockedTabId = typeof options.lockedTabId === 'number' ? options.lockedTabId : null;
    const callId = toolCallId || `tool_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const startedAt = Date.now();
    const sendStart = () =>
      this.sendRuntime(options.runMeta, {
        type: 'tool_execution_start',
        tool: toolName,
        id: callId,
        args,
      });
    const sendResult = (
      result: unknown,
      eventArgs: Record<string, any> = args,
      runtimeMeta: {
        recoveryStage?: RecoveryStage;
        evidenceConfidence?: EvidenceConfidence;
        failureClass?: FailureClass;
      } = {},
    ) => {
      this.sendRuntime(options.runMeta, {
        type: 'tool_execution_result',
        tool: toolName,
        id: callId,
        args: eventArgs,
        result,
        ...runtimeMeta,
      });
      this.recordExecutionEvent(options.runMeta, {
        toolName,
        callId,
        args: eventArgs,
        result,
        startedAt,
      });
    };

    sendStart();

    if (toolName === 'set_plan') {
      const plan = this.buildPlanFromArgs(args);
      if (!plan) {
        const errorResult = {
          success: false,
          error: 'Plan must include steps array with title for each step.',
          hint: 'Example: set_plan({ steps: [{ title: "Navigate to site" }, { title: "Click login" }] })',
          received: JSON.stringify(args).slice(0, 200),
        };
        sendResult(errorResult);
        return errorResult;
      }
      this.currentPlan = plan;
      this.sendRuntime(options.runMeta, { type: 'plan_update', plan });
      const result = {
        success: true,
        plan,
        message: `Plan created with ${plan.steps.length} steps. Use update_plan({ step_index: 0, status: "done" }) after completing each step.`,
      };
      sendResult(result);
      return result;
    }

    if (toolName === 'update_plan') {
      if (!this.currentPlan) {
        const errorResult = {
          success: false,
          error: 'No active plan to update. Call set_plan first.',
          hint: 'Create a plan with set_plan({ steps: [{ title: "..." }, ...] }) before updating.',
        };
        sendResult(errorResult);
        return errorResult;
      }
      const rawIndex = args.step_index;
      const parsedIndex = typeof rawIndex === 'number' ? rawIndex : Number(rawIndex);
      const stepIndex = Number.isFinite(parsedIndex) ? parsedIndex : -1;
      const rawStatus = typeof args.status === 'string' ? args.status : 'done';
      const status = rawStatus === 'pending' || rawStatus === 'done' || rawStatus === 'blocked' ? rawStatus : 'done';
      const maxIndex = this.currentPlan.steps.length - 1;
      if (stepIndex < 0 || stepIndex > maxIndex) {
        const errorResult = {
          success: false,
          error: `Invalid step_index: ${stepIndex}. Valid range is 0-${maxIndex}.`,
          hint: `Plan has ${this.currentPlan.steps.length} steps (indices 0 to ${maxIndex}).`,
          currentPlan: this.currentPlan.steps.map((s, i) => `${i}: ${s.title} [${s.status}]`),
        };
        sendResult(errorResult);
        return errorResult;
      }
      this.currentPlan.steps[stepIndex].status = status;
      this.currentPlan.updatedAt = Date.now();
      this.sendRuntime(options.runMeta, { type: 'plan_update', plan: this.currentPlan });
      const result = { success: true, step: stepIndex, status, plan: this.currentPlan };
      sendResult(result);
      return result;
    }

    if (toolName === 'spawn_subagent') {
      const result = await this.handleSpawnSubagent(options.runMeta, args);
      sendResult(result);
      return result;
    }

    if (toolName === 'subagent_complete') {
      const result = { success: true, ack: true, details: args || {} };
      sendResult(result);
      return result;
    }

    const available = this.browserTools?.tools ? Object.keys(this.browserTools.tools) : [];
    if (!available.includes(toolName)) {
      const errorResult = {
        success: false,
        error: `Unknown tool: ${toolName}`,
      };
      sendResult(errorResult);
      return errorResult;
    }

    const isBrowserTool = available.includes(toolName);
    if (lockedTabId && isBrowserTool) {
      if (!LOCKED_TAB_ALLOWED_BROWSER_TOOLS.has(toolName)) {
        const blocked = {
          success: false,
          code: 'TAB_LOCK_POLICY',
          error: `Tool "${toolName}" is blocked in dedicated locked-tab mode.`,
          policy: {
            type: 'tab_lock',
            lockedTabId,
            tool: toolName,
            reason: 'Tool is outside the dedicated-tab allowlist.',
          },
        };
        this.sendRuntime(options.runMeta, {
          type: 'run_warning',
          message: `Politica de lock bloqueou "${toolName}" fora da allowlist da aba dedicada ${lockedTabId}.`,
        });
        sendResult(blocked);
        return blocked;
      }
      if (typeof args?.tabId === 'number' && args.tabId !== lockedTabId) {
        const blocked = {
          success: false,
          code: 'TAB_LOCK_POLICY',
          error: `Tab mismatch: run is locked to tab ${lockedTabId}, received tabId ${args.tabId}.`,
          policy: {
            type: 'tab_lock',
            lockedTabId,
            requestedTabId: args.tabId,
            tool: toolName,
            reason: 'Explicit tabId does not match the dedicated run tab.',
          },
        };
        this.sendRuntime(options.runMeta, {
          type: 'run_warning',
          message: `Politica de lock bloqueou "${toolName}" com tabId ${args.tabId}. A execucao permanece na aba ${lockedTabId}.`,
        });
        sendResult(blocked);
        return blocked;
      }
      try {
        await chrome.tabs.get(lockedTabId);
      } catch (error) {
        const blocked = {
          success: false,
          code: 'TAB_LOCK_POLICY',
          error: `Dedicated locked tab ${lockedTabId} is unavailable.`,
          policy: {
            type: 'tab_lock',
            lockedTabId,
            tool: toolName,
            reason: `Locked tab unavailable: ${error?.message || String(error)}`,
          },
        };
        this.sendRuntime(options.runMeta, {
          type: 'run_warning',
          message: `A aba dedicada ${lockedTabId} nao esta disponivel; a ferramenta "${toolName}" foi bloqueada.`,
        });
        sendResult(blocked);
        return blocked;
      }
    }

    const permissionCheck = await this.checkToolPermission(toolName, args, effectiveSettings);
    if (!permissionCheck.allowed) {
      const blocked = {
        success: false,
        error: permissionCheck.reason || 'Tool blocked by permissions.',
        policy: permissionCheck.policy,
      };
      sendResult(blocked);
      return blocked;
    }

    if (toolName === 'screenshot' && effectiveSettings.enableScreenshots === false) {
      const blocked = {
        success: false,
        error: 'Screenshots are disabled in settings.',
      };
      sendResult(blocked);
      return blocked;
    }

    let result: any;
    let toolArgs = args;
    if (lockedTabId && isBrowserTool && LOCKED_TAB_ALLOWED_BROWSER_TOOLS.has(toolName)) {
      toolArgs = {
        ...args,
        tabId: lockedTabId,
        _strictTabId: true,
      };
    }
    if (toolName === 'screenshot') {
      const defaultFormat = typeof toolArgs?.format === 'string' ? toolArgs.format : 'jpeg';
      const defaultQuality =
        typeof toolArgs?.quality === 'number'
          ? toolArgs.quality
          : mapScreenshotQuality(effectiveSettings.screenshotQuality);
      toolArgs = {
        ...toolArgs,
        format: defaultFormat,
        quality: defaultQuality,
      };
    }
    try {
      result = await this.browserTools.executeTool(toolName, toolArgs);
    } catch (error) {
      const errorResult = {
        success: false,
        error: error?.message || String(error) || 'Tool execution failed',
      };
      sendResult(errorResult, toolArgs);
      return errorResult;
    }

    // Track state for enforcement
    const isBrowserAction = BROWSER_ACTION_TOOLS.includes(toolName as (typeof BROWSER_ACTION_TOOLS)[number]);
    if (isBrowserAction) {
      this.lastBrowserAction = toolName;
      this.awaitingVerification = true;
      this.currentStepVerified = false;
      // Layer 2b: Track consecutive browser action failures
      if (result?.success === false) {
        this.consecutiveFailures = (this.consecutiveFailures || 0) + 1;
        if (!Array.isArray(this.failedTools)) this.failedTools = [];
        this.failedTools.push({
          tool: toolName,
          error: String(result?.error || '').slice(0, 120),
          selector: String(toolArgs?.selector || '').slice(0, 120),
        });
      } else {
        this.consecutiveFailures = 0;
      }
    } else if (toolName === 'getContent') {
      this.awaitingVerification = false;
    }

    const finalResult: Record<string, any> =
      result && typeof result === 'object' && !Array.isArray(result)
        ? { ...(result as Record<string, any>) }
        : { success: false, error: 'No result returned' };
    let recoveryStage: RecoveryStage = 'none';

    // Layer 4: Auto-screenshot on browser action failure for visual recovery
    if (
      isBrowserAction &&
      finalResult?.success === false &&
      effectiveSettings.screenshotOnFailure !== false
    ) {
      try {
        const recoveryScreenshotArgs: Record<string, any> = {
          format: 'jpeg',
          quality: 50,
        };
        if (lockedTabId) {
          recoveryScreenshotArgs.tabId = lockedTabId;
          recoveryScreenshotArgs._strictTabId = true;
        }
        const screenshotResult = await this.browserTools.executeTool(
          'screenshot',
          recoveryScreenshotArgs,
        ) as Record<string, any>;
        if (screenshotResult?.success) {
          recoveryStage = 'screenshot';
          finalResult.recoveryScreenshotCaptured = true;
          finalResult.recoveryScreenshotFormat = screenshotResult.format || 'jpeg';
          if (typeof screenshotResult.tabId === 'number') {
            finalResult.recoveryTabId = screenshotResult.tabId;
          }
          if (this.shouldIncludeScreenshotData(effectiveSettings) && typeof screenshotResult.dataUrl === 'string') {
            finalResult.recoveryScreenshotDataUrl = screenshotResult.dataUrl;
          }
          if (
            options.visionProfile?.apiKey &&
            effectiveSettings.visionBridge !== false &&
            typeof screenshotResult.dataUrl === 'string'
          ) {
            const description = await describeImageWithModel({
              settings: {
                provider: options.visionProfile.provider,
                apiKey: options.visionProfile.apiKey,
                model: options.visionProfile.model,
                customEndpoint: options.visionProfile.customEndpoint,
              },
              dataUrl: screenshotResult.dataUrl as string,
              prompt: `A browser action "${toolName}" failed with error: "${finalResult.error}". Describe what is visible on screen so the agent can find an alternative approach. List any buttons, tabs, links, or interactive elements you can see.`,
            });
            finalResult.visualContext = description;
            finalResult.hint = `${finalResult.hint ? `${finalResult.hint} ` : ''}Use the visualContext above to find alternative selectors or actions.`;
            recoveryStage = 'vision';
          } else {
            finalResult.visualContext = 'Screenshot captured. Vision analysis is unavailable. Re-check page structure and retry with alternative selectors.';
            finalResult.hint = `${finalResult.hint ? `${finalResult.hint} ` : ''}Call getContent({ mode: "structure" }) and retry with a different selector strategy.`;
          }
        } else {
          finalResult.recoveryScreenshotError = screenshotResult?.error || 'Failed to capture screenshot for recovery.';
        }
      } catch (visionError) {
        // Silent fail — best-effort recovery
        console.warn('Auto-screenshot recovery failed:', visionError);
        finalResult.recoveryScreenshotError = String((visionError as { message?: string })?.message || visionError || '');
      }
    }

    if (
      toolName === 'screenshot' &&
      finalResult?.success &&
      finalResult.dataUrl &&
      effectiveSettings.visionBridge &&
      options.visionProfile?.apiKey
    ) {
      try {
        const description = await describeImageWithModel({
          settings: {
            provider: options.visionProfile.provider,
            apiKey: options.visionProfile.apiKey,
            model: options.visionProfile.model,
            customEndpoint: options.visionProfile.customEndpoint,
          },
          dataUrl: finalResult.dataUrl,
          prompt: 'Provide a concise description of this screenshot for a non-vision model.',
        });
        finalResult.visionDescription = description;
        finalResult.message = 'Screenshot captured and described by vision model.';
        recoveryStage = 'vision';
      } catch (visionError) {
        finalResult.visionError = visionError.message;
      }
    }

    if (toolName === 'screenshot' && !this.shouldIncludeScreenshotData(effectiveSettings)) {
      delete finalResult.dataUrl;
    }

    const failureClass = this.classifyFailure(toolName, finalResult);
    if (failureClass !== 'unknown') {
      finalResult.failureClass = failureClass;
    }
    finalResult.recoveryStage = finalResult.recoveryStage || recoveryStage;
    finalResult.evidenceConfidence = finalResult.evidenceConfidence || this.deriveEvidenceConfidence(toolName, finalResult);
    finalResult.attempt = typeof toolArgs?.attempt === 'number' ? toolArgs.attempt : 1;
    finalResult.nextHint = finalResult.nextHint || this.buildNextHint(toolName, finalResult, failureClass);
    this.captureEvidenceFromToolResult(toolName, finalResult, toolArgs);

    const sanitizedResult = this.sanitizeToolResultForRuntime(finalResult, toolName, effectiveSettings);
    const enrichedResult = this.attachPlanToResult(sanitizedResult, toolName);
    const resultRecord =
      enrichedResult && typeof enrichedResult === 'object' && !Array.isArray(enrichedResult)
        ? (enrichedResult as Record<string, any>)
        : {};
    sendResult(enrichedResult, toolArgs, {
      recoveryStage: resultRecord.recoveryStage as RecoveryStage | undefined,
      evidenceConfidence: resultRecord.evidenceConfidence as EvidenceConfidence | undefined,
      failureClass: resultRecord.failureClass as FailureClass | undefined,
    });
    return enrichedResult;
  }

  async hydrateExecutionEvents() {
    if (this.executionEventsHydrated) return;
    let loaded: unknown[] = [];

    try {
      const stored = await chrome.storage.session.get([EXECUTION_EVENTS_KEY]);
      loaded = Array.isArray(stored?.[EXECUTION_EVENTS_KEY]) ? stored[EXECUTION_EVENTS_KEY] : [];
    } catch {
      // Session storage may be unavailable in some contexts.
    }

    if (!Array.isArray(loaded) || loaded.length === 0) {
      try {
        const fallback = await chrome.storage.local.get([EXECUTION_EVENTS_KEY]);
        loaded = Array.isArray(fallback?.[EXECUTION_EVENTS_KEY]) ? fallback[EXECUTION_EVENTS_KEY] : [];
      } catch {
        loaded = [];
      }
    }

    const normalized = loaded
      .map((event) => this.normalizeExecutionEvent(event))
      .filter((event): event is ExecutionEvent => Boolean(event));

    if (normalized.length > 0) {
      if (this.executionEvents.length > 0) {
        const map = new Map<string, ExecutionEvent>();
        normalized.forEach((event) => map.set(event.id, event));
        this.executionEvents.forEach((event) => map.set(event.id, event));
        this.executionEvents = Array.from(map.values()).slice(-MAX_EXECUTION_EVENTS);
      } else {
        this.executionEvents = normalized.slice(-MAX_EXECUTION_EVENTS);
      }
    }

    this.executionEventsHydrated = true;
  }

  normalizeExecutionEvent(event: unknown): ExecutionEvent | null {
    if (!event || typeof event !== 'object') return null;
    const raw = event as Record<string, unknown>;
    const startedAt = Number(raw.startedAt || 0);
    const endedAt = Number(raw.endedAt || startedAt);
    const success = raw.success !== false;
    const tabId = typeof raw.tabId === 'number' ? raw.tabId : null;

    return {
      id: this.trimExecutionText(String(raw.id || `evt_${Date.now()}`), 80),
      runId: this.trimExecutionText(String(raw.runId || ''), 80),
      turnId: this.trimExecutionText(String(raw.turnId || ''), 80),
      sessionId: this.trimExecutionText(String(raw.sessionId || ''), 80),
      toolName: this.trimExecutionText(String(raw.toolName || ''), 60),
      callId: this.trimExecutionText(String(raw.callId || ''), 80),
      startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
      endedAt: Number.isFinite(endedAt) ? endedAt : Date.now(),
      durationMs: Math.max(0, Number(raw.durationMs || endedAt - startedAt || 0)),
      tabId,
      url: this.trimExecutionText(String(raw.url || ''), EXECUTION_TEXT_LIMIT),
      success,
      errorCode: this.trimExecutionText(String(raw.errorCode || ''), 80),
      errorMessage: this.trimExecutionText(String(raw.errorMessage || ''), EXECUTION_TEXT_LIMIT),
      resultPreview: this.trimExecutionText(String(raw.resultPreview || ''), EXECUTION_PREVIEW_LIMIT),
    };
  }

  trimExecutionText(value: string, limit: number) {
    const text = String(value || '');
    if (text.length <= limit) return text;
    return `${text.slice(0, limit)}...`;
  }

  isSensitiveTelemetryKey(key: string) {
    const normalized = String(key || '').toLowerCase();
    if (!normalized) return false;
    return (
      normalized.includes('apikey') ||
      normalized.includes('api_key') ||
      normalized.includes('token') ||
      normalized.includes('secret') ||
      normalized.includes('password') ||
      normalized.includes('authorization') ||
      normalized.includes('cookie') ||
      normalized === 'text' ||
      normalized === 'value' ||
      normalized === 'content'
    );
  }

  sanitizeTelemetryValue(value: unknown, key = '', depth = 0): unknown {
    if (value === null || value === undefined) return value;
    if (this.isSensitiveTelemetryKey(key)) {
      const raw = typeof value === 'string' ? value : JSON.stringify(value);
      return `<redacted:${String(raw || '').length} chars>`;
    }
    if (typeof value === 'string') {
      return this.trimExecutionText(value, 180);
    }
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) {
      const maxItems = depth === 0 ? 20 : 8;
      return value.slice(0, maxItems).map((item) => this.sanitizeTelemetryValue(item, '', depth + 1));
    }
    if (typeof value === 'object') {
      if (depth >= 2) return '[omitted]';
      const source = value as Record<string, unknown>;
      const sanitized: Record<string, unknown> = {};
      let count = 0;
      for (const [nestedKey, raw] of Object.entries(source)) {
        if (count >= 20) break;
        if (nestedKey === 'dataUrl' && typeof raw === 'string') {
          sanitized[nestedKey] = `<dataUrl:${raw.length} chars>`;
        } else {
          sanitized[nestedKey] = this.sanitizeTelemetryValue(raw, nestedKey, depth + 1);
        }
        count += 1;
      }
      return sanitized;
    }
    return String(value);
  }

  stringifyExecutionPreview(value: unknown) {
    try {
      if (typeof value === 'string') {
        return this.trimExecutionText(value, EXECUTION_PREVIEW_LIMIT);
      }
      if (value && typeof value === 'object') {
        const sanitized = this.sanitizeTelemetryValue(value, '', 0);
        return this.trimExecutionText(JSON.stringify(sanitized), EXECUTION_PREVIEW_LIMIT);
      }
      return this.trimExecutionText(JSON.stringify(value), EXECUTION_PREVIEW_LIMIT);
    } catch {
      return this.trimExecutionText(String(value), EXECUTION_PREVIEW_LIMIT);
    }
  }

  getScreenshotRetentionMode(settings: Record<string, any> | null = this.currentSettings): 'ephemeral' | 'debug-short' | 'persistent' {
    const raw = String(settings?.screenshotRetention || 'ephemeral').toLowerCase();
    if (raw === 'persistent') return 'persistent';
    if (raw === 'debug-short') return 'debug-short';
    return 'ephemeral';
  }

  shouldIncludeScreenshotData(settings: Record<string, any> | null = this.currentSettings) {
    const retention = this.getScreenshotRetentionMode(settings);
    if (retention === 'persistent') return true;
    if (retention === 'debug-short') return settings?.sendScreenshotsAsImages === true;
    return false;
  }

  sanitizeToolResultForRuntime(
    result: Record<string, any>,
    toolName: string,
    settings: Record<string, any> | null = this.currentSettings,
  ) {
    const sanitized: Record<string, any> = { ...result };
    const dropDataUrlField = (field: string) => {
      if (typeof sanitized[field] !== 'string') return;
      sanitized[`${field}Length`] = sanitized[field].length;
      delete sanitized[field];
    };

    if (!this.shouldIncludeScreenshotData(settings)) {
      dropDataUrlField('dataUrl');
      dropDataUrlField('recoveryScreenshotDataUrl');
    }

    if (typeof sanitized.error === 'string') sanitized.error = this.trimExecutionText(sanitized.error, 300);
    if (typeof sanitized.hint === 'string') sanitized.hint = this.trimExecutionText(sanitized.hint, 400);
    if (typeof sanitized.nextHint === 'string') sanitized.nextHint = this.trimExecutionText(sanitized.nextHint, 400);
    if (typeof sanitized.visualContext === 'string') {
      sanitized.visualContext = this.trimExecutionText(sanitized.visualContext, 1200);
    }
    if (typeof sanitized.visionDescription === 'string') {
      sanitized.visionDescription = this.trimExecutionText(sanitized.visionDescription, 1200);
    }
    if (Array.isArray(sanitized.similar_elements) && sanitized.similar_elements.length > 12) {
      sanitized.similar_elements = sanitized.similar_elements.slice(0, 12);
    }

    if (toolName !== 'screenshot') {
      dropDataUrlField('dataUrl');
    }

    return sanitized;
  }

  summarizePlanForHistory(plan: unknown) {
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return null;
    const source = plan as Record<string, any>;
    const steps = Array.isArray(source.steps) ? source.steps : [];
    const doneCount = steps.filter((step) => step?.status === 'done').length;
    const runningCount = steps.filter((step) => step?.status === 'running').length;

    return {
      stepCount: steps.length,
      doneCount,
      runningCount,
      updatedAt: Number(source.updatedAt || 0) || null,
    };
  }

  compactToolValueForHistory(value: unknown, key: string, depth = 0): unknown {
    if (value === null || value === undefined) return value;

    if (typeof value === 'string') {
      const keyLower = key.toLowerCase();
      if (this.isSensitiveTelemetryKey(keyLower)) return `<redacted:${value.length} chars>`;
      if (keyLower.includes('dataurl')) return `<redacted:${value.length} chars>`;
      if (keyLower.includes('error')) return this.trimExecutionText(value, 320);
      if (keyLower.includes('hint')) return this.trimExecutionText(value, 420);
      if (keyLower.includes('content')) return this.trimExecutionText(value, 1800);
      if (keyLower.includes('html') || keyLower.includes('markdown')) return this.trimExecutionText(value, 1200);
      return this.trimExecutionText(value, 700);
    }

    if (typeof value === 'number' || typeof value === 'boolean') return value;

    if (Array.isArray(value)) {
      const maxItems = depth === 0 ? 20 : 10;
      return value
        .slice(0, maxItems)
        .map((item) => this.compactToolValueForHistory(item, '', depth + 1));
    }

    if (typeof value === 'object') {
      if (depth >= 2) return '[omitted]';
      const source = value as Record<string, unknown>;
      const entries = Object.entries(source);
      const maxEntries = depth === 0 ? 16 : 10;
      const compacted: Record<string, unknown> = {};
      for (const [nestedKey, nestedValue] of entries.slice(0, maxEntries)) {
        compacted[nestedKey] = this.compactToolValueForHistory(nestedValue, nestedKey, depth + 1);
      }
      if (entries.length > maxEntries) {
        compacted.truncatedFieldCount = entries.length - maxEntries;
      }
      return compacted;
    }

    return String(value);
  }

  compactToolOutputForHistory(output: unknown, toolName: string) {
    if (output === null || output === undefined) return output;
    if (typeof output === 'string') return this.trimExecutionText(output, 1800);
    if (Array.isArray(output)) {
      return this.compactToolValueForHistory(output, '', 0);
    }
    if (!output || typeof output !== 'object') {
      return output;
    }

    const runtimeSanitized = this.sanitizeToolResultForRuntime(output as Record<string, any>, toolName);
    const compacted: Record<string, unknown> = {};
    const planSummary = this.summarizePlanForHistory(runtimeSanitized.plan);
    if (planSummary) {
      compacted.planSummary = planSummary;
    }

    const entries = Object.entries(runtimeSanitized).filter(([key]) => key !== 'plan');
    const maxEntries = 26;
    for (const [key, value] of entries.slice(0, maxEntries)) {
      compacted[key] = this.compactToolValueForHistory(value, key, 0);
    }
    if (entries.length > maxEntries) {
      compacted.truncatedFieldCount = entries.length - maxEntries;
    }

    return compacted;
  }

  buildToolResultMessageContent(toolResults: Array<Record<string, any>> = []) {
    if (!Array.isArray(toolResults) || toolResults.length === 0) return [];

    return toolResults.map((resultItem) => {
      const toolName = String(resultItem?.toolName || resultItem?.name || '');
      const rawOutput =
        Object.prototype.hasOwnProperty.call(resultItem, 'output')
          ? resultItem.output
          : (resultItem as Record<string, unknown>).result;
      const compactOutput = this.compactToolOutputForHistory(rawOutput, toolName);

      return {
        type: 'tool-result' as const,
        toolCallId: resultItem.toolCallId,
        toolName,
        output:
          compactOutput && typeof compactOutput === 'object'
            ? { type: 'json' as const, value: compactOutput }
            : { type: 'text' as const, value: String(compactOutput ?? '') },
      };
    });
  }

  classifyFailure(toolName: string, result: Record<string, any>): FailureClass {
    if (!result || result.success !== false) return 'unknown';
    const code = String(result.code || '').toLowerCase();
    const message = String(result.error || '').toLowerCase();
    const policyReason = String(result.policy?.reason || '').toLowerCase();

    if (
      code.includes('permission') ||
      message.includes('permission blocked') ||
      message.includes('allowlist') ||
      policyReason.includes('blocked')
    ) {
      return 'permission';
    }

    if (code.includes('timeout') || message.includes('timed out') || message.includes('timeout')) {
      return 'timing';
    }

    if (
      toolName === 'navigate' ||
      code === 'no_executable_tab' ||
      message.includes('invalid url') ||
      message.includes('navigation failed') ||
      message.includes('no active tab')
    ) {
      return 'navigation';
    }

    if (
      code === 'tab_inaccessible' ||
      message.includes('selector') ||
      message.includes('element not found') ||
      message.includes('target not found')
    ) {
      return 'selector';
    }

    return 'unknown';
  }

  deriveEvidenceConfidence(toolName: string, result: Record<string, any>): EvidenceConfidence {
    if (!result || result.success === false) return 'low';
    if (toolName === 'getContent') return 'high';
    if (toolName === 'screenshot' && (result.visionDescription || result.visualContext)) return 'high';
    if (result.visualContext || result.visionDescription) return 'medium';
    return 'medium';
  }

  buildNextHint(toolName: string, result: Record<string, any>, failureClass: FailureClass) {
    if (!result || result.success !== false) {
      if (toolName === 'getContent') return 'Use this evidence to update the plan step before continuing.';
      if (toolName === 'screenshot') return 'Use visionDescription or visualContext to pick the next interaction.';
      return 'Continue with the next plan step and verify with getContent.';
    }

    if (failureClass === 'selector') {
      return 'Call getContent({ mode: "structure" }) and retry with text-based or aria-label selectors.';
    }
    if (failureClass === 'timing') {
      return 'Wait briefly, then retry the same step or scroll to trigger lazy-rendered elements.';
    }
    if (failureClass === 'permission') {
      return 'Adjust tool permissions/allowlist in settings, then rerun the action.';
    }
    if (failureClass === 'navigation') {
      return 'Ensure you are on an accessible http(s) tab and retry navigation.';
    }
    return 'Call getContent({ mode: "structure" }), review visible elements, and retry with an alternative strategy.';
  }

  resolveExecutionTabId(args: Record<string, any> | undefined, result: Record<string, any> | undefined) {
    if (typeof args?.tabId === 'number') return args.tabId;
    if (typeof result?.resolvedTabId === 'number') return result.resolvedTabId;
    if (typeof result?.tabId === 'number') return result.tabId;
    return null;
  }

  resolveExecutionUrl(args: Record<string, any> | undefined, result: Record<string, any> | undefined) {
    if (typeof args?.url === 'string' && args.url.trim()) return this.trimExecutionText(args.url, EXECUTION_TEXT_LIMIT);
    if (typeof result?.resolvedUrl === 'string' && result.resolvedUrl.trim()) {
      return this.trimExecutionText(result.resolvedUrl, EXECUTION_TEXT_LIMIT);
    }
    if (typeof result?.url === 'string' && result.url.trim()) {
      return this.trimExecutionText(result.url, EXECUTION_TEXT_LIMIT);
    }
    if (typeof result?.policy?.domain === 'string' && result.policy.domain.trim()) {
      return this.trimExecutionText(result.policy.domain, EXECUTION_TEXT_LIMIT);
    }
    return '';
  }

  recordExecutionEvent(
    runMeta: RunMeta,
    payload: {
      toolName: string;
      callId: string;
      args?: Record<string, any>;
      result?: unknown;
      startedAt: number;
    },
  ) {
    const endedAt = Date.now();
    const resultRecord =
      payload.result && typeof payload.result === 'object' && !Array.isArray(payload.result)
        ? (payload.result as Record<string, any>)
        : undefined;

    const success = !(resultRecord?.success === false || resultRecord?.error);
    const errorCode =
      typeof resultRecord?.code === 'string'
        ? this.trimExecutionText(resultRecord.code, 80)
        : success
          ? ''
          : 'TOOL_ERROR';
    const errorMessage = success
      ? ''
      : this.trimExecutionText(String(resultRecord?.error || 'Tool execution failed'), EXECUTION_TEXT_LIMIT);

    const executionEvent: ExecutionEvent = {
      id: `evt_${endedAt}_${Math.random().toString(36).slice(2, 8)}`,
      runId: runMeta.runId,
      turnId: runMeta.turnId,
      sessionId: runMeta.sessionId,
      toolName: this.trimExecutionText(payload.toolName, 60),
      callId: this.trimExecutionText(payload.callId, 80),
      startedAt: payload.startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - payload.startedAt),
      tabId: this.resolveExecutionTabId(payload.args, resultRecord),
      url: this.resolveExecutionUrl(payload.args, resultRecord),
      success,
      errorCode,
      errorMessage,
      resultPreview: this.stringifyExecutionPreview(payload.result),
    };

    this.executionEvents.push(executionEvent);
    if (this.executionEvents.length > MAX_EXECUTION_EVENTS) {
      this.executionEvents = this.executionEvents.slice(-MAX_EXECUTION_EVENTS);
    }
    this.scheduleExecutionEventsFlush();
  }

  scheduleExecutionEventsFlush() {
    if (this.executionEventsFlushTimerId) {
      clearTimeout(this.executionEventsFlushTimerId);
    }
    // Fix 6: Increased debounce from 300ms to 2000ms to reduce storage writes during long tasks.
    this.executionEventsFlushTimerId = setTimeout(() => {
      this.executionEventsFlushTimerId = null;
      void this.flushExecutionEvents();
    }, 2000);
  }

  async flushExecutionEvents() {
    const payload = {
      [EXECUTION_EVENTS_KEY]: this.executionEvents.slice(-MAX_EXECUTION_EVENTS),
    };
    try {
      await chrome.storage.session.set(payload);
      return;
    } catch {
      // Fallback for environments where session storage is unavailable.
    }
    try {
      const minimalEvents = this.executionEvents.slice(-120).map((event) => ({
        ...event,
        errorMessage: this.trimExecutionText(event.errorMessage || '', 140),
        resultPreview: event.success ? '' : this.trimExecutionText(event.resultPreview || '', 160),
      }));
      await chrome.storage.local.set({
        [EXECUTION_EVENTS_KEY]: minimalEvents,
      });
    } catch (error) {
      console.warn('Failed to persist execution events:', error);
    }
  }

  getExecutionEventsSnapshot() {
    return this.executionEvents.slice(-MAX_EXECUTION_EVENTS);
  }

  addEvidenceEntry(
    section: EvidenceEntry['section'],
    source: string,
    text: unknown,
    options: {
      mode?: string;
      url?: string;
      title?: string;
    } = {},
  ) {
    const normalizedText = this.normalizeSummaryText(text || '');
    if (!normalizedText) return;
    const textPreview = this.truncateSummaryText(normalizedText, 320);
    const key = `${section}:${textPreview.toLowerCase()}`;
    if (this.evidenceLedger.some((entry) => entry.key === key)) return;
    this.evidenceLedger.push({
      key,
      section,
      source: this.normalizeSummaryText(source || 'tool'),
      mode: options.mode ? this.normalizeSummaryText(options.mode) : undefined,
      text: textPreview,
      url: options.url ? this.truncateSummaryText(String(options.url), 260) : undefined,
      title: options.title ? this.truncateSummaryText(String(options.title), 200) : undefined,
      timestamp: Date.now(),
    });
    if (this.evidenceLedger.length > 120) {
      this.evidenceLedger = this.evidenceLedger.slice(-120);
    }
  }

  captureEvidenceFromStructure(structure: Record<string, any> = {}, source = 'getContent') {
    const title = this.normalizeSummaryText(structure.title || '');
    const url = this.normalizeSummaryText(structure.url || '');
    const addListEvidence = (
      list: unknown[],
      section: EvidenceEntry['section'],
      extractor: (value: unknown) => string,
      maxItems = 8,
    ) => {
      if (!Array.isArray(list)) return;
      for (const item of list.slice(0, maxItems)) {
        const text = extractor(item);
        if (!text) continue;
        this.addEvidenceEntry(section, source, text, { mode: 'structure', url, title });
      }
    };

    addListEvidence(structure.sidebarItems, 'sidebar', (value) => {
      const item = value as Record<string, unknown>;
      return String(item?.text || item?.label || item?.href || '').trim();
    });
    addListEvidence(structure.cards, 'cards', (value) => {
      const item = value as Record<string, unknown>;
      return String(item?.title || item?.heading || item?.summary || '').trim();
    });
    addListEvidence(structure.tables, 'tables', (value) => {
      const item = value as Record<string, unknown>;
      const label = String(item?.caption || item?.id || 'table').trim();
      const rowCount = Number(item?.rows || 0);
      return rowCount > 0 ? `${label} (${rowCount} rows)` : label;
    });
    addListEvidence(structure.filters, 'filters', (value) => {
      const item = value as Record<string, unknown>;
      return String(item?.label || item?.placeholder || item?.name || '').trim();
    });
    addListEvidence(structure.tabs, 'tabs', (value) => {
      const item = value as Record<string, unknown>;
      return String(item?.text || item?.label || '').trim();
    });
    addListEvidence(structure.badges, 'badges', (value) => {
      const item = value as Record<string, unknown>;
      return String(item?.text || item?.label || '').trim();
    });
    addListEvidence(structure.kpis, 'kpis', (value) => {
      const item = value as Record<string, unknown>;
      const label = String(item?.label || '').trim();
      const metric = String(item?.value || '').trim();
      return [label, metric].filter(Boolean).join(': ');
    });
    addListEvidence(structure.headings, 'workspace', (value) => {
      const item = value as Record<string, unknown>;
      return String(item?.text || '').trim();
    });
    addListEvidence(structure.actions, 'actions', (value) => {
      const item = value as Record<string, unknown>;
      return String(item?.text || item?.id || '').trim();
    });
  }

  captureEvidenceFromToolResult(toolName: string, result: Record<string, any>, args: Record<string, any> = {}) {
    if (!result || typeof result !== 'object') return;
    if (result.success === false) return;

    if (toolName === 'getContent') {
      const mode = String(result.mode || args.mode || args.type || 'text');
      if (mode === 'structure' && result.structure && typeof result.structure === 'object') {
        this.captureEvidenceFromStructure(result.structure as Record<string, any>, 'getContent');
      }
      if (typeof result.content === 'string' && result.content.trim()) {
        const parsed = this.tryParseStructuredSnapshot(result.content);
        if (parsed) {
          this.captureEvidenceFromStructure(parsed, 'getContent');
        } else {
          this.addEvidenceEntry('content', 'getContent', result.content, {
            mode,
            url: typeof result?.structure?.url === 'string' ? result.structure.url : '',
            title: typeof result?.structure?.title === 'string' ? result.structure.title : '',
          });
        }
      }
      return;
    }

    if (toolName === 'screenshot') {
      if (typeof result.visionDescription === 'string' && result.visionDescription.trim()) {
        this.addEvidenceEntry('visual', 'screenshot', result.visionDescription, { mode: 'vision' });
      } else if (typeof result.visualContext === 'string' && result.visualContext.trim()) {
        this.addEvidenceEntry('visual', 'screenshot', result.visualContext, { mode: 'context' });
      }
      return;
    }

    if (typeof result.message === 'string' && result.message.trim()) {
      this.addEvidenceEntry('unknown', toolName, result.message, { mode: String(args?.mode || '') });
    }
  }

  normalizeSummaryText(value: unknown) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  tryParseStructuredSnapshot(value: unknown) {
    if (!value || typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object') return null;
      const hasStructureSignals =
        Array.isArray((parsed as Record<string, unknown>).headings) ||
        Array.isArray((parsed as Record<string, unknown>).actions) ||
        Array.isArray((parsed as Record<string, unknown>).sidebarItems) ||
        Array.isArray((parsed as Record<string, unknown>).cards) ||
        Array.isArray((parsed as Record<string, unknown>).tables) ||
        Array.isArray((parsed as Record<string, unknown>).filters) ||
        Array.isArray((parsed as Record<string, unknown>).tabs) ||
        Array.isArray((parsed as Record<string, unknown>).badges) ||
        Array.isArray((parsed as Record<string, unknown>).kpis) ||
        typeof (parsed as Record<string, unknown>).title === 'string';
      return hasStructureSignals ? (parsed as Record<string, any>) : null;
    } catch {
      return null;
    }
  }

  summarizeStructuredSnapshot(snapshot: Record<string, any> = {}) {
    const title = this.normalizeSummaryText(snapshot.title || '');
    const url = this.normalizeSummaryText(snapshot.url || '');
    const headings = Array.isArray(snapshot.headings) ? snapshot.headings : [];
    const actions = Array.isArray(snapshot.actions) ? snapshot.actions : [];
    const sidebarItems = Array.isArray(snapshot.sidebarItems) ? snapshot.sidebarItems : [];
    const cards = Array.isArray(snapshot.cards) ? snapshot.cards : [];
    const kpis = Array.isArray(snapshot.kpis) ? snapshot.kpis : [];

    const snippets: string[] = [];
    if (title) {
      snippets.push(`Pagina analisada: ${title}`);
    }

    if (url) {
      try {
        const urlObj = new URL(url);
        snippets.push(`Fonte: ${urlObj.hostname}`);
      } catch {
        // Ignore malformed URLs in summary text.
      }
    }

    const firstHeading = headings
      .map((item: Record<string, unknown>) => this.normalizeSummaryText(item?.text || ''))
      .find(Boolean);
    if (firstHeading) {
      snippets.push(`Destaque: ${firstHeading}`);
    }

    if (sidebarItems.length > 0) {
      const firstSidebar = sidebarItems
        .map((item: Record<string, unknown>) => this.normalizeSummaryText(item?.text || item?.label || ''))
        .filter(Boolean)
        .slice(0, 4);
      if (firstSidebar.length > 0) {
        snippets.push(`Sidebar: ${firstSidebar.join(', ')}`);
      }
    }

    if (cards.length > 0) {
      const firstCards = cards
        .map((item: Record<string, unknown>) => this.normalizeSummaryText(item?.title || item?.heading || ''))
        .filter(Boolean)
        .slice(0, 4);
      if (firstCards.length > 0) {
        snippets.push(`Cards: ${firstCards.join(', ')}`);
      }
    }

    if (kpis.length > 0) {
      const firstKpis = kpis
        .map((item: Record<string, unknown>) =>
          this.normalizeSummaryText(
            [item?.label || '', item?.value || '']
              .map((part) => String(part || '').trim())
              .filter(Boolean)
              .join(': '),
          ),
        )
        .filter(Boolean)
        .slice(0, 3);
      if (firstKpis.length > 0) {
        snippets.push(`KPIs: ${firstKpis.join(', ')}`);
      }
    }

    const actionLabels = actions
      .map((item: Record<string, unknown>) => this.normalizeSummaryText(item?.text || item?.label || ''))
      .filter((text: string) => Boolean(text) && text.length > 2)
      .slice(0, 3);
    if (actionLabels.length > 0) {
      snippets.push(`Opcoes visiveis: ${actionLabels.join(', ')}`);
    }

    return this.truncateSummaryText(snippets.join('. '), 700);
  }

  truncateSummaryText(value: string, limit = 900) {
    const normalized = this.normalizeSummaryText(value);
    if (normalized.length <= limit) return normalized;
    return `${normalized.slice(0, limit)}...`;
  }

  isGenericCompletionText(value: unknown) {
    const normalized = this.normalizeSummaryText(value).toLowerCase();
    return normalized === GENERIC_TOOL_COMPLETION_TEXT.toLowerCase();
  }

  extractToolResultOutput(toolResult: Record<string, any>) {
    if (toolResult && typeof toolResult === 'object') {
      if (toolResult.output && typeof toolResult.output === 'object') {
        return toolResult.output as Record<string, any>;
      }
      if (toolResult.result && typeof toolResult.result === 'object') {
        return toolResult.result as Record<string, any>;
      }
      return toolResult;
    }
    return {};
  }

  buildStructureFallback(structure: Record<string, any> = {}) {
    const structuredSummary = this.summarizeStructuredSnapshot(structure);
    if (structuredSummary) return structuredSummary;

    const headings = Array.isArray(structure.headings) ? structure.headings : [];
    const actions = Array.isArray(structure.actions) ? structure.actions : [];
    const snippets: string[] = [];

    if (headings.length > 0) {
      const firstHeadings = headings
        .map((item: Record<string, unknown>) => this.normalizeSummaryText(item?.text || ''))
        .filter(Boolean)
        .slice(0, 4);
      if (firstHeadings.length > 0) {
        snippets.push(`Titulos detectados: ${firstHeadings.join(', ')}`);
      }
    }

    if (actions.length > 0) {
      const actionLabels = actions
        .map((item: Record<string, unknown>) => this.normalizeSummaryText(item?.text || item?.label || ''))
        .filter(Boolean)
        .slice(0, 4);
      if (actionLabels.length > 0) {
        snippets.push(`Acoes visiveis: ${actionLabels.join(', ')}`);
      }
    }

    return snippets.join('. ');
  }

  buildToolResultFallback(toolResults: Array<Record<string, any>> = []) {
    if (!Array.isArray(toolResults) || toolResults.length === 0) return '';

    const errors = new Set<string>();
    const contentCandidates: string[] = [];

    for (const item of toolResults) {
      const toolName = String(item?.toolName || item?.name || '');
      const output = this.extractToolResultOutput(item);
      const success = !(output?.success === false || output?.error);

      if (!success && toolName) {
        errors.add(toolName);
      }

      if (toolName === 'getContent') {
        if (output?.mode === 'structure' && output?.structure && typeof output.structure === 'object') {
          const structureText = this.buildStructureFallback(output.structure as Record<string, any>);
          if (structureText) {
            contentCandidates.push(structureText);
          }
        }
        if (typeof output?.content === 'string' && output.content.trim()) {
          const parsedSnapshot = this.tryParseStructuredSnapshot(output.content);
          if (parsedSnapshot) {
            const structureText = this.buildStructureFallback(parsedSnapshot);
            if (structureText) {
              contentCandidates.push(structureText);
            }
          } else {
            contentCandidates.push(output.content);
          }
        }
      }

      if (typeof output?.visualContext === 'string' && output.visualContext.trim()) {
        contentCandidates.push(output.visualContext);
      }

      if (toolName === 'screenshot' && typeof output?.visionDescription === 'string' && output.visionDescription.trim()) {
        contentCandidates.push(output.visionDescription);
      }
    }

    const primary = contentCandidates.length > 0 ? this.truncateSummaryText(contentCandidates[contentCandidates.length - 1], 700) : '';
    const errorText = errors.size > 0 ? ` Algumas acoes falharam (${Array.from(errors).join(', ')}).` : '';

    if (primary) {
      const prefix = errors.size > 0 ? 'Coleta parcial concluida' : 'Resumo automatico com base nos dados coletados';
      return this.truncateSummaryText(`${prefix}: ${primary}.${errorText}`.trim(), 900);
    }

    return this.truncateSummaryText(
      `Consegui executar as ferramentas e coletar dados da pagina.${errorText} Verifique os detalhes tecnicos para confirmar os itens extraidos.`,
      900,
    );
  }

  collectStructuredCatalog(toolResults: Array<Record<string, any>> = []) {
    const catalog = {
      title: '',
      url: '',
      sidebar: new Set<string>(),
      cards: new Set<string>(),
      actions: new Set<string>(),
      filters: new Set<string>(),
      tabs: new Set<string>(),
      tables: new Set<string>(),
      badges: new Set<string>(),
      kpis: new Set<string>(),
      headings: new Set<string>(),
      visuals: new Set<string>(),
      evidenceSnippets: new Set<string>(),
    };
    const add = (target: Set<string>, value: unknown, limit = 140) => {
      const normalized = this.truncateSummaryText(String(value || ''), limit);
      if (!normalized) return;
      target.add(normalized);
    };
    const ingestStructure = (structure: Record<string, any> = {}) => {
      if (!catalog.title) catalog.title = this.normalizeSummaryText(structure.title || '');
      if (!catalog.url) catalog.url = this.normalizeSummaryText(structure.url || '');
      (Array.isArray(structure.sidebarItems) ? structure.sidebarItems : []).forEach((item: Record<string, unknown>) =>
        add(catalog.sidebar, item?.text || item?.label || item?.href),
      );
      (Array.isArray(structure.cards) ? structure.cards : []).forEach((item: Record<string, unknown>) =>
        add(catalog.cards, item?.title || item?.heading || item?.summary),
      );
      (Array.isArray(structure.actions) ? structure.actions : []).forEach((item: Record<string, unknown>) =>
        add(catalog.actions, item?.text || item?.id),
      );
      (Array.isArray(structure.filters) ? structure.filters : []).forEach((item: Record<string, unknown>) =>
        add(catalog.filters, item?.label || item?.placeholder || item?.name),
      );
      (Array.isArray(structure.tabs) ? structure.tabs : []).forEach((item: Record<string, unknown>) =>
        add(catalog.tabs, item?.text || item?.label),
      );
      (Array.isArray(structure.tables) ? structure.tables : []).forEach((item: Record<string, unknown>) => {
        const caption = String(item?.caption || item?.id || 'table').trim();
        const rows = Number(item?.rows || 0);
        add(catalog.tables, rows > 0 ? `${caption} (${rows} rows)` : caption);
      });
      (Array.isArray(structure.badges) ? structure.badges : []).forEach((item: Record<string, unknown>) =>
        add(catalog.badges, item?.text || item?.label),
      );
      (Array.isArray(structure.kpis) ? structure.kpis : []).forEach((item: Record<string, unknown>) =>
        add(
          catalog.kpis,
          [String(item?.label || '').trim(), String(item?.value || '').trim()].filter(Boolean).join(': '),
        ),
      );
      (Array.isArray(structure.headings) ? structure.headings : []).forEach((item: Record<string, unknown>) =>
        add(catalog.headings, item?.text),
      );
    };

    for (const toolResult of toolResults) {
      const toolName = String(toolResult?.toolName || toolResult?.name || '');
      const output = this.extractToolResultOutput(toolResult);
      if (!output || typeof output !== 'object') continue;
      if (toolName === 'getContent') {
        if (output.mode === 'structure' && output.structure && typeof output.structure === 'object') {
          ingestStructure(output.structure as Record<string, any>);
        } else if (typeof output.content === 'string') {
          const parsed = this.tryParseStructuredSnapshot(output.content);
          if (parsed) ingestStructure(parsed);
          else add(catalog.evidenceSnippets, output.content, 220);
        }
      }
      if (typeof output.visualContext === 'string') add(catalog.visuals, output.visualContext, 180);
      if (typeof output.visionDescription === 'string') add(catalog.visuals, output.visionDescription, 180);
    }

    for (const evidence of this.evidenceLedger.slice(-30)) {
      add(catalog.evidenceSnippets, evidence.text, 200);
      if (evidence.section === 'sidebar') add(catalog.sidebar, evidence.text);
      if (evidence.section === 'cards') add(catalog.cards, evidence.text);
      if (evidence.section === 'actions') add(catalog.actions, evidence.text);
      if (evidence.section === 'filters') add(catalog.filters, evidence.text);
      if (evidence.section === 'tabs') add(catalog.tabs, evidence.text);
      if (evidence.section === 'tables') add(catalog.tables, evidence.text);
      if (evidence.section === 'badges') add(catalog.badges, evidence.text);
      if (evidence.section === 'kpis') add(catalog.kpis, evidence.text);
      if (evidence.section === 'workspace') add(catalog.headings, evidence.text);
      if (evidence.section === 'visual') add(catalog.visuals, evidence.text);
    }

    return catalog;
  }

  buildComprehensiveFallbackReport(toolResults: Array<Record<string, any>> = [], minimumSections = 5) {
    const catalog = this.collectStructuredCatalog(toolResults);
    const activePlan = this.currentPlan as RunPlan | null;
    const pendingSteps = activePlan ? activePlan.steps.filter((s) => s.status !== 'done') : [];
    const errors = toolResults
      .map((item) => {
        const tool = String(item?.toolName || item?.name || '');
        const output = this.extractToolResultOutput(item);
        if (output?.success === false || output?.error) {
          return tool || 'tool';
        }
        return '';
      })
      .filter(Boolean);

    const toList = (set: Set<string>, max = 8) => Array.from(set).slice(0, max);
    const scopeLines: string[] = [];
    if (catalog.title) scopeLines.push(`- Pagina: ${catalog.title}`);
    if (catalog.url) scopeLines.push(`- URL: ${catalog.url}`);
    if (!scopeLines.length) scopeLines.push('- Pagina detectada, mas sem metadados completos de titulo/URL.');

    const sections: Array<{ title: string; lines: string[] }> = [
      {
        title: 'Escopo Analisado',
        lines: scopeLines,
      },
      {
        title: 'Sidebar e Navegacao',
        lines: toList(catalog.sidebar).map((item) => `- ${item}`),
      },
      {
        title: 'Area de Trabalho e Cards',
        lines: [...toList(catalog.cards, 10), ...toList(catalog.kpis, 6)].map((item) => `- ${item}`),
      },
      {
        title: 'Funcoes e Modulos Detectados',
        lines: [
          ...toList(catalog.actions, 10),
          ...toList(catalog.tabs, 6),
          ...toList(catalog.filters, 6),
          ...toList(catalog.tables, 6),
          ...toList(catalog.badges, 6),
        ].map((item) => `- ${item}`),
      },
      {
        title: 'Evidencias Coletadas',
        lines: [...toList(catalog.headings, 8), ...toList(catalog.visuals, 5), ...toList(catalog.evidenceSnippets, 8)]
          .map((item) => `- ${item}`),
      },
      {
        title: 'Pendencias e Riscos',
        lines: [
          ...(pendingSteps.length
            ? pendingSteps.slice(0, 6).map((step) => `- Etapa pendente: ${step.title}`)
            : ['- Plano concluido sem etapas pendentes.']),
          ...(errors.length
            ? [`- Ferramentas com falha: ${Array.from(new Set(errors)).join(', ')}`]
            : ['- Nenhuma falha de ferramenta registrada no ultimo passe.']),
        ],
      },
    ];

    for (const section of sections) {
      if (section.lines.length === 0) {
        section.lines.push('- Sem itens detectados nesta secao com as evidencias atuais.');
      }
    }

    const selectedSections = sections.slice(0, Math.min(sections.length, Math.max(3, minimumSections + 1)));
    return selectedSections.map((section) => `## ${section.title}\n${section.lines.join('\n')}`).join('\n\n').trim();
  }

  isLowDetailFinal(text: string, minimumReportSections = 5) {
    const normalized = this.normalizeSummaryText(text);
    if (!normalized) return true;
    const headingMatches = text.match(/^#{1,3}\s+/gm) || [];
    if (headingMatches.length >= Math.max(3, minimumReportSections - 1)) return false;
    return normalized.length < Math.max(420, minimumReportSections * 120);
  }

  buildQualityReport({
    qualityMode,
    minimumReportSections,
    plan,
    toolResults,
    finalText,
  }: {
    qualityMode: QualityMode;
    minimumReportSections: number;
    plan: RunPlan | null;
    toolResults: Array<Record<string, any>>;
    finalText: string;
  }) {
    const totalSteps = plan?.steps?.length || 0;
    const completedSteps = plan?.steps?.filter((step) => step.status === 'done').length || 0;
    const pendingSteps = plan?.steps?.filter((step) => step.status !== 'done').map((step) => step.title) || [];
    const coverageSections = [
      'sidebar',
      'workspace',
      'cards',
      'tables',
      'actions',
      'filters',
      'tabs',
      'badges',
      'kpis',
      'visual',
    ] as const;
    const coverageMap = Object.fromEntries(
      coverageSections.map((section) => [
        section,
        this.evidenceLedger.filter((item) => item.section === section).length,
      ]),
    );
    const sectionsCovered = coverageSections.filter((section) => coverageMap[section] > 0);
    const finalTextLength = this.normalizeSummaryText(finalText).length;
    const planCompletionRate = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;
    const qualityScore = Math.max(
      0,
      Math.min(
        100,
        Math.round(
          planCompletionRate * 0.55 +
            Math.min(100, (sectionsCovered.length / Math.max(1, minimumReportSections)) * 100) * 0.3 +
            Math.min(100, finalTextLength / 12) * 0.15,
        ),
      ),
    );
    const hasEnoughSections = sectionsCovered.length >= Math.max(3, minimumReportSections - 1);
    const status = completedSteps === totalSteps && totalSteps > 0 && hasEnoughSections ? 'passed' : 'needs_review';

    return {
      status,
      qualityMode,
      qualityScore,
      finalTextLength,
      minimumReportSections,
      plan: {
        totalSteps,
        completedSteps,
        pendingSteps,
        completionRate: planCompletionRate,
      },
      evidence: {
        totalItems: this.evidenceLedger.length,
        sectionsCovered,
        sectionCounts: coverageMap,
      },
      tools: {
        totalCalls: Array.isArray(toolResults) ? toolResults.length : 0,
      },
    };
  }

  attachPlanToResult(result: unknown, toolName: string) {
    if (!this.currentPlan || toolName === 'set_plan') return result;
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      return { ...(result as Record<string, unknown>), plan: this.currentPlan };
    }
    return { result, plan: this.currentPlan };
  }

  extractXmlToolCalls(text: string): Array<{ name: string; args: Record<string, unknown>; raw: string }> {
    if (!text || typeof text !== 'string') return [];
    const results: Array<{ name: string; args: Record<string, unknown>; raw: string }> = [];
    const blocks: string[] = [];

    const blockRegex = /<\s*(?:tool|function)_call[^>]*>[\s\S]*?<\s*\/\s*(?:tool|function)_call\s*>/gi;
    let match: RegExpExecArray | null;
    while ((match = blockRegex.exec(text))) {
      blocks.push(match[0]);
    }

    const inlineRegex = /([A-Za-z0-9_]+)\s*<\s*argkey\s*>[\s\S]*?<\s*\/\s*tool_call\s*>/gi;
    while ((match = inlineRegex.exec(text))) {
      blocks.push(match[0]);
    }

    if (!blocks.length && /<\s*argkey\s*>/i.test(text)) {
      blocks.push(text);
    }

    for (const block of blocks) {
      const name = this.extractXmlToolName(block);
      if (!name) continue;
      const args = this.extractXmlArgs(block);
      results.push({ name, args, raw: block });
    }

    return results;
  }

  extractXmlToolName(block: string): string {
    const nameMatch =
      block.match(/<\s*(?:tool|function)_name\s*>([^<]+)<\s*\/\s*(?:tool|function)_name\s*>/i) ||
      block.match(/<\s*name\s*>([^<]+)<\s*\/\s*name\s*>/i) ||
      block.match(/<\s*tool\s*>([^<]+)<\s*\/\s*tool\s*>/i) ||
      block.match(/<\s*function\s*>([^<]+)<\s*\/\s*function\s*>/i) ||
      block.match(/([A-Za-z0-9_]+)\s*<\s*argkey\s*>/i);

    if (!nameMatch) return '';
    const name = nameMatch[1] ? String(nameMatch[1]) : '';
    return name.trim();
  }

  extractXmlArgs(block: string): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    const pairRegex = /<\s*argkey\s*>([\s\S]*?)<\s*\/\s*argkey\s*>\s*<\s*argvalue\s*>([\s\S]*?)<\s*\/\s*argvalue\s*>/gi;
    let match: RegExpExecArray | null;
    while ((match = pairRegex.exec(block))) {
      const key = String(match[1] || '').trim();
      const value = this.coerceXmlArgValue(String(match[2] || '').trim());
      if (key) args[key] = value;
    }

    const namedRegex = /<\s*arg\s+name\s*=\s*['\"]?([^'\">]+)['\"]?\s*>([\s\S]*?)<\s*\/\s*arg\s*>/gi;
    while ((match = namedRegex.exec(block))) {
      const key = String(match[1] || '').trim();
      const value = this.coerceXmlArgValue(String(match[2] || '').trim());
      if (key) args[key] = value;
    }

    return args;
  }

  coerceXmlArgValue(value: string): unknown {
    if (!value) return '';
    const trimmed = value.trim();
    if (!trimmed) return '';
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    if (!Number.isNaN(Number(trimmed)) && trimmed.length < 18) return Number(trimmed);
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }

  stripXmlToolCalls(text: string): string {
    if (!text || typeof text !== 'string') return text;
    let cleaned = text;
    cleaned = cleaned.replace(/<\s*(?:tool|function)_call[^>]*>[\s\S]*?<\s*\/\s*(?:tool|function)_call\s*>/gi, '');
    cleaned = cleaned.replace(/[A-Za-z0-9_]+\s*<\s*argkey\s*>[\s\S]*?<\s*\/\s*tool_call\s*>/gi, '');
    cleaned = cleaned.replace(/<\s*argkey\s*>[\s\S]*?<\s*\/\s*argvalue\s*>/gi, '');
    return cleaned.trim();
  }

  parsePlanSteps(text: string) {
    if (!text) return [];
    return text
      .split('\n')
      .map((line) =>
        line
          .replace(/^\s*[-*]\s*/, '')
          .replace(/^\s*\d+[.)]\s*/, '')
          .trim(),
      )
      .filter(Boolean);
  }

  buildPlanFromArgs(args: Record<string, any>) {
    const stepInput = Array.isArray(args?.steps) ? args.steps : null;
    const planText = typeof args?.plan === 'string' ? args.plan : '';
    const parsedSteps = planText ? this.parsePlanSteps(planText) : [];
    const combined = stepInput && stepInput.length ? stepInput : parsedSteps;
    if (!combined || combined.length === 0) return null;
    return buildRunPlan(combined, {
      existingPlan: this.currentPlan,
      maxSteps: 12,
    });
  }

  getToolPermissionCategory(toolName) {
    const mapping = {
      navigate: 'navigate',
      openTab: 'navigate',
      click: 'interact',
      type: 'interact',
      pressKey: 'interact',
      scroll: 'interact',
      getContent: 'read',
      screenshot: 'screenshots',
      getTabs: 'tabs',
      closeTab: 'tabs',
      switchTab: 'tabs',
      groupTabs: 'tabs',
      focusTab: 'tabs',
      describeSessionTabs: 'tabs',
    };
    return mapping[toolName] || null;
  }

  parseAllowedDomains(value = '') {
    return String(value)
      .split(/[\n,]/)
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);
  }

  isUrlAllowed(url, allowlist) {
    if (!allowlist.length) return true;
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      return allowlist.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
    } catch (error) {
      return false;
    }
  }

  async resolveToolUrl(args) {
    if (args?.url) return args.url;
    const tabId = args?.tabId || this.browserTools.getCurrentSessionTabId();
    try {
      if (tabId) {
        const tab = await chrome.tabs.get(tabId);
        return tab?.url || '';
      }
    } catch (error) {
      console.warn('Failed to resolve tab URL for permissions:', error);
    }
    const [active] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    return active?.url || '';
  }

  async checkToolPermission(toolName, args, settingsOverride: Record<string, any> | null = null) {
    const settings = settingsOverride || this.currentSettings;
    if (!settings) return { allowed: true };
    const permissions = settings.toolPermissions || {};
    const category = this.getToolPermissionCategory(toolName);
    if (category && permissions[category] === false) {
      return {
        allowed: false,
        reason: `Permission blocked: ${category}`,
        policy: {
          type: 'permission',
          category,
          reason: `Permission blocked: ${category}`,
        },
      };
    }

    if (category === 'tabs') return { allowed: true };

    const allowlist = this.parseAllowedDomains(settings.allowedDomains || '');
    if (!allowlist.length) return { allowed: true };

    const targetUrl = await this.resolveToolUrl(args);
    if (!this.isUrlAllowed(targetUrl, allowlist)) {
      return {
        allowed: false,
        reason: 'Blocked by allowed domains list.',
        policy: {
          type: 'allowlist',
          domain: targetUrl,
          reason: 'Blocked by allowed domains list.',
        },
      };
    }

    return { allowed: true };
  }

  sendRuntime(runMeta: RunMeta, payload: Record<string, unknown>) {
    this.sendToSidePanel({
      schemaVersion: RUNTIME_MESSAGE_SCHEMA_VERSION,
      runId: runMeta.runId,
      turnId: runMeta.turnId,
      sessionId: runMeta.sessionId,
      timestamp: Date.now(),
      ...payload,
    });
  }

  sendRunErrorFallback(sessionId: string, message: string) {
    const runMeta: RunMeta = {
      runId: `fallback-run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      turnId: `fallback-turn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      sessionId: String(sessionId || `session-${Date.now()}`),
    };
    this.sendRuntime(runMeta, {
      type: 'run_error',
      message: String(message || 'Unexpected runtime error'),
    });
  }

  sendToSidePanel(message) {
    chrome.runtime.sendMessage(message).catch((err) => {
      console.log('Side panel not open:', err);
    });
  }

  enhanceSystemPrompt(basePrompt: string, context) {
    const tabsSection =
      Array.isArray(context.availableTabs) && context.availableTabs.length
        ? `Tabs selected (${context.availableTabs.length}). Use focusTab or switchTab before acting:\n${context.availableTabs
          .map((tab) => `  - [${tab.id}] ${tab.title || 'Untitled'} - ${tab.url}`)
          .join('\n')}`
        : 'No additional tabs selected; actions target the current tab.';
    const teamProfiles = Array.isArray(context.teamProfiles) ? context.teamProfiles : [];
    const teamSection = teamProfiles.length
      ? `Team profiles available for sub-agents:\n${teamProfiles
        .map((profile) => `  - ${profile.name}: ${profile.provider || 'provider'} � ${profile.model || 'model'}`)
        .join('\n')}\nUse spawn_subagent to delegate parallel browser work.`
      : '';
    const orchestratorSection = context.orchestratorEnabled ? 'Orchestrator mode is enabled.' : '';

    // Build state section with enforcement - tracks exactly what model needs to do next
    let stateSection = '';
    let requiredNextCall = '';

    if (!this.currentPlan || this.currentPlan.steps.length === 0) {
      // No plan - MUST create one first
      requiredNextCall = 'set_plan({ steps: [{ title: "..." }, ...] })';
      stateSection = `
<execution_state>
⛔ NO ACTIVE PLAN

REQUIRED NEXT CALL: ${requiredNextCall}

You CANNOT call navigate, click, type, scroll, or pressKey until you call set_plan.
Create 3-6 specific action steps, then proceed.
</execution_state>`;
    } else {
      const steps = this.currentPlan.steps;
      const doneCount = steps.filter((s) => s.status === 'done').length;
      const currentIndex = steps.findIndex((s) => s.status !== 'done');
      const planLines = steps.map((step, i) => {
        const marker = step.status === 'done' ? '[✓]' : i === currentIndex ? '[→]' : '[ ]';
        return `${marker} step_index=${i}: ${step.title}`;
      });

      if (currentIndex === -1) {
        // All steps complete
        requiredNextCall = 'Provide final summary with findings';
        stateSection = `
<execution_state>
✅ ALL STEPS COMPLETE (${doneCount}/${steps.length})
${planLines.join('\n')}

REQUIRED: Provide your final summary now with evidence from getContent.
</execution_state>`;
      } else if (this.awaitingVerification) {
        // Browser action taken but getContent not called yet
        requiredNextCall = 'getContent({ mode: "text" })';
        stateSection = `
<execution_state>
PROGRESS: ${doneCount}/${steps.length} steps complete
${planLines.join('\n')}

CURRENT STEP: "${steps[currentIndex].title}"
LAST ACTION: ${this.lastBrowserAction || 'unknown'}
VERIFICATION: ⚠️ PENDING - getContent NOT called

⛔ REQUIRED NEXT CALL: ${requiredNextCall}

You MUST call getContent to verify your action before proceeding.
Do NOT call update_plan or any other tool until you call getContent.
</execution_state>`;
      } else {
        // Ready to mark step done or execute next action
        requiredNextCall = `update_plan({ step_index: ${currentIndex}, status: "done" })`;
        stateSection = `
<execution_state>
PROGRESS: ${doneCount}/${steps.length} steps complete
${planLines.join('\n')}

CURRENT STEP: "${steps[currentIndex].title}"
VERIFICATION: ✓ getContent was called

⚠️ REQUIRED NEXT CALL: ${requiredNextCall}

After marking step ${currentIndex} done, proceed to step ${currentIndex + 1}.
</execution_state>`;
      }
    }

    return `${basePrompt}
${stateSection}

<browser_context>
URL: ${context.currentUrl}
Title: ${context.currentTitle}
Tab: ${context.tabId}
${tabsSection}
</browser_context>
${orchestratorSection ? `\n${orchestratorSection}` : ''}
${teamSection ? `\n${teamSection}` : ''}
${this.buildFailureRecoverySection()}

<visual_recovery_policy>
- If a browser action fails or page state is ambiguous, call screenshot() before giving up.
- If vision analysis is unavailable, continue with getContent({ mode: "structure" }) and retry.
- Do not finalize while pending plan steps remain after a recoverable failure.
</visual_recovery_policy>

<checkpoint>
Before your next tool call, verify:
□ Required next call shown above: ${requiredNextCall}
□ If awaiting verification, call getContent first
□ If step complete, call update_plan before next step
</checkpoint>`;
  }

  buildFailureRecoverySection(): string {
    if (!this.consecutiveFailures || this.consecutiveFailures === 0) return '';
    const failedList = (this.failedTools || [])
      .slice(-3)
      .map((f) => `  - ${f.tool}(${f.selector || ''}): ${f.error}`)
      .join('\n');
    return `
<failure_recovery>
⚠️ ${this.consecutiveFailures} consecutive action(s) FAILED:
${failedList}

DO NOT give up. You MUST try alternative approaches:
1. Call getContent({ mode: "structure" }) to re-analyze available elements
2. Try a different CSS selector or text-based selector
3. Try scrolling to reveal hidden elements
4. Capture screenshot() to gather visual context before the next retry
5. If the page is dynamic (React/SPA), wait and retry

You are PROHIBITED from generating a final response until you either:
- Successfully complete the action with an alternative approach, OR
- Have attempted at least 3 different selectors/strategies with evidence
</failure_recovery>`;
  }

  resolveProfile(settings: Record<string, any>) {
    const normalizedProvider = String(settings.provider || 'openai').toLowerCase();
    const qualityMode = this.normalizeQualityMode(settings.qualityMode);
    return {
      provider: normalizedProvider,
      apiKey: settings.apiKey || '',
      model: settings.model || '',
      customEndpoint: normalizeEndpointForProvider(normalizedProvider, settings.customEndpoint),
      systemPrompt: settings.systemPrompt || '',
      sendScreenshotsAsImages: settings.sendScreenshotsAsImages !== false,
      screenshotQuality: settings.screenshotQuality || 'high',
      showThinking: settings.showThinking !== false,
      streamResponses: settings.streamResponses !== false,
      temperature: fixedTemperatureForQuality(qualityMode),
      maxTokens: settings.maxTokens,
      timeout: settings.timeout,
      contextLimit: settings.contextLimit,
      enableScreenshots: settings.enableScreenshots !== false,
      autoRecoveryMode: settings.autoRecoveryMode,
      screenshotOnFailure: settings.screenshotOnFailure !== false,
      screenshotRetention: settings.screenshotRetention,
      qualityMode,
      autoTuneSafety: settings.autoTuneSafety !== false,
      minimumReportSections: settings.minimumReportSections,
    };
  }

  resolveTeamProfiles(_settings: Record<string, any>) {
    return [];
  }

  getToolsForSession(
    settings: Record<string, any>,
    includeOrchestrator = false,
    teamProfiles: Array<{ name: string }> = [],
    lockedTabId: number | null = null,
  ) {
    let tools = this.browserTools.getToolDefinitions();
    if (typeof lockedTabId === 'number') {
      tools = tools.filter((tool) => LOCKED_TAB_ALLOWED_BROWSER_TOOLS.has(tool.name));
    }
    if (settings && settings.enableScreenshots === false) {
      tools = tools.filter((tool) => tool.name !== 'screenshot');
    }
    tools = tools.concat([
      {
        name: 'set_plan',
        description:
          'Set a checklist of concrete action steps to complete the task. Each step should be a single specific action (e.g., "Navigate to example.com", "Click the login button", "Extract product prices"). Avoid headers, phases, or abstract descriptions. Keep to 3-6 actionable steps. Mark steps done via update_plan as you complete them.',
        input_schema: {
          type: 'object',
          properties: {
            steps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: {
                    type: 'string',
                    description: 'Short action description (e.g., "Search for user profile", "Extract contact info")',
                  },
                  status: {
                    type: 'string',
                    enum: ['pending', 'done'],
                    description: 'Step status - pending or done',
                  },
                },
                required: ['title'],
              },
              description: 'Ordered list of 3-6 concrete action steps. Each step = one tool call or logical action.',
            },
          },
          required: ['steps'],
        },
      },
      {
        name: 'update_plan',
        description: 'Mark a plan step as done after completing it. Call this after each step you finish.',
        input_schema: {
          type: 'object',
          properties: {
            step_index: {
              type: 'number',
              description: 'Zero-based index of the step to mark done (0 = first step)',
            },
            status: {
              type: 'string',
              enum: ['done', 'pending', 'blocked'],
              description: 'New status for the step (defaults to "done")',
            },
          },
          required: ['step_index'],
        },
      },
    ]);

    if (includeOrchestrator) {
      tools = tools.concat([
        {
          name: 'spawn_subagent',
          description: 'Start a focused sub-agent with its own goal and prompt.',
          input_schema: {
            type: 'object',
            properties: {
              prompt: {
                type: 'string',
                description: 'System prompt for the sub-agent',
              },
              tasks: {
                type: 'array',
                items: { type: 'string' },
                description: 'Task list for the sub-agent',
              },
              goal: {
                type: 'string',
                description: 'Single goal string if tasks not provided',
              },
            },
          },
        },
        {
          name: 'subagent_complete',
          description: 'Sub-agent calls this when finished to return a summary payload.',
          input_schema: {
            type: 'object',
            properties: {
              summary: { type: 'string' },
              data: { type: 'object' },
            },
            required: ['summary'],
          },
        },
      ]);
    }
    return tools;
  }

  async handleSpawnSubagent(runMeta: RunMeta, args) {
    if (this.subAgentCount >= 10) {
      return {
        success: false,
        error: 'Sub-agent limit reached for this session (max 10).',
      };
    }
    this.subAgentCount += 1;
    const subagentId = `subagent-${Date.now()}-${this.subAgentCount}`;
    const profileSettings = this.resolveProfile(this.currentSettings || {});

    const subagentName = args.name || `Sub-Agent ${this.subAgentCount}`;
    this.sendRuntime(runMeta, {
      type: 'subagent_start',
      id: subagentId,
      name: subagentName,
      tasks: args.tasks || [args.goal || args.task || 'Task'],
    });

    const subAgentSystemPrompt = `${args.prompt || 'You are a focused sub-agent working under an orchestrator. Be concise and tool-driven.'}
Always cite evidence from tools. Finish by calling subagent_complete with a short summary and any structured findings.`;

    const lockedTabId = this.activeRunLockedTabId;
    const tools = this.getToolsForSession(this.currentSettings || {}, false, [], lockedTabId);
    const toolSet = buildToolSet(tools, async (toolName, toolArgs, options) =>
      this.executeToolByName(
        toolName,
        toolArgs,
        {
          runMeta,
          settings: this.currentSettings || {},
          visionProfile: null,
          lockedTabId,
        },
        options.toolCallId,
      ),
    );

    const taskLines = Array.isArray(args.tasks)
      ? args.tasks.map((t, idx) => `${idx + 1}. ${t}`).join('\n')
      : args.goal || args.task || args.prompt || '';

    const subHistory: Message[] = [
      {
        role: 'user',
        content: `Task group:\n${taskLines || 'Follow the provided prompt and complete the goal.'}`,
      },
    ];

    const subModel = resolveLanguageModel(profileSettings);
    const subagentTimeoutMs = resolveTimeoutMs(profileSettings.timeout ?? this.currentSettings?.timeout);
    const subagentAbort = new AbortController();
    let subagentTimedOut = false;
    const subagentTimer = setTimeout(() => {
      subagentTimedOut = true;
      subagentAbort.abort();
    }, subagentTimeoutMs);

    let summary = 'Sub-agent finished without a final summary.';
    let success = true;
    try {
      const result = streamText({
        model: subModel,
        system: subAgentSystemPrompt,
        messages: toModelMessages(subHistory),
        tools: toolSet,
        temperature: profileSettings.temperature ?? 0.3,
        maxOutputTokens: profileSettings.maxTokens ?? 1024,
        stopWhen: stepCountIs(24),
        abortSignal: subagentAbort.signal,
      });
      summary = (await result.text) || summary;
    } catch (error) {
      if (subagentTimedOut || isAbortError(error)) {
        summary = `Sub-agent timed out after ${subagentTimeoutMs}ms.`;
      } else {
        summary = `Sub-agent failed: ${error?.message || String(error)}`;
      }
      success = false;
    } finally {
      clearTimeout(subagentTimer);
    }

    this.sendRuntime(runMeta, {
      type: 'subagent_complete',
      id: subagentId,
      success,
      summary,
    });

    return {
      success,
      source: 'subagent',
      id: subagentId,
      name: subagentName,
      summary,
      tasks: taskLines,
    };
  }
}

new BackgroundService();
