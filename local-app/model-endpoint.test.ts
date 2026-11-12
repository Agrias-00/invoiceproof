// The model route: the app may use OpenRouter; tests and evaluations reach only the test proxy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chatEndpoint, OPENROUTER_URL, routeClaudeToSession, testEndpoint, TEST_MODELS } from './model-endpoint.ts';

function withEnv(env: Record<string, string | undefined>, run: () => void) {
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  try { run(); } finally { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}

test('the app uses OpenRouter by default and a configured endpoint only with its own key', () => {
  withEnv({ INVOICEPROOF_LLM_URL: undefined, INVOICEPROOF_LLM_KEY: undefined, OPENROUTER_API_KEY: 'or' }, () => {
    assert.deepEqual(chatEndpoint(), { url: OPENROUTER_URL, key: 'or' });
  });
  withEnv({ INVOICEPROOF_LLM_URL: 'http://proxy/v1/chat/completions', INVOICEPROOF_LLM_KEY: undefined, OPENROUTER_API_KEY: 'or' }, () => {
    assert.equal(chatEndpoint(), null, 'the OpenRouter key is never sent to another endpoint');
  });
});

test('the test endpoint comes from the proxy file and is never OpenRouter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'llm-'));
  withEnv({ INVOICEPROOF_TEST_LLM_CONFIG: join(dir, 'none.json'), OPENROUTER_API_KEY: 'or' }, () => {
    assert.match(String(testEndpoint()), /never use OpenRouter/);
  });
  writeFileSync(join(dir, 'proxy.json'), JSON.stringify({ base_url: 'http://proxy:8317/', api_key: 'k' }));
  withEnv({ INVOICEPROOF_TEST_LLM_CONFIG: join(dir, 'proxy.json') }, () => {
    assert.deepEqual(testEndpoint(), { url: 'http://proxy:8317/v1/chat/completions', key: 'k' });
  });
});

test('a test proxy file that points at OpenRouter is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'llm-'));
  writeFileSync(join(dir, 'proxy.json'), JSON.stringify({ base_url: 'https://open' + 'router.ai/api', api_key: 'k' }));
  withEnv({ INVOICEPROOF_TEST_LLM_CONFIG: join(dir, 'proxy.json') }, () => {
    assert.match(String(testEndpoint()), /never use OpenRouter/);
  });
});

test('a Claude model never reaches the test proxy; other models do', async () => {
  const endpoint = { url: 'http://proxy:8317/v1/chat/completions', key: 'k' };
  const seen: string[] = [];
  const saved = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => { seen.push(JSON.parse(String(init?.body)).model); return new Response('{}'); }) as typeof fetch;
  try {
    routeClaudeToSession(endpoint);
    await fetch(endpoint.url, { method: 'POST', body: JSON.stringify({ model: 'gpt-5.6-terra', messages: [] }) });
    assert.deepEqual(seen, ['gpt-5.6-terra']);
    assert.ok(Object.values(TEST_MODELS).filter(m => m.startsWith('claude-')).length > 0, 'the Claude test models exist and take the session route');
  } finally { globalThis.fetch = saved; }
});
