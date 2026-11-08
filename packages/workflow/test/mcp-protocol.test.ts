/** P5-03: the MCP wire helpers shared by the MCP Server Trigger and the workspace MCP server. */
import { describe, expect, it } from 'vitest';
import {
  checkMcpRoutingHeaders,
  isModernMcpRequest,
  type JsonRpcRequest,
  MCP_ERRORS,
  MCP_LATEST_REVISION,
  MCP_LEGACY_REVISIONS,
  mcpCompleteResult,
  mcpDiscoverResult,
  mcpError,
  mcpErrorResult,
  mcpInitializeResult,
  mcpResult,
  mcpResultFromValue,
  negotiateMcpVersion,
  parseMcpMessage,
} from '../src';

const request = (method: string, params?: Record<string, unknown>, id: string | number = 1) =>
  ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) as JsonRpcRequest;

const modernMeta = { _meta: { 'io.modelcontextprotocol/protocolVersion': MCP_LATEST_REVISION } };

describe('parseMcpMessage', () => {
  it('reads requests, notifications and responses', () => {
    expect(parseMcpMessage({ jsonrpc: '2.0', id: 7, method: 'tools/list' })).toEqual({
      kind: 'request',
      message: { jsonrpc: '2.0', id: 7, method: 'tools/list' },
    });
    expect(
      parseMcpMessage({
        jsonrpc: '2.0',
        id: 'a',
        method: 'tools/call',
        params: { name: 'x', arguments: {} },
      }),
    ).toEqual({
      kind: 'request',
      message: { jsonrpc: '2.0', id: 'a', method: 'tools/call', params: { name: 'x', arguments: {} } },
    });
    expect(parseMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' })).toEqual({
      kind: 'notification',
      message: { jsonrpc: '2.0', method: 'notifications/initialized' },
    });
    expect(parseMcpMessage({ jsonrpc: '2.0', id: 3, result: {} })).toEqual({ kind: 'response' });
    expect(parseMcpMessage({ jsonrpc: '2.0', id: 3, error: { code: 1, message: 'x' } })).toEqual({
      kind: 'response',
    });
  });

  it('keeps only the protocol fields of a message', () => {
    const parsed = parseMcpMessage({ jsonrpc: '2.0', id: 1, method: 'ping', extra: 'dropped' });
    expect(parsed).toEqual({ kind: 'request', message: { jsonrpc: '2.0', id: 1, method: 'ping' } });
  });

  it('refuses a batch with -32600', () => {
    const parsed = parseMcpMessage([{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
    expect(parsed).toEqual({
      kind: 'invalid',
      id: null,
      code: MCP_ERRORS.INVALID_REQUEST,
      text: 'Batch requests are not supported',
    });
  });

  it('refuses malformed messages with -32600 and the id when it can read one', () => {
    for (const body of [null, 'text', 42, {}, { jsonrpc: '1.0', id: 1, method: 'ping' }]) {
      const parsed = parseMcpMessage(body);
      expect(parsed.kind).toBe('invalid');
      if (parsed.kind === 'invalid') expect(parsed.code).toBe(MCP_ERRORS.INVALID_REQUEST);
    }
    expect(parseMcpMessage({ jsonrpc: '2.0', id: 5, method: '' })).toMatchObject({ kind: 'invalid', id: 5 });
    expect(parseMcpMessage({ jsonrpc: '2.0', id: 5, method: 'x', params: [1] })).toMatchObject({
      kind: 'invalid',
      id: 5,
      code: MCP_ERRORS.INVALID_REQUEST,
    });
    expect(parseMcpMessage({ jsonrpc: '2.0', id: null, method: 'ping' })).toMatchObject({
      kind: 'invalid',
      id: null,
    });
    expect(parseMcpMessage({ jsonrpc: '2.0', id: { a: 1 }, method: 'ping' })).toMatchObject({
      kind: 'invalid',
      id: null,
    });
    expect(parseMcpMessage({ jsonrpc: '2.0', id: 1, method: 'ping', result: {} })).toMatchObject({
      kind: 'invalid',
      id: 1,
    });
  });
});

describe('versions and answers', () => {
  it('negotiates a supported revision, else the latest', () => {
    expect(negotiateMcpVersion('2025-06-18')).toBe('2025-06-18');
    expect(negotiateMcpVersion('2024-11-05')).toBe('2024-11-05');
    expect(negotiateMcpVersion(MCP_LATEST_REVISION)).toBe(MCP_LATEST_REVISION);
    expect(negotiateMcpVersion('1999-01-01')).toBe(MCP_LATEST_REVISION);
    expect(negotiateMcpVersion(undefined)).toBe(MCP_LATEST_REVISION);
    expect(negotiateMcpVersion(5)).toBe(MCP_LATEST_REVISION);
  });

  it('builds results and errors', () => {
    expect(mcpResult(1, { a: 1 })).toEqual({ jsonrpc: '2.0', id: 1, result: { a: 1 } });
    expect(mcpError(null, MCP_ERRORS.PARSE, 'Parse error')).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
    expect(mcpError('x', -32602, 'Bad', { field: 'name' })).toEqual({
      jsonrpc: '2.0',
      id: 'x',
      error: { code: -32602, message: 'Bad', data: { field: 'name' } },
    });
  });

  it('builds the initialize result with tools only and instructions as a string', () => {
    expect(
      mcpInitializeResult({
        name: 'My_Tools',
        version: '0.1.0',
        instructions: 'Use me',
        protocolVersion: '2025-06-18',
      }),
    ).toEqual({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'My_Tools', version: '0.1.0' },
      instructions: 'Use me',
    });
    expect(
      mcpInitializeResult({ name: 'n', version: '0.1.0', protocolVersion: '2025-03-26' }),
    ).not.toHaveProperty('instructions');
  });

  it('builds the 2026 discover result with every supported revision', () => {
    const result = mcpDiscoverResult({ name: 'n', version: '0.1.0', instructions: 'hi' });
    expect(result).toEqual({
      resultType: 'complete',
      ttlMs: 0,
      cacheScope: 'private',
      supportedVersions: [MCP_LATEST_REVISION, ...MCP_LEGACY_REVISIONS],
      capabilities: { tools: {} },
      instructions: 'hi',
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'n', version: '0.1.0' } },
    });
  });

  it('marks 2026 results complete, with cache hints on lists', () => {
    expect(mcpCompleteResult('tools/list', { tools: [] })).toEqual({
      tools: [],
      resultType: 'complete',
      ttlMs: 0,
      cacheScope: 'private',
    });
    expect(mcpCompleteResult('tools/call', { content: [] })).toEqual({ content: [], resultType: 'complete' });
  });

  it('tells a 2026 request by its envelope or by server/discover', () => {
    expect(isModernMcpRequest(request('server/discover'))).toBe(true);
    expect(isModernMcpRequest(request('tools/list', modernMeta))).toBe(true);
    expect(isModernMcpRequest(request('tools/list'))).toBe(false);
    expect(
      isModernMcpRequest(
        request('tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-06-18' } }),
      ),
    ).toBe(false);
  });
});

describe('checkMcpRoutingHeaders', () => {
  it('passes matching or absent headers on a 2025 request', () => {
    expect(checkMcpRoutingHeaders({}, request('tools/list'))).toBeNull();
    expect(checkMcpRoutingHeaders({ 'mcp-method': 'tools/list' }, request('tools/list'))).toBeNull();
    expect(
      checkMcpRoutingHeaders(
        { 'mcp-method': 'tools/call', 'mcp-name': 'add' },
        request('tools/call', { name: 'add', arguments: {} }),
      ),
    ).toBeNull();
  });

  it('refuses a method or name that differs from the body', () => {
    expect(checkMcpRoutingHeaders({ 'mcp-method': 'tools/call' }, request('tools/list'))).toEqual({
      code: MCP_ERRORS.HEADER_MISMATCH,
      text: 'The Mcp-Method header does not match the request',
    });
    expect(
      checkMcpRoutingHeaders(
        { 'mcp-method': 'tools/call', 'mcp-name': 'other' },
        request('tools/call', { name: 'add', arguments: {} }),
      ),
    ).toEqual({ code: MCP_ERRORS.HEADER_MISMATCH, text: 'The Mcp-Name header does not match the request' });
  });

  it('requires the headers on a 2026 request and decodes a base64 name', () => {
    expect(checkMcpRoutingHeaders({}, request('tools/list', modernMeta))?.code).toBe(
      MCP_ERRORS.HEADER_MISMATCH,
    );
    expect(
      checkMcpRoutingHeaders(
        { 'mcp-method': 'tools/call' },
        request('tools/call', { ...modernMeta, name: 'add' }),
      ),
    ).toEqual({ code: MCP_ERRORS.HEADER_MISMATCH, text: 'The Mcp-Name header does not match the request' });
    const name = 'héllo';
    const encoded = `=?base64?${btoa(String.fromCharCode(...new TextEncoder().encode(name)))}?=`;
    expect(
      checkMcpRoutingHeaders(
        { 'mcp-method': 'tools/call', 'mcp-name': encoded },
        request('tools/call', { ...modernMeta, name }),
      ),
    ).toBeNull();
    expect(
      checkMcpRoutingHeaders({ 'mcp-method': ['tools/list'] }, request('tools/list', modernMeta)),
    ).toBeNull();
  });
});

describe('tool results', () => {
  it('passes strings through and writes anything else as JSON text', () => {
    expect(mcpResultFromValue('42')).toEqual({ content: [{ type: 'text', text: '42' }] });
    expect(mcpResultFromValue({ a: [1, 2] })).toEqual({ content: [{ type: 'text', text: '{"a":[1,2]}' }] });
    expect(mcpResultFromValue(7)).toEqual({ content: [{ type: 'text', text: '7' }] });
    expect(mcpResultFromValue(undefined)).toEqual({ content: [{ type: 'text', text: '' }] });
    expect(mcpResultFromValue(null)).toEqual({ content: [{ type: 'text', text: 'null' }] });
  });

  it('writes a failure as one text part with the tool name', () => {
    expect(mcpErrorResult('add', 'boom')).toEqual({
      content: [{ type: 'text', text: 'add: boom' }],
      isError: true,
    });
  });
});
