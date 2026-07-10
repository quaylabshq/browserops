// Curated public API for @browserops/shared.
// Add to this file (don't reintroduce `export *`) when a new symbol needs
// to cross the package boundary — keeping the surface explicit makes
// refactors visible at PR review.

// Wire protocol envelopes + guards.
export {
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  type Hello,
  type HelloAck,
  type Request,
  type ResponseOk,
  type ResponseErr,
  type Response,
  type ResponseMeta,
  type Event,
  type Envelope,
  type MutationCounts,
  type NetworkActivity,
  type A11yDelta,
  type NewDialog,
  type Effect,
  type ActionExpectation,
  isHello,
  isHelloAck,
  isRequest,
  isResponse,
  isEvent,
} from "./protocol.js";

// Daemon ↔ shim protocol (multi-session daemon).
export {
  DAEMON_PROTOCOL_VERSION,
  type DaemonClientInfo,
  type ShimRegister,
  type DaemonRegisterAck,
  type DaemonRegisterNak,
  type ShimMcpIn,
  type DaemonMcpOut,
  type ShimBye,
  type DaemonBye,
  type ShimToDaemon,
  type DaemonToShim,
  type DaemonEnvelope,
  isShimRegister,
  isShimMcpIn,
  isShimBye,
  isDaemonRegisterAck,
  isDaemonRegisterNak,
  isDaemonMcpOut,
  isDaemonBye,
} from "./daemon-protocol.js";

// Error codes + WS close codes.
export {
  ERROR_CODES,
  type ErrorCode,
  isErrorCode,
  CloseCode,
  type CloseCodeValue,
} from "./errors.js";

// Server-emitted event payloads + name registry.
export {
  type TabCreatedPayload,
  type TabClosedPayload,
  type TabUpdatedPayload,
  type PageNavigatedPayload,
  type PageLoadedPayload,
  type ExtensionPausedPayload,
  type ExtensionResumedPayload,
  type EventName,
  type EventMap,
} from "./events.js";

// Launchable coding-agent catalogue (extension picker + bridge validation).
export {
  type AgentId,
  type AgentCaps,
  type AgentInfo,
  AGENTS,
  DEFAULT_AGENT_ID,
  getAgent,
  isLaunchableAgent,
  canChatAgent,
} from "./agents.js";

// Normalized chat vocabulary (engine ↔ side-panel chat client).
export {
  type ChatRole,
  CHAT_ROLES,
  isChatRole,
  type ChatBlock,
  type ChatMessage,
  type SessionRef,
  type ChatSettings,
  type ChatAgentStatus,
  DEFAULT_CHAT_SETTINGS,
  type ChatSessionCapabilities,
  DEFAULT_CHAT_SESSION_CAPABILITIES,
  type ChatStatusState,
  type ChatEvent,
  type ChatEventMeta,
  type ChatProviderBinding,
  type ChatPageContext,
  TERMINAL_MODES,
  type TerminalMode,
  isTerminalMode,
} from "./chat.js";

// Runtime constants — defaults, timeouts, well-known filenames, env keys.
export {
  DEFAULT_WS_HOST,
  DEFAULT_WS_PORT,
  MAX_FRAME_BYTES,
  DEFAULT_TOOL_TIMEOUT_MS,
  NAVIGATE_TIMEOUT_MS,
  WAIT_FOR_TIMEOUT_CAP_MS,
  HELLO_TIMEOUT_MS,
  RATE_LIMIT_PER_TAB_PER_MIN,
  RATE_LIMIT_GLOBAL_PER_MIN_DEFAULT,
  RISKY_CONFIRM_TIMEOUT_MS,
  STATE_DIR_NAME,
  TOKEN_FILENAME,
  LOG_FILENAME,
  RISKY_DOMAINS_FILENAME,
  EXTENSION_ID_FILENAME,
  DAEMON_SOCKET_FILENAME,
  DAEMON_PIDFILE_FILENAME,
  ENV,
} from "./constants.js";

// MCP tool catalogue + JSON-Schema fragments.
export {
  type JSONSchemaObject,
  type ToolDef,
  TOOL_DEFS,
  TOOL_DEF_MAP,
  getToolDef,
} from "./tools.js";

// Read-slice helper (browser_read content windowing).
export { type ContentSlice, sliceContent } from "./read-slice.js";

// Procedure schema, types, tokenisation utilities.
export {
  type InputFieldType,
  type InputFieldDef,
  type SideEffectClass,
  type ForbiddenDef,
  type ExpectDef,
  type VerifyDef,
  type FallbackStrategy,
  type FallbackDef,
  type AutoWaitDef,
  type StepAction,
  type StepDef,
  type StepHealth,
  type HealthDef,
  type ProcedureMetaDef,
  type ProcedureDef,
  PROCEDURE_SCHEMA,
  STOP_WORDS,
  tokenize,
} from "./procedures.js";

// Locator descriptors + matchers.
export {
  type AriaRole,
  type RegexLike,
  type Locator,
  parseSerialisedRegex,
  serialiseRegex,
  locatorToCanonical,
  isLocatorEmpty,
  LOCATOR_SCHEMA,
} from "./locator.js";

// Locator stability classifier (tier 1/2/3).
export { type LocatorStabilityTier, classifyField, classifyLocator } from "./locator-stability.js";

// Cross-agent lore store.
export {
  type LoreType,
  LORE_TYPES,
  LORE_NAME_PATTERN,
  LORE_NAME_REGEX,
  type LoreFrontmatter,
  type LoreEntry,
  type LoreSearchMatch,
  isLoreType,
} from "./lore.js";

// Destructive-keyboard-chord deny-list (security-critical: do not weaken).
export { type ResolvedModifier, isDestructiveChord } from "./destructive-chords.js";

// PageEffect envelope (returned by every observation-capable handler).
export { type PageEffect } from "./effects.js";

// Trace events for auto-approval audit log.
export { type TraceEvent, type AutoApprovedEvent } from "./trace.js";

// Experimental-feature flag registry.
export {
  FEATURES,
  type FeatureName,
  type FeatureMetadata,
  FEATURE_METADATA,
  KNOWN_FEATURES,
  isFeatureName,
  parseFeaturesEnv,
  resolveFeatures,
} from "./features.js";
