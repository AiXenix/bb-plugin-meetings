#!/usr/bin/env node
// Portable MCP transport. Uses Node builtins and the official BB CLI only.
// Authentication stays in BB's private CLI configuration and environment.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAX_REQUEST_BYTES = 512 * 1024;
export const MAX_RESULT_BYTES = 1024 * 1024 + 4096;
const MAX_PENDING = 6;
const CLI_ARGS = ['meetings', 'api', '--request-stdin', '--json'];

/** BB_CLI is the official absolute CLI entrypoint override; otherwise use PATH. */
export function runBbCli(args, { input, signal, timeoutMs = 240000 } = {}) {
  return new Promise((fulfill, reject) => {
    const child = spawn(process.env.BB_CLI || 'bb', args, {
      stdio: ['pipe', 'pipe', 'pipe'], env: process.env, shell: false,
    });
    const stdoutChunks = [];
    let outputBytes = 0;
    let finished = false;
    let stopReason = null;
    let killTimer;
    const stop = reason => {
      if (finished || stopReason !== null) return;
      stopReason = reason;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
      killTimer.unref();
    };
    const abort = () => stop('cancelled');
    const timeout = setTimeout(() => stop('timeout'), timeoutMs);
    timeout.unref();
    signal?.addEventListener('abort', abort, { once: true });
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      error ? reject(error) : fulfill(result);
    };
    child.stdout.on('data', chunk => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_RESULT_BYTES) stop('too_large');
      else stdoutChunks.push(chunk);
    });
    // Consume diagnostics without forwarding potentially private CLI content.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.once('error', () => finish(new Error('cli_unavailable')));
    child.once('close', code => {
      if (stopReason !== null) finish(new Error(stopReason));
      else finish(null, { code, stdout: Buffer.concat(stdoutChunks).toString('utf8'), stderr: '' });
    });
    if (signal?.aborted) abort();
    else child.stdin.end(input ?? '');
  });
}

const rpcError = (id, code, message, data) => ({
  jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) },
});
const validId = id => (typeof id === 'string' && id.length <= 200) || Number.isSafeInteger(id);

/** Optional integrations may inject their existing enrolled CLI launcher. */
export async function runStdio({ input = process.stdin, output = process.stdout, cli = runBbCli, signal } = {}) {
  const pending = new Map();
  let protocolVersion = '2025-11-25';
  let outputQueue = Promise.resolve();
  const write = message => {
    outputQueue = outputQueue.then(async () => {
      if (!output.write(JSON.stringify(message) + '\n')) await once(output, 'drain');
    });
    return outputQueue;
  };
  const processLine = async line => {
    if (line.length === 0) return;
    let request;
    try { request = JSON.parse(line.toString('utf8')); }
    catch { await write(rpcError(null, -32700, 'Invalid JSON')); return; }
    if (request === null || typeof request !== 'object' || Array.isArray(request)
      || request.jsonrpc !== '2.0' || typeof request.method !== 'string'
      || (request.id !== undefined && !validId(request.id))) {
      await write(rpcError(null, -32600, 'Expected one JSON-RPC request or notification')); return;
    }
    if (request.id === undefined) {
      if (request.method === 'notifications/cancelled') {
        const current = pending.get(JSON.stringify(request.params?.requestId));
        if (current && current.method !== 'initialize') current.controller.abort();
      } else if (!request.method.startsWith('notifications/')) {
        await write(rpcError(null, -32600, 'Requests require an id'));
      }
      return;
    }
    const key = JSON.stringify(request.id);
    if (pending.has(key)) { await write(rpcError(request.id, -32600, 'Request id is already in progress')); return; }
    if (pending.size >= MAX_PENDING) { await write(rpcError(request.id, -32000, 'Too many concurrent requests')); return; }
    const controller = new AbortController();
    const entry = { controller, method: request.method, promise: null };
    pending.set(key, entry);
    entry.promise = (async () => {
      try {
        const metadataVersion = request.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
        const selectedVersion = typeof metadataVersion === 'string' ? metadataVersion : protocolVersion;
        const result = await cli(CLI_ARGS, {
          input: JSON.stringify({ action: 'mcp', request, protocolVersion: selectedVersion }) + '\n',
          signal: controller.signal, timeoutMs: 240000,
        });
        if (controller.signal.aborted) return;
        if (typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > MAX_RESULT_BYTES) throw new Error('invalid_cli_response');
        let body;
        try { body = JSON.parse(result.stdout); } catch { throw new Error('invalid_cli_response'); }
        if (result.code !== 0 || body?.ok !== true || body.jsonrpc !== '2.0' || body.id !== request.id
          || (!Object.hasOwn(body, 'result') && !Object.hasOwn(body, 'error'))) throw new Error('invalid_cli_response');
        const response = { jsonrpc: '2.0', id: body.id, ...(Object.hasOwn(body, 'result') ? { result: body.result } : { error: body.error }) };
        if (request.method === 'initialize' && typeof body.result?.protocolVersion === 'string') protocolVersion = body.result.protocolVersion;
        await write(response);
      } catch {
        if (!controller.signal.aborted) await write(rpcError(request.id, -32603, 'BB CLI request failed. Check BB authentication and the installed Meetings plugin.'));
      } finally { pending.delete(key); }
    })();
  };
  let buffer = Buffer.alloc(0);
  let droppingOversizedLine = false;
  const jobs = new Set();
  const submit = line => {
    const job = processLine(line);
    jobs.add(job);
    void job.finally(() => jobs.delete(job));
  };
  const abort = () => {
    for (const entry of pending.values()) entry.controller.abort();
    input.destroy?.();
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) { abort(); return; }
    for await (const chunk of input) {
      let remaining = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      while (remaining.length > 0) {
        const newline = remaining.indexOf(10);
        const piece = newline === -1 ? remaining : remaining.subarray(0, newline);
        if (!droppingOversizedLine && buffer.length + piece.length > MAX_REQUEST_BYTES) {
          buffer = Buffer.alloc(0);
          droppingOversizedLine = true;
          await write(rpcError(null, -32600, 'Request too large'));
        }
        if (!droppingOversizedLine) buffer = Buffer.concat([buffer, piece]);
        if (newline === -1) break;
        if (!droppingOversizedLine) submit(buffer);
        buffer = Buffer.alloc(0);
        droppingOversizedLine = false;
        remaining = remaining.subarray(newline + 1);
      }
      await outputQueue;
    }
    if (buffer.length > 0 && !droppingOversizedLine) submit(buffer);
    await Promise.all([...jobs]);
    await Promise.all([...pending.values()].map(entry => entry.promise));
    await outputQueue;
  } catch (error) {
    if (!signal?.aborted) throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    for (const entry of pending.values()) entry.controller.abort();
    await Promise.allSettled([...pending.values()].map(entry => entry.promise));
  }
}

/** Process entrypoint with tidy child cancellation when the MCP client exits. */
export async function startStdio(options = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try { await runStdio({ ...options, signal: controller.signal }); }
  catch {
    if (!controller.signal.aborted) {
      process.stderr.write('Meetings MCP transport failed.\n');
      process.exitCode = 1;
    }
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await startStdio();
