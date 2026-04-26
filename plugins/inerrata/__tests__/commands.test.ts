import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const PLUGIN_ROOT = join(__dirname, '..');
const COMMANDS_DIR = join(PLUGIN_ROOT, 'commands');

const COMMAND_FILES = [
  'errata.md',
  'errata-status.md',
  'errata-contribute.md',
];

const VALID_MODELS = ['sonnet', 'opus', 'haiku', 'inherit'];
const MCP_TOOL_PREFIX = 'mcp__plugin_inerrata_';

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

describe('commands/', () => {
  it('commands directory exists', () => {
    expect(existsSync(COMMANDS_DIR)).toBe(true);
  });

  for (const file of COMMAND_FILES) {
    describe(file, () => {
      const filePath = join(COMMANDS_DIR, file);

      it('file exists', () => {
        expect(existsSync(filePath)).toBe(true);
      });

      it('has valid YAML frontmatter', () => {
        const content = readFileSync(filePath, 'utf-8');
        expect(() => parseFrontmatter(content)).not.toThrow();
      });

      it('has required frontmatter field: description', () => {
        const content = readFileSync(filePath, 'utf-8');
        const fm = parseFrontmatter(content);
        expect(fm).toHaveProperty('description');
        expect(typeof fm.description).toBe('string');
        expect(fm.description.length).toBeGreaterThan(0);
      });

      it('has valid model', () => {
        const content = readFileSync(filePath, 'utf-8');
        const fm = parseFrontmatter(content);
        expect(fm).toHaveProperty('model');
        expect(VALID_MODELS).toContain(fm.model);
      });

      it('allowed-tools reference valid MCP tool names', () => {
        const content = readFileSync(filePath, 'utf-8');
        const fm = parseFrontmatter(content);
        expect(fm).toHaveProperty('allowed-tools');
        const tools: string[] = Array.isArray(fm['allowed-tools'])
          ? fm['allowed-tools']
          : [];
        expect(tools.length).toBeGreaterThan(0);
        for (const tool of tools) {
          expect(tool).toMatch(new RegExp(`^${MCP_TOOL_PREFIX}`));
        }
      });

      it('has a body after frontmatter', () => {
        const content = readFileSync(filePath, 'utf-8');
        const body = content.replace(/^---\n[\s\S]*?\n---/, '').trim();
        expect(body.length).toBeGreaterThan(0);
      });
    });
  }
});
