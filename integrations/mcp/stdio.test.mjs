import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { MAX_REQUEST_BYTES, runStdio } from './stdio.mjs';

const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
const reply = (message, result) => ({ code: 0, stdout: JSON.stringify({ ok: true, action: 'mcp', jsonrpc: '2.0', id: message.id, result }), stderr: '' });
async function session(lines, cli) {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', chunk => { text += chunk; });
  const done = runStdio({ input, output, cli });
  input.end(lines.map(line => typeof line === 'string' ? line : JSON.stringify(line)).join('\n') + '\n');
  await done;
  return text.trim() ? text.trim().split('\n').map(line => JSON.parse(line)) : [];
}

test('negotiates initialize and preserves pure JSON-RPC while forwarding private data on stdin', async () => {
  const forwarded = [];
  const cli = async (args, options) => {
    assert.deepEqual(args, ['meetings', 'api', '--request-stdin', '--json']);
    const value = JSON.parse(options.input);
    forwarded.push(value);
    return reply(value.request, value.request.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} } } : { tools: [] });
  };
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', chunk => { text += chunk; });
  const done = runStdio({ input, output, cli });
  input.write(JSON.stringify(request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })) + '\n');
  while (!text.includes('protocolVersion')) await new Promise(resolve => setImmediate(resolve));
  input.end(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n' + JSON.stringify(request('tools', 'tools/list')) + '\n');
  await done;
  const responses = text.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(responses.length, 2);
  assert.equal(responses[0].ok, undefined);
  assert.equal(responses[0].action, undefined);
  assert.equal(forwarded[1].protocolVersion, '2025-06-18');
});

test('uses current per-request metadata and forwards tool validation without weakening delete guards', async () => {
  const messages = await session([request(3, 'tools/call', {
    name: 'meetings_delete', arguments: { id: 'mtg_abcdef' },
    _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} },
  })], async (_args, options) => {
    const value = JSON.parse(options.input);
    assert.equal(value.protocolVersion, '2026-07-28');
    assert.deepEqual(value.request.params.arguments, { id: 'mtg_abcdef' });
    return reply(value.request, { isError: true, structuredContent: { ok: false, error: { code: 'invalid_request' } } });
  });
  assert.equal(messages[0].result.isError, true);
});

test('rejects invalid, batched and oversized messages and resumes after the oversized line', async () => {
  let calls = 0;
  const messages = await session(['{', JSON.stringify([request(1, 'ping')]), 'x'.repeat(MAX_REQUEST_BYTES + 1), request('ok', 'ping')], async (_args, options) => {
    calls++;
    return reply(JSON.parse(options.input).request, {});
  });
  assert.equal(calls, 1);
  assert.deepEqual(messages.map(message => message.error?.code ?? message.id), [-32700, -32600, -32600, 'ok']);
});

test('cancels in-flight calls without emitting a response', async () => {
  let cancelled = false;
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', chunk => { text += chunk; });
  const done = runStdio({ input, output, cli: async (_args, options) => {
    await new Promise(resolve => options.signal.addEventListener('abort', () => { cancelled = true; resolve(); }, { once: true }));
    throw new Error('secret diagnostic');
  } });
  input.write(JSON.stringify(request('cancel-me', 'tools/call', { name: 'meetings_list' })) + '\n');
  await new Promise(resolve => setImmediate(resolve));
  input.end(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'cancel-me' } }) + '\n');
  await done;
  assert.equal(cancelled, true);
  assert.equal(text, '');
});

test('ignores invalid cancellation of initialize and cancels children on transport shutdown', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', chunk => { text += chunk; });
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const done = runStdio({ input, output, cli: async (_args, options) => {
    await gate;
    assert.equal(options.signal.aborted, false);
    return reply(JSON.parse(options.input).request, { protocolVersion: '2025-11-25' });
  } });
  input.write(JSON.stringify(request(1, 'initialize', {})) + '\n');
  await new Promise(resolve => setImmediate(resolve));
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }) + '\n');
  finish();
  input.end();
  await done;
  assert.equal(JSON.parse(text).id, 1);

  const controller = new AbortController();
  const input2 = new PassThrough();
  let aborted = false;
  const shutdown = runStdio({ input: input2, output: new PassThrough(), signal: controller.signal, cli: async (_args, options) => {
    await new Promise(resolve => options.signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
    throw new Error('aborted');
  } });
  input2.write(JSON.stringify(request(2, 'ping')) + '\n');
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await shutdown;
  assert.equal(aborted, true);
});

test('limits concurrent CLI children and rejects reused request ids', async () => {
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = [];
  output.on('data', chunk => messages.push(...chunk.toString().trim().split('\n').map(JSON.parse)));
  let calls = 0;
  const done = runStdio({ input, output, cli: async (_args, options) => { calls++; await gate; return reply(JSON.parse(options.input).request, {}); } });
  input.write(Array.from({ length: 7 }, (_, id) => JSON.stringify(request(id, 'ping'))).join('\n') + '\n' + JSON.stringify(request(0, 'ping')) + '\n');
  while (messages.length < 2) await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 6);
  assert.deepEqual(messages.map(message => message.error.code), [-32000, -32600]);
  finish();
  input.end();
  await done;
  assert.equal(messages.filter(message => message.result).length, 6);
});

test('never forwards CLI diagnostics, malformed envelopes or oversized stdout to MCP clients', async () => {
  for (const cli of [
    async () => ({ code: 1, stdout: '{}', stderr: 'machine-secret-private' }),
    async () => ({ code: 0, stdout: 'CLI banner machine-secret-private', stderr: '' }),
    async () => ({ code: 0, stdout: 'x'.repeat(2 * 1024 * 1024), stderr: '' }),
  ]) {
    const messages = await session([request(1, 'ping')], cli);
    assert.equal(messages[0].error.code, -32603);
    assert.equal(JSON.stringify(messages).includes('machine-secret-private'), false);
  }
});

test('standalone process uses BB_CLI without SDK dependencies, shell interpolation or stdout diagnostics', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'meetings-mcp-cli-'));
  try {
    const mockCli = join(directory, 'bb');
    await writeFile(mockCli, `#!${process.execPath}\nlet input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',c=>input+=c); process.stdin.on('end',()=>{const v=JSON.parse(input); const r=v.request; process.stderr.write('private diagnostic\\n'); if(process.argv.slice(2).join(' ')!=='meetings api --request-stdin --json') process.exit(3); process.stdout.write(JSON.stringify({ok:true,action:'mcp',jsonrpc:'2.0',id:r.id,result:{echo:r.params?.arguments?.question}})+'\\n');});\n`);
    await chmod(mockCli, 0o700);
    const child = spawn(process.execPath, [fileURLToPath(new URL('./stdio.mjs', import.meta.url))], { env: { ...process.env, BB_CLI: mockCli }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const code = new Promise(resolve => child.on('close', resolve));
    child.stdin.end(JSON.stringify(request(1, 'tools/call', { name: 'meetings_ask', arguments: { question: 'Привет $(never-execute) `never-execute`\nsecond line' } })) + '\n');
    assert.equal(await code, 0);
    assert.equal(stderr, '');
    assert.deepEqual(JSON.parse(stdout), { jsonrpc: '2.0', id: 1, result: { echo: 'Привет $(never-execute) `never-execute`\nsecond line' } });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
