import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildMcpConfig } from '../benchmark/mcp-config.js';

function readConfig(path: string) {
  return JSON.parse(readFileSync(path, 'utf8')) as {
    mcpServers: Record<string, { url?: string; headers?: Record<string, string> }>;
  };
}

describe('CTF MCP config', () => {
  const originalCtfApiUrl = process.env.CTF_INERRATA_API_URL;
  const originalApiUrl = process.env.INERRATA_API_URL;
  const originalErrataApiUrl = process.env.ERRATA_API_URL;
  const originalCtfMcpUrl = process.env.CTF_INERRATA_MCP_URL;
  const originalMcpUrl = process.env.INERRATA_MCP_URL;
  const originalErrataMcpUrl = process.env.ERRATA_MCP_URL;

  afterEach(() => {
    if (originalCtfApiUrl === undefined) delete process.env.CTF_INERRATA_API_URL;
    else process.env.CTF_INERRATA_API_URL = originalCtfApiUrl;
    if (originalApiUrl === undefined) delete process.env.INERRATA_API_URL;
    else process.env.INERRATA_API_URL = originalApiUrl;
    if (originalErrataApiUrl === undefined) delete process.env.ERRATA_API_URL;
    else process.env.ERRATA_API_URL = originalErrataApiUrl;
    if (originalCtfMcpUrl === undefined) delete process.env.CTF_INERRATA_MCP_URL;
    else process.env.CTF_INERRATA_MCP_URL = originalCtfMcpUrl;
    if (originalMcpUrl === undefined) delete process.env.INERRATA_MCP_URL;
    else process.env.INERRATA_MCP_URL = originalMcpUrl;
    if (originalErrataMcpUrl === undefined) delete process.env.ERRATA_MCP_URL;
    else process.env.ERRATA_MCP_URL = originalErrataMcpUrl;
  });

  it('defaults MCP to the local CTF API', () => {
    delete process.env.CTF_INERRATA_API_URL;
    delete process.env.INERRATA_API_URL;
    delete process.env.ERRATA_API_URL;
    delete process.env.CTF_INERRATA_MCP_URL;
    delete process.env.INERRATA_MCP_URL;
    delete process.env.ERRATA_MCP_URL;
    const tmp = mkdtempSync(join(tmpdir(), 'ctf-mcp-'));

    try {
      const path = buildMcpConfig({
        auth: 'anonymous',
        resultsDir: tmp,
        agentId: 'agent-1',
      });

      expect(readConfig(path).mcpServers.inerrata?.url).toBe('http://127.0.0.1:3100/mcp');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('derives MCP from the CTF API override', () => {
    process.env.CTF_INERRATA_API_URL = 'http://localhost:3101/';
    delete process.env.CTF_INERRATA_MCP_URL;
    delete process.env.INERRATA_MCP_URL;
    delete process.env.ERRATA_MCP_URL;
    const tmp = mkdtempSync(join(tmpdir(), 'ctf-mcp-'));

    try {
      const path = buildMcpConfig({
        auth: 'authenticated',
        apiKey: 'local-key',
        resultsDir: tmp,
        agentId: 'agent-2',
      });
      const config = readConfig(path);

      expect(config.mcpServers.inerrata?.url).toBe('http://localhost:3101/mcp');
      expect(config.mcpServers.inerrata?.headers?.Authorization).toBe('Bearer local-key');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('uses an explicit CTF MCP override', () => {
    process.env.CTF_INERRATA_MCP_URL = 'http://localhost:3999/custom-mcp/';
    const tmp = mkdtempSync(join(tmpdir(), 'ctf-mcp-'));

    try {
      const path = buildMcpConfig({
        auth: 'anonymous',
        resultsDir: tmp,
        agentId: 'agent-3',
      });

      expect(readConfig(path).mcpServers.inerrata?.url).toBe('http://localhost:3999/custom-mcp');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
