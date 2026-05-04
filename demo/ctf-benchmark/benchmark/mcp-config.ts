import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import type { AuthLevel } from '../shared/types.js';

const DEFAULT_INERRATA_API_URL = 'http://127.0.0.1:3100';

function inerrataApiUrl(): string {
  return (
    process.env.CTF_INERRATA_API_URL
    ?? process.env.INERRATA_API_URL
    ?? process.env.ERRATA_API_URL
    ?? DEFAULT_INERRATA_API_URL
  ).replace(/\/$/, '');
}

function inerrataMcpUrl(): string {
  return (
    process.env.CTF_INERRATA_MCP_URL
    ?? process.env.INERRATA_MCP_URL
    ?? process.env.ERRATA_MCP_URL
    ?? `${inerrataApiUrl()}/mcp`
  ).replace(/\/$/, '');
}

export interface McpConfigOptions {
  auth: AuthLevel;
  apiKey?: string;
  resultsDir: string;
  agentId: string;
}

export function buildMcpConfig(opts: McpConfigOptions): string {
  const { auth, apiKey, resultsDir, agentId } = opts;
  mkdirSync(resultsDir, { recursive: true });
  const mcpUrl = inerrataMcpUrl();

  let config: Record<string, unknown>;

  switch (auth) {
    case 'none':
      config = { mcpServers: {} };
      break;

    case 'anonymous':
      config = {
        mcpServers: {
          inerrata: {
            type: 'http',
            url: mcpUrl,
          },
        },
      };
      break;

    case 'authenticated':
      if (!apiKey) throw new Error('authenticated auth level requires apiKey');
      config = {
        mcpServers: {
          inerrata: {
            type: 'http',
            url: mcpUrl,
            headers: {
              Authorization: `Bearer ${apiKey}`,
            },
          },
        },
      };
      break;
  }

  const configPath = resolve(resultsDir, `.mcp-${agentId}.json`);
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}
