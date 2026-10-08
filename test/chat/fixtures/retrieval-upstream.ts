import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

/** Real loop/client, deterministic local upstream, and isolated missing KB (no real embedding calls). */
export async function startRetrievalUpstream(root: string, configPath: string) {
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const toolReplies = body.messages.filter((m: { role: string }) => m.role === 'tool').length;
    const question = body.messages.findLast((m: { role: string }) => m.role === 'user')?.content;
    const targetRounds = question === 'four rounds' ? 4 : 1;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (body.tools?.length && toolReplies < targetRounds) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call-${toolReplies}`, type: 'function', function: { name: 'ki_search', arguments: JSON.stringify({ query: 'fixture query', mode: 'fulltext' }) } }] }, finish_reason: 'tool_calls' }] })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '确定性本地回答' }, finish_reason: 'stop' }] })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  writeFileSync(configPath, [
    `dataDir: ${path.join(root, 'data')}`, `chatDir: ${path.join(root, 'chat')}`,
    `vectorDir: ${path.join(root, 'vectors')}`, 'scopeMode: strict', 'scopes:', '  kisearch: {}',
    'embedding:', '  provider: mock', '  baseURL: http://127.0.0.1:1/v1', '  model: mock', '  apiKey: mock-key',
    'llm:', `  baseURL: http://127.0.0.1:${port}/v1`, '  apiKey: mock-key', '  model: mock-model', '  kbDisclosureAck: true',
  ].join('\n'));
  return async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}
