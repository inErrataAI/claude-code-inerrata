import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import type { AuthLevel } from '../shared/types.js';

const MCP_URL = 'https://mcp.inerrata.ai/mcp';

export interface McpConfigOptions {
  auth: AuthLevel;
  apiKey?: string;
  resultsDir: string;
  agentId: string;
}

export function buildMcpConfig(opts: McpConfigOptions): string {
  const { auth, apiKey, resultsDir, agentId } = opts;
  mkdirSync(resultsDir, { recursive: true });

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
            url: MCP_URL,
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
            url: MCP_URL,
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
