## OpenRouter Reliability Plan

### Summary
Improve OpenRouter resilience for tool-enabled turns by adding a provider-local retry path and a small OpenRouter-specific config surface. The primary goal is that a simple prompt like `hello` should not hard-fail when OpenRouter rejects the initial tool-enabled request with an upstream `429`/`503`; instead, the provider should retry once without tools, emit a visible status message, and either return a normal assistant reply or surface the second failure with detailed upstream context.

### Implementation Changes
- Keep the retry logic inside [`src/providers/openrouter.ts`](/Users/isaacheist/Code/propio-agent/src/providers/openrouter.ts), not in the generic agent loop. This keeps the behavior provider-specific and avoids changing other backends.
- On the first OpenRouter request only, if `request.tools` is non-empty and the HTTP response is `429` or `503`, retry the same request once with the same `model`, `messages`, and `signal`, but omit `tools`.
- Do not retry if any assistant content chunk has already been received, and do not retry on `400`, `401`, `402`, `404`, context-length errors, or generic network failures.
- Before the retry, emit a `status` stream event with a short user-facing message such as `Retrying without tools after OpenRouter upstream failure`, so the existing UI can show that fallback explicitly.
- Add a new diagnostic event type, `provider_retry`, in [`src/diagnostics.ts`](/Users/isaacheist/Code/propio-agent/src/diagnostics.ts), including `provider`, `model`, `iteration`, `reason`, and `disabledTools: true`, so `--debug-llm` clearly shows when the fallback path is taken.
- Preserve the improved upstream error parsing already added: keep surfacing `provider_name`, nested raw upstream messages, and retry-after details in the final error text when the retry also fails.
- Normalize the OpenRouter title header to send `X-OpenRouter-Title` while keeping the existing config field name `xTitle` for backward compatibility.

### Public Interfaces
- Extend `OpenRouterProviderConfig` in [`src/providers/config.ts`](/Users/isaacheist/Code/propio-agent/src/providers/config.ts) with:
  - `provider?: { allowFallbacks?: boolean; order?: string[]; requireParameters?: boolean }`
  - `fallbackModels?: string[]`
  - `debugEchoUpstreamBody?: boolean`
- Map those fields in the OpenRouter request body as follows:
  - `provider.allowFallbacks` maps to OpenRouter `provider.allow_fallbacks`.
  - `provider.order` maps to OpenRouter `provider.order`, preserving order.
  - `provider.requireParameters` maps to OpenRouter `provider.require_parameters`.
  - `fallbackModels` is sent as OpenRouter `models`, preserving order.
  - `debugEchoUpstreamBody` only takes effect when CLI debug logging is enabled; in that case send `debug: { echo_upstream_body: true }`.
- Update config loading validation so these OpenRouter-only fields are optional, typed, and rejected if malformed:
  - `provider` must be an object when present.
  - `provider.allowFallbacks` and `provider.requireParameters` must be boolean when present.
  - `provider.order` must be a non-empty array of non-empty strings when present.
  - `fallbackModels` must be a non-empty array of non-empty strings when present.
  - `debugEchoUpstreamBody` must be boolean when present.
- Update the README OpenRouter example and troubleshooting guidance to document:
  - the new retry behavior,
  - the new OpenRouter `provider` routing fields and `models` fallback fields,
  - the fact that retries temporarily disable tools for that request only.

### Test Plan
- Provider unit tests:
  - tool-enabled OpenRouter request returning `429` retries once without tools and succeeds.
  - tool-enabled OpenRouter request returning `503` retries once without tools and succeeds.
  - retried request preserves `model` and `messages` and drops only `tools`.
  - non-tool OpenRouter request does not retry on `429`/`503`.
  - `401`, `404`, `402`, context-length, and network errors do not trigger retry.
  - if the retry also fails, the final surfaced error still includes upstream provider details.
  - retry emits a `status` event and a `provider_retry` diagnostic event.
  - `provider`, `fallbackModels`, and `debugEchoUpstreamBody` are serialized correctly into the OpenRouter request body.
- Config tests:
  - valid OpenRouter configs accept the new optional fields.
  - malformed values for `provider`, `fallbackModels`, or `debugEchoUpstreamBody` fail validation with clear messages.
- Acceptance scenario:
  - with OpenRouter as the default provider and tools enabled, the `hello` reproducer no longer fails immediately on the first upstream `429`/`503`; the user sees a retry status and receives a normal assistant answer if the tool-free retry succeeds.

### Assumptions
- The fallback is intentionally narrow: one retry, OpenRouter only, and only when the initial failure happens before any streamed assistant text arrives.
- `defaultModel` remains the primary model; `fallbackModels` is only an OpenRouter routing hint and does not replace the provider’s local model catalog.
- Visible fallback messaging should use existing status/diagnostic channels rather than introducing a new CLI flag or prompt.
- This plan does not change default tool enablement globally; it only disables tools for the single retried OpenRouter request.
