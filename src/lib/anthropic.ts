/**
 * Thin forwarder to the Claude Messages API.
 * Accepts the already-composed prompt + base64 image and returns whatever Claude said,
 * plus token usage for our cost tracker.
 *
 * Two modes:
 *   - callAnthropic       — buffered JSON response (used for chat / translate / personality)
 *   - callAnthropicStream — SSE pass-through used by /analyze when client opts in. The
 *                           SSE body is piped to the client unchanged so we don't pay a
 *                           re-serialization tax on every token; usage tokens are tee'd
 *                           into the cost ledger via a transformer.
 */

export interface AnalyzeInput {
  /** Optional — when absent, a text-only message is sent (used for chat + personality summaries). */
  image_base64?: string;
  prompt: string;
  /** Optional override, clamped to [256, 2000] */
  max_tokens?: number;
}

export interface AnthropicSuccess {
  ok: true;
  data: unknown;
  usage: { input_tokens?: number; output_tokens?: number };
  status: number;
}
export interface AnthropicFailure {
  ok: false;
  status: number;
  detail: string;
}
export type AnthropicResult = AnthropicSuccess | AnthropicFailure;

export interface AnthropicStreamOk {
  ok: true;
  /** SSE body to pipe to the client, already wired to update `usage` on the fly. */
  body: ReadableStream<Uint8Array>;
  /** Resolves with token usage once the upstream `message_delta` arrives. */
  usagePromise: Promise<{ input_tokens?: number; output_tokens?: number }>;
}
export type AnthropicStreamResult = AnthropicStreamOk | AnthropicFailure;

export async function callAnthropic(
  input: AnalyzeInput,
  apiKey: string,
  model: string,
): Promise<AnthropicResult> {
  const maxTokens = clamp(input.max_tokens ?? 1500, 256, 2000);

  const content: Array<Record<string, unknown>> = [];
  if (input.image_base64) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: input.image_base64,
      },
    });
  }
  content.push({ type: 'text', text: input.prompt });

  const payload = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content }],
  };

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const detail = await resp.text();
    return { ok: false, status: resp.status, detail: detail.slice(0, 400) };
  }

  const data = (await resp.json()) as { usage?: { input_tokens?: number; output_tokens?: number } };
  return {
    ok: true,
    data,
    usage: data.usage ?? {},
    status: 200,
  };
}

/**
 * Streaming variant. Same payload shape as `callAnthropic` plus `stream: true`.
 * Returns an SSE body the caller can pipe straight back to its client, plus a
 * promise that resolves with the usage numbers (parsed out of the
 * `message_start` / `message_delta` events the upstream stream carries).
 */
export async function callAnthropicStream(
  input: AnalyzeInput,
  apiKey: string,
  model: string,
): Promise<AnthropicStreamResult> {
  const maxTokens = clamp(input.max_tokens ?? 1500, 256, 2000);

  const content: Array<Record<string, unknown>> = [];
  if (input.image_base64) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: input.image_base64,
      },
    });
  }
  content.push({ type: 'text', text: input.prompt });

  const payload = {
    model,
    max_tokens: maxTokens,
    stream: true,
    messages: [{ role: 'user', content }],
  };

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'accept': 'text/event-stream',
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok || !resp.body) {
    const detail = resp.body ? await resp.text() : '(no body)';
    return { ok: false, status: resp.status, detail: detail.slice(0, 400) };
  }

  // Tee the upstream body — one branch we forward to the client, the other
  // we sniff for usage tokens. `tee()` shares a single read source so the
  // upstream is read exactly once.
  const [forClient, forSniff] = resp.body.tee();

  const usagePromise = sniffUsage(forSniff);

  return { ok: true, body: forClient, usagePromise };
}

/**
 * Reads an Anthropic SSE stream end-to-end, accumulating token usage.
 * Anthropic emits usage in two places:
 *   - `message_start.message.usage`        — input_tokens + cached prompt tokens
 *   - `message_delta.usage.output_tokens`  — running output token count, final value at message_stop
 * We take whichever arrives last (the message_delta value supersedes).
 */
async function sniffUsage(stream: ReadableStream<Uint8Array>): Promise<{
  input_tokens?: number;
  output_tokens?: number;
}> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const usage: { input_tokens?: number; output_tokens?: number } = {};

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by blank lines. Process complete events only.
      let nl: number;
      while ((nl = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        for (const line of event.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const json = line.slice(6).trim();
          if (!json || json === '[DONE]') continue;
          try {
            const parsed = JSON.parse(json) as {
              type?: string;
              message?: { usage?: { input_tokens?: number; output_tokens?: number } };
              usage?: { input_tokens?: number; output_tokens?: number };
            };
            if (parsed.type === 'message_start' && parsed.message?.usage) {
              usage.input_tokens = parsed.message.usage.input_tokens;
              usage.output_tokens = parsed.message.usage.output_tokens;
            } else if (parsed.type === 'message_delta' && parsed.usage) {
              if (parsed.usage.input_tokens !== undefined) usage.input_tokens = parsed.usage.input_tokens;
              if (parsed.usage.output_tokens !== undefined) usage.output_tokens = parsed.usage.output_tokens;
            }
          } catch {
            // Malformed event line — ignore. Cost tracker treats absence as zero.
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return usage;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
