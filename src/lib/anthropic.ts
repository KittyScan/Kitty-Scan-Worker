/**
 * Thin forwarder to the Claude Messages API.
 * Accepts the already-composed prompt + base64 image and returns whatever Claude said,
 * plus token usage for our cost tracker.
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

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
