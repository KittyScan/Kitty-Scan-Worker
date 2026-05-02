/**
 * Rough cost tracking by month, stored in KV.
 *
 * Reference prices (Claude Sonnet 4.x, check Anthropic docs for current):
 *   input:  $3  / 1M tokens
 *   output: $15 / 1M tokens
 *
 * Numbers are an estimate — authoritative number is Anthropic Console usage.
 * Hard cap is enforced in Anthropic Console ($20/mo). We alert *before* we hit it.
 */

const INPUT_PRICE_PER_TOKEN = 3 / 1_000_000;
const OUTPUT_PRICE_PER_TOKEN = 15 / 1_000_000;

export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
}

export async function trackAndMaybeAlert(
  usage: AnthropicUsage | undefined,
  kv: KVNamespace,
  alertThresholdUsd: number,
  alertWebhook: string | undefined,
  env: string,
): Promise<void> {
  if (!usage) return;
  const inTok = usage.input_tokens ?? 0;
  const outTok = usage.output_tokens ?? 0;
  const cost = inTok * INPUT_PRICE_PER_TOKEN + outTok * OUTPUT_PRICE_PER_TOKEN;

  const month = new Date().toISOString().slice(0, 7); // YYYY-MM
  const key = `cost:${month}`;
  const prev = parseFloat((await kv.get(key)) || '0');
  const next = prev + cost;

  await kv.put(key, next.toFixed(6), { expirationTtl: 86_400 * 70 });

  // Alert only on crossing the threshold once per month (not every request after).
  if (prev < alertThresholdUsd && next >= alertThresholdUsd) {
    await sendAlert(alertWebhook, month, next, env);
  }
}

async function sendAlert(
  webhook: string | undefined,
  month: string,
  costUsd: number,
  env: string,
): Promise<void> {
  const body = {
    env,
    month,
    costUsd: Number(costUsd.toFixed(2)),
    message: `Carmel monthly cost crossed alert threshold: $${costUsd.toFixed(2)} in ${month}`,
  };
  console.log('COST_ALERT', JSON.stringify(body));
  if (!webhook) return;
  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.warn('alert webhook failed', e);
  }
}
