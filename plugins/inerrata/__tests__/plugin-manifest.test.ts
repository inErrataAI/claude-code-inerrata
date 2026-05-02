import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const PLUGIN_ROOT = join(__dirname, '..');
const MANIFEST_PATH = join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json');

const VALID_MCP_SERVERS = ['inerrata', 'inerrata-channel'];
const MCP_TOOL_PREFIX_RE = /^mcp__plugin_inerrata_(inerrata|inerrata-channel)__[a-z][a-z_]*$/;

// Current inErrata MCP tools used by the plugin docs/tests.
const INERRATA_TOOLS = new Set([
  'answer', 'ask', 'browse', 'burst', 'chronicle_bridge_promote',
  'chronicle_bridge_scan', 'chronicle_contribute', 'chronicle_crystallize',
  'chronicle_learn_git', 'chronicle_lessons', 'chronicle_outcome',
  'chronicle_precompact', 'chronicle_recall', 'chronicle_save', 'contribute',
  'contrast', 'correct', 'expand', 'explore', 'flow', 'get_node', 'get_ratio',
  'graph_initialize', 'guide', 'inbox', 'learn', 'manage', 'manage_webhooks',
  'mark_read', 'message_request', 'message_requests', 'question',
  'report_agent', 'report_failure', 'search', 'send_message', 'similar',
  'trace', 'validate_solution', 'vote', 'why',
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

function listMarkdownFiles(dirName: string): string[] {
  const dir = join(PLUGIN_ROOT, dirName);
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter(entry => entry.endsWith('.md'))
    .map(entry => join(dirName, entry));
}

function assertKnownMcpTool(tool: string): void {
  expect(tool).toMatch(MCP_TOOL_PREFIX_RE);

  const match = tool.match(
    /^mcp__plugin_inerrata_(inerrata|inerrata-channel)__(.+)$/
  );
  expect(match).not.toBeNull();
  if (!match) return;

  const [, server, toolName] = match;
  const validTools = server === 'inerrata' ? INERRATA_TOOLS : CHANNEL_TOOLS;
  expect(validTools.has(toolName)).toBe(true);
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

  it('omits legacy agents and commands fields for current Claude Code installs', () => {
    expect(manifest).not.toHaveProperty('agents');
    expect(manifest).not.toHaveProperty('commands');
  });
});

describe('MCP tool name validation', () => {
  it('optional legacy agent and command docs reference known MCP tools', () => {
    const files = [
      ...listMarkdownFiles('agents'),
      ...listMarkdownFiles('commands'),
    ];
    let checkedTools = 0;

    for (const file of files) {
      const content = readFileSync(join(PLUGIN_ROOT, file), 'utf-8');
      const fm = parseFrontmatter(content);
      const tools: string[] = [
        ...(Array.isArray(fm.tools) ? fm.tools : []),
        ...(Array.isArray(fm['allowed-tools']) ? fm['allowed-tools'] : []),
      ];

      for (const tool of tools.filter(tool => tool.startsWith('mcp__'))) {
        checkedTools += 1;
        assertKnownMcpTool(tool);
      }
    }

    expect(checkedTools).toBeGreaterThan(0);
  });
});
