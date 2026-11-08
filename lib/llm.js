/**
 * Thin model-call helpers on top of the Harness `llm` service.
 *
 * The reading assistant always uses the profile's default model, streams text
 * tokens to the browser, and reports failures as `PaperError` with a status the
 * HTTP routes can pass through.
 */

import { PaperError } from './store.js';

const CALL_TIMEOUT_MS = 180_000;

/**
 * Resolve the profile default model route.
 * @param {{get: (name: string) => any}} services injected Cordis scope
 * @returns {{llm: any, provider: string, model: string}} resolved route
 */
export function modelRoute(services) {
  const llm = services.get('llm');
  if (llm === undefined) {
    throw new PaperError('The model service is unavailable in this profile.', 503);
  }
  const selection = services.get('agentDefaultModel')?.currentSelection?.();
  const provider = selection?.provider;
  const model = selection?.model;
  if (typeof provider !== 'string' || provider.length === 0 || typeof model !== 'string' || model.length === 0) {
    throw new PaperError('No default model is configured for this profile.', 503);
  }
  return { llm, provider, model };
}

/**
 * Human-readable model label for UI footers.
 * @param {{get: (name: string) => any}} services injected Cordis scope
 * @returns {string} provider/model label, or an empty string when unavailable
 */
export function modelLabel(services) {
  try {
    const { provider, model } = modelRoute(services);
    return `${provider}/${model}`;
  } catch {
    return '';
  }
}

/**
 * Stream one completion's text deltas.
 * @param {{get: (name: string) => any}} services injected Cordis scope
 * @param {{system: string, prompt: string, maxTokens?: number, temperature?: number, signal?: AbortSignal}} input call inputs
 * @returns {AsyncGenerator<string>} text deltas
 */
export async function* streamCompletion(services, input) {
  const { llm, provider, model } = modelRoute(services);
  const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
  const signal = input.signal === undefined ? timeout : AbortSignal.any([input.signal, timeout]);
  const stream = llm.stream({
    provider,
    model,
    system: input.system,
    messages: [{ role: 'user', content: [{ type: 'text', text: input.prompt }] }],
    maxTokens: input.maxTokens ?? 2000,
    temperature: input.temperature ?? 0.3,
    signal,
  });
  let produced = false;
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') {
      if (chunk.text.length > 0) {
        produced = true;
        yield chunk.text;
      }
      continue;
    }
    if (chunk.type !== 'finish') continue;
    const reason = chunk.reason;
    if (reason.kind === 'error' || reason.kind === 'aborted') {
      const message = reason.failure?.message ?? 'The model call failed.';
      throw new PaperError(message, 502);
    }
    if (reason.kind === 'max-tokens') {
      if (!produced) throw new PaperError('The model used its whole output budget before writing an answer.', 502);
      if (typeof input.onTruncated === 'function') input.onTruncated();
    }
    return;
  }
}

/**
 * Collect one completion into a single string.
 * @param {{get: (name: string) => any}} services injected Cordis scope
 * @param {{system: string, prompt: string, maxTokens?: number, temperature?: number, signal?: AbortSignal}} input call inputs
 * @returns {Promise<string>} completed text
 */
export async function completeText(services, input) {
  let text = '';
  let truncated = false;
  for await (const delta of streamCompletion(services, {
    ...input,
    onTruncated:
      typeof input.onTruncated === 'function'
        ? () => {
            truncated = true;
            input.onTruncated();
          }
        : () => {
            truncated = true;
          },
  })) {
    text += delta;
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new PaperError('The model returned an empty answer.', 502);
  return { text: trimmed, truncated };
}
