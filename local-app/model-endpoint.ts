// The chat-completions endpoint every model call uses, so the route is decided in one place.
// The running app talks to OpenRouter with OPENROUTER_API_KEY. Tests and evaluations never do: they run only on a
// local OpenAI-compatible proxy described by a JSON file {"base_url", "api_key"}, except Claude models, which run in the
// maintainer's own Claude session (claude -p). The proxy file is
// at INVOICEPROOF_TEST_LLM_CONFIG (default ~/.claude/harness/cliproxy.json), with the proxy's model ids below.
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
export type Endpoint = { url: string; key: string };

/** The app's endpoint: an explicit key wins, else INVOICEPROOF_LLM_URL with its own key, else OpenRouter. */
export function chatEndpoint(apiKey?: string): Endpoint | null {
  const url = process.env.INVOICEPROOF_LLM_URL;
  if (url) { const key = apiKey ?? process.env.INVOICEPROOF_LLM_KEY; return key ? { url, key } : null; }
  const key = apiKey ?? process.env.OPENROUTER_API_KEY;
  return key ? { url: OPENROUTER_URL, key } : null;
}

/** The test ids for the models the app names on OpenRouter; INVOICEPROOF_MODEL, _AUDIT_MODEL and _ANSWER_MODEL override them.
 *  A Claude id runs in the maintainer's Claude session (`claude -p`), never on the proxy; other ids run on the proxy. */
export const TEST_MODELS = { draft: 'claude-sonnet-5-5', audit: 'gpt-5.6-terra', answer: 'claude-sonnet-5-5' } as const;
const SESSION_MODEL = /^claude-/;

/** One chat completion through the Claude Code CLI on the maintainer's login, returned in the chat-completions shape.
 *  --safe-mode keeps the user's hooks, CLAUDE.md, plugins and MCP out, so the model sees only this request. */
export async function askClaudeSession(model: string, messages: { role: string; content: string }[]): Promise<Response> {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const user = messages.filter(m => m.role !== 'system').map(m => m.content).join('\n\n');
  const args = ['-p', '--safe-mode', '--model', model, '--effort', 'high', '--output-format', 'text', '--system-prompt', `${system}\nReply with the JSON object only, no code fence.`];
  const out = await new Promise<string>((done, fail) => {
    const child = spawn('claude', args, { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
    let text = '', err = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 300000);
    child.stdout.on('data', d => { text += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', fail);
    child.stdin.on('error', fail);            // claude exiting before it reads the prompt (EPIPE) rejects, never crashes the run
    child.on('close', code => { clearTimeout(timer); code === 0 ? done(text) : fail(new Error(`claude -p exited ${code}: ${err.trim().slice(-200)}`)); });
    child.stdin.end(user);
  });
  const json = out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1);
  return new Response(JSON.stringify({ model, choices: [{ message: { role: 'assistant', content: json } }] }), { headers: { 'Content-Type': 'application/json' } });
}

/** The test endpoint, or the reason live model tests are skipped. Never OpenRouter. */
export function testEndpoint(): Endpoint | string {
  const file = process.env.INVOICEPROOF_TEST_LLM_CONFIG ?? join(homedir(), '.claude/harness/cliproxy.json');
  try {
    const conf = JSON.parse(readFileSync(file, 'utf8')) as { base_url?: string; api_key?: string };
    if (!conf.base_url || !conf.api_key) return `no base_url/api_key in ${file}`;
    if (/openrouter\./i.test(conf.base_url)) return `${file} points at OpenRouter; tests and evaluations never use OpenRouter`;
    return { url: `${conf.base_url.replace(/\/+$/, '')}/v1/chat/completions`, key: conf.api_key };
  } catch {
    return `no test model proxy at ${file}; live model tests never use OpenRouter`;
  }
}

/** For evaluation scripts: route every model call in this process to the test proxy, or exit with the reason. */
export function useTestEndpoint(): Endpoint {
  const endpoint = testEndpoint();
  if (typeof endpoint === 'string') { console.error(endpoint); process.exit(2); }
  delete process.env.OPENROUTER_API_KEY;
  process.env.INVOICEPROOF_LLM_URL = endpoint.url;
  process.env.INVOICEPROOF_LLM_KEY = endpoint.key;
  process.env.INVOICEPROOF_MODEL ??= TEST_MODELS.draft;
  process.env.INVOICEPROOF_AUDIT_MODEL ??= TEST_MODELS.audit;
  process.env.INVOICEPROOF_ANSWER_MODEL ??= TEST_MODELS.answer;
  routeClaudeToSession(endpoint);
  return endpoint;
}

/** Answer every call to the test proxy that names a Claude model in the Claude session instead, so no Claude id reaches the proxy. */
export function routeClaudeToSession(endpoint: Endpoint): void {
  const proxyFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === endpoint.url && typeof init?.body === 'string') {
      const body = JSON.parse(init.body) as { model?: string; messages?: { role: string; content: string }[] };
      if (body.model && SESSION_MODEL.test(body.model)) return askClaudeSession(body.model, body.messages ?? []);
    }
    return proxyFetch(input, init);
  }) as typeof fetch;
}
