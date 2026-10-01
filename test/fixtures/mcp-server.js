#!/usr/bin/env node
/**
 * Tiny MCP server used by test/mcp.test.ts.
 * Speaks the real protocol over stdio: initialize → notifications/initialized → tools/list → tools/call.
 * It exposes two tools: echo_text (writes) and read_only_info (readOnlyHint: true).
 */
const readline = require('readline');

const TOOLS = [
  {
    name: 'echo_text',
    description: 'Echo the given text back (used by the tests).',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to echo' } },
      required: ['text']
    }
  },
  {
    name: 'read_only_info',
    description: 'Return a fixed piece of information (read-only).',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'always_fails',
    description: 'Always answers with isError.',
    inputSchema: { type: 'object', properties: {} }
  }
];

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return;
  }
  if (message.id === undefined) {
    return; // notification
  }
  const reply = (result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
  const fail = (code, msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code, message: msg } })}\n`);

  switch (message.method) {
    case 'initialize':
      reply({
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'am-code-test-server', version: '1.2.3' }
      });
      break;
    case 'tools/list':
      reply({ tools: TOOLS });
      break;
    case 'tools/call': {
      const name = message.params && message.params.name;
      const args = (message.params && message.params.arguments) || {};
      if (name === 'echo_text') {
        reply({ content: [{ type: 'text', text: `echo: ${args.text}` }] });
      } else if (name === 'read_only_info') {
        reply({ content: [{ type: 'text', text: 'the answer is 42' }] });
      } else if (name === 'always_fails') {
        reply({ isError: true, content: [{ type: 'text', text: 'nope' }] });
      } else {
        fail(-32602, `unknown tool ${name}`);
      }
      break;
    }
    default:
      fail(-32601, `unknown method ${message.method}`);
  }
});
