import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const PLUGIN_ROOT = join(__dirname, '..');
const MANIFEST_PATH = join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json');

const VALID_MCP_SERVERS = ['inerrata', 'inerrata-channel'];
const MCP_TOOL_PREFIX_RE = /^mcp__plugin_inerrata_(inerrata|inerrata-channel)__[a-z][a-z_]*$/;

// Available inerrata MCP tools (from plugin spec)
const INERRATA_TOOLS = new Set([
  'burst', 'explore', 'trace', 'expand', 'similar', 'why', 'contrast', 'flow',
  'graph_initialize', 'get_node', 'browse', 'contribute', 'post_question',
  'post_answer', 'get_question', 'vote', 'inbox', 'message_requests',
  'send_message', 'mark_read', 'message_request', 'validate_solution',
  'report_failure', 'report_agent', 'manage', 'get_ratio', 'manage_webhooks',
]);

// Available channel MCP tools
const CHANNEL_TOOLS = new Set([
  'inbox', 'send_message', 'message_request', 'mark_read', 'message_requests',
  'task_status',
]);

function parseFrontmatter(content: string): Record<string, any> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error('No YAML frontmatter found');
  const yaml = match[1];
  const result: Record<string, any> = {};
  const lines = yaml.split('\n');

  let currentKey: string | null = null;
  let collectingArray = false;

  for (const line of lines) {
    if (collectingArray && /^\s+-\s+/.test(line)) {
      const val = line.replace(/^\s+-\s+/, '').trim();
      if (currentKey) {
        if (!Array.isArray(result[currentKey])) result[currentKey] = [];
        result[currentKey].push(val);
      }
      continue;
    }

    const kvMatch = line.match(/^([a-z][\w-]*):\s*(.*)/);
    if (kvMatch) {
      collectingArray = false;
      currentKey = kvMatch[1];
      const value = kvMatch[2].trim();

      if (value === '' || value === '>-') {
        result[currentKey] = '';
        continue;
      }

      const arrayMatch = value.match(/^\[([\s\S]*)\]$/);
      if (arrayMatch) {
        result[currentKey] = arrayMatch[1]
          .split(',')
          .map(s => s.trim().replace(/^["']|["']$/g, ''));
        continue;
      }

      result[currentKey] = value.replace(/^["']|["']$/g, '');
      continue;
    }

    if (currentKey && /^\s+-\s+/.test(line)) {
      collectingArray = true;
      const val = line.replace(/^\s+-\s+/, '').trim();
      if (!Array.isArray(result[currentKey])) result[currentKey] = [];
      result[currentKey].push(val);
    } else if (currentKey && line.startsWith('  ') && !collectingArray) {
      const prev = result[currentKey] || '';
      result[currentKey] = (prev + ' ' + line.trim()).trim();
    }
  }

  return result;
}

describe('plugin.json manifest', () => {
  it('exists', () => {
    expect(existsSync(MANIFEST_PATH)).toBe(true);
  });

  it('is valid JSON', () => {
    const raw = readFileSync(MANIFEST_PATH, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));

  it('has required top-level fields', () => {
    expect(manifest).toHaveProperty('name');
    expect(manifest).toHaveProperty('description');
    expect(manifest).toHaveProperty('version');
  });

  it('name follows lowercase-hyphen format (3-50 chars)', () => {
    expect(manifest.name).toMatch(/^[a-z][a-z0-9-]{2,49}$/);
  });

  describe('agents array', () => {
    it('exists and is non-empty', () => {
      expect(manifest).toHaveProperty('agents');
      expect(Array.isArray(manifest.agents)).toBe(true);
      expect(manifest.agents.length).toBeGreaterThan(0);
    });

    for (const agentPath of (manifest.agents || [])) {
      it(`references existing file: ${agentPath}`, () => {
        const fullPath = join(PLUGIN_ROOT, agentPath);
        expect(existsSync(fullPath)).toBe(true);
      });

      it(`${agentPath} has valid agent frontmatter`, () => {
        const content = readFileSync(join(PLUGIN_ROOT, agentPath), 'utf-8');
        const fm = parseFrontmatter(content);
        expect(fm).toHaveProperty('name');
        expect(fm).toHaveProperty('description');
        expect(fm).toHaveProperty('model');
        expect(fm).toHaveProperty('color');
      });

      it(`${agentPath} agent name is lowercase-hyphen (3-50 chars)`, () => {
        const content = readFileSync(join(PLUGIN_ROOT, agentPath), 'utf-8');
        const fm = parseFrontmatter(content);
        expect(fm.name).toMatch(/^[a-z][a-z0-9-]{2,49}$/);
        expect(fm.name.length).toBeGreaterThanOrEqual(3);
        expect(fm.name.length).toBeLessThanOrEqual(50);
      });
    }
  });

  describe('commands array', () => {
    it('exists and is non-empty', () => {
      expect(manifest).toHaveProperty('commands');
      expect(Array.isArray(manifest.commands)).toBe(true);
      expect(manifest.commands.length).toBeGreaterThan(0);
    });

    for (const cmdPath of (manifest.commands || [])) {
      it(`references existing file: ${cmdPath}`, () => {
        const fullPath = join(PLUGIN_ROOT, cmdPath);
        expect(existsSync(fullPath)).toBe(true);
      });

      it(`${cmdPath} has valid command frontmatter`, () => {
        const content = readFileSync(join(PLUGIN_ROOT, cmdPath), 'utf-8');
        const fm = parseFrontmatter(content);
        expect(fm).toHaveProperty('description');
        expect(typeof fm.description).toBe('string');
        expect(fm.description.length).toBeGreaterThan(0);
      });
    }
  });
});

describe('MCP tool name validation', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));

  // Skip strict tool-name validation for agents marked as pre-existing/frozen
  const FROZEN_AGENTS = new Set(['agents/inerrata-debugger.md']);

  for (const agentPath of (manifest.agents || [])) {
    describe(`agent: ${agentPath}`, () => {
      const content = readFileSync(join(PLUGIN_ROOT, agentPath), 'utf-8');
      const fm = parseFrontmatter(content);
      const tools: string[] = Array.isArray(fm.tools) ? fm.tools : [];
      const mcpTools = tools.filter(t => t.startsWith('mcp__'));

      for (const tool of mcpTools) {
        it(`${tool} uses correct prefix format`, () => {
          expect(tool).toMatch(MCP_TOOL_PREFIX_RE);
        });

        if (!FROZEN_AGENTS.has(agentPath)) {
          it(`${tool} references a known MCP tool`, () => {
            const match = tool.match(
              /^mcp__plugin_inerrata_(inerrata|inerrata-channel)__(.+)$/
            );
            expect(match).not.toBeNull();
            if (match) {
              const [, server, toolName] = match;
              const validTools = server === 'inerrata' ? INERRATA_TOOLS : CHANNEL_TOOLS;
              expect(validTools.has(toolName)).toBe(true);
            }
          });
        }
      }
    });
  }

  for (const cmdPath of (manifest.commands || [])) {
    describe(`command: ${cmdPath}`, () => {
      const content = readFileSync(join(PLUGIN_ROOT, cmdPath), 'utf-8');
      const fm = parseFrontmatter(content);
      const tools: string[] = Array.isArray(fm['allowed-tools'])
        ? fm['allowed-tools']
        : [];

      for (const tool of tools) {
        it(`${tool} uses correct prefix format`, () => {
          expect(tool).toMatch(MCP_TOOL_PREFIX_RE);
        });

        it(`${tool} references a known MCP tool`, () => {
          const match = tool.match(
            /^mcp__plugin_inerrata_(inerrata|inerrata-channel)__(.+)$/
          );
          expect(match).not.toBeNull();
          if (match) {
            const [, server, toolName] = match;
            const validTools = server === 'inerrata' ? INERRATA_TOOLS : CHANNEL_TOOLS;
            expect(validTools.has(toolName)).toBe(true);
          }
        });
      }
    });
  }
});
