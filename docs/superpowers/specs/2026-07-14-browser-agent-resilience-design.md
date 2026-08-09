# Glide Browser Agent Resilience Design

## Objective

Make browser automation recover predictably from interaction failures, provide usable visual context to every supported provider, and avoid premature stops or repeated no-progress actions. Preserve the current side-panel UI and provider model while changing only the runtime paths implicated by the audit.

## Scope

This design covers:

- content-bridge message ownership and real bridge integration tests;
- loading all runtime settings while keeping the UI limited to its current five fields;
- inactivity-based model timeout behavior;
- screenshot delivery for Anthropic, Codex, OpenCode Zen, and Ollama;
- bounded failed-tool recovery and repeated-action detection;
- navigation readiness and stale DOM-cache prevention;
- iframe fallback after recoverable bridge misses;
- repair of the stale E2E tab-selector expectation and provider documentation.

It does not replace the orchestration architecture, add new UI controls, add providers, or refactor unrelated code.

## Architecture

### Content bridge

The legacy content-script listener will claim only messages with a recognized `message.action`. Messages using `type: "glide_bridge"` will be handled exclusively by `installGlideBridge()`. A recoverable bridge miss such as `ELEMENT_NOT_FOUND` will fall through to the existing injected implementation, including its `allFrames` pass. Definitive failures such as disabled elements remain final and will not duplicate work.

### Runtime settings and timeout

`SETTINGS_STORAGE_KEYS` remains the side-panel persistence contract. A separate explicit runtime key list will include every setting consumed by normalization, permissions, recovery, vision, model limits, and orchestration. Cache invalidation will observe the same runtime list.

The model request timer will represent inactivity rather than total task duration. Streaming chunks and tool start/end events reset it. The timer will not abort while a tool is still executing. The existing active-run watchdog remains the outer stalled-run safety limit.

### Vision delivery

Anthropic keeps the existing direct multimodal tool-result path. Codex, OpenCode Zen, and Ollama receive a synchronous textual description when an explicit screenshot or failure-recovery screenshot is required. Ollama is eligible without an API key. If the selected model cannot process images, the screenshot result records the vision failure and directs recovery to DOM structure without aborting the run.

Screenshot storage remains ephemeral and bounded; base64 data is not added to conversation history or UI runtime messages.

### Failure recovery and loop prevention

Browser-action failures will be tracked by a signature containing tool name, normalized selector or target, tab ID, and current URL. A third identical failure without intervening success will be rejected with a `REPEATED_FAILURE` result that requires a different strategy.

If a model pass ends after failed browser actions without a successful verification read, finalization is blocked once. The next pass receives compact failed-tool results and a required sequence: `findElement`, structural inspection, bounded wait, then screenshot if still unresolved. A second no-progress pass ends with a clear failure instead of looping.

Success, navigation, tab change, or verified fresh content resets the relevant failure signature.

### Navigation and DOM freshness

`navigate` and `openTab` will wait for a bounded page-ready condition and report whether the content bridge became available. A readiness timeout returns success-with-warning when Chrome accepted the navigation but the page did not become automatable; it does not wait indefinitely.

The DOM cache TTL will be reduced from 30 seconds to 5 seconds. `wait` and modal dismissal will invalidate the target tab cache before the next inspection, preventing an early loading-state snapshot from surviving a deliberate wait.

## Error Handling and Safety Limits

- Bridge fallback occurs only for recoverable miss codes.
- Forced failed-tool continuation is limited to one pass.
- Identical failed actions are blocked on the third occurrence.
- Navigation readiness has a fixed upper bound.
- Vision has its existing 30-second bound and degrades to DOM recovery.
- Existing screenshot, tab, telemetry, and vision-queue caps remain unchanged.
- Permission and domain-allowlist values stored locally are honored again.

## Testing Strategy

Each change follows a red-green cycle through a public or observable boundary:

1. A browser-loaded production bundle must answer bridge `ping` with `{ success: true, bridge: true }` and must not return `Unknown action`.
2. Runtime settings tests must prove that false values, allowlists, timeout, and vision flags survive storage loading.
3. Vision tests must prove Ollama is eligible with an empty key and asynchronous descriptions cannot be lost from the active run.
4. Recovery tests must prove failed tools cannot finalize immediately and repeated signatures are blocked and reset by progress.
5. Navigation tests must prove readiness is bounded and stale cache entries are not reused after `wait`.
6. Iframe tests must prove a top-frame bridge miss reaches the existing all-frame fallback.
7. The E2E suite must stop depending on the removed `#tabSelectorBtn` and exercise current tab-scoped behavior.

Final acceptance requires TypeScript, lint, production build, validator, unit tests, E2E tests, and the real bridge probe to pass. Live provider tests may be skipped when credentials or a local Ollama model are unavailable, but provider-independent vision routing tests are mandatory.

## Implementation Order

1. Content listener ownership and bridge regression test.
2. Complete runtime settings loading and inactivity timeout.
3. Provider-aware in-turn vision delivery.
4. Failed-tool continuation and repeated-action guard.
5. Navigation readiness, cache freshness, and iframe fallback.
6. E2E/documentation alignment and full production validation.
