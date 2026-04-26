import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const PLUGIN_ROOT = join(__dirname, '..');
const AGENTS_DIR = join(PLUGIN_ROOT, 'agents');

const AGENT_FILES = [
  'inerrata-debugger.md',
  'inerrata-contributor.md',
  'inerrata-surveyor.md',
];

const VALID_MODELS = ['sonnet', 'opus', 'haiku', 'inherit'];
const VALID_COLORS = [
  'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'magenta',
  'white', 'gray', 'grey',
];
const MCP_TOOL_PREFIX = 'mcp__plugin_inerrata_';

/**
 * Simple YAML frontmatter parser — handles scalar values, multiline strings,
 * and YAML arrays (both block and flow style). No external dependency needed.
 */
function parseFrontmatter(content: string): Record<string, any> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) throw new Error('No YAML frontmatter found');
  const yaml = match[1];
  const result: Record<string, any> = {};
  const lines = yaml.split('\n');

  let currentKey: string | null = null;
  let collectingArray = false;

  for (const line of lines) {
    // Block array item: "  - value"
    if (collectingArray && /^\s+-\s+/.test(line)) {
      const val = line.replace(/^\s+-\s+/, '').trim();
      if (currentKey) {
        if (!Array.isArray(result[currentKey])) result[currentKey] = [];
        result[currentKey].push(val);
      }
      continue;
    }

    // New key-value pair
    const kvMatch = line.match(/^([a-z][\w-]*):\s*(.*)/);
    if (kvMatch) {
      collectingArray = false;
      currentKey = kvMatch[1];
      const value = kvMatch[2].trim();

      if (value === '' || value === '>-') {
        // Could be followed by a block array or multiline string
        result[currentKey] = '';
        continue;
      }

      // Flow-style array: [a, b, c]
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

    // Continuation of block array or multiline string
    if (currentKey && /^\s+-\s+/.test(line)) {
      collectingArray = true;
      const val = line.replace(/^\s+-\s+/, '').trim();
      if (!Array.isArray(result[currentKey])) result[currentKey] = [];
      result[currentKey].push(val);
    } else if (currentKey && line.startsWith('  ') && !collectingArray) {
      // Multiline string continuation
      const prev = result[currentKey] || '';
      result[currentKey] = (prev + ' ' + line.trim()).trim();
    }
  }

  return result;
}

describe('agents/', () => {
  it('agents directory exists', () => {
    expect(existsSync(AGENTS_DIR)).toBe(true);
  });

  for (const file of AGENT_FILES) {
    describe(file, () => {
      const filePath = join(AGENTS_DIR, file);

      it('file exists', () => {
        expect(existsSync(filePath)).toBe(true);
      });

      it('has valid YAML frontmatter', () => {
        const content = readFileSync(filePath, 'utf-8');
        expect(() => parseFrontmatter(content)).not.toThrow();
      });

      it('has required frontmatter fields: name, description, model, color', () => {
        const content = readFileSync(filePath, 'utf-8');
        const fm = parseFrontmatter(content);
        expect(fm).toHaveProperty('name');
        expect(fm).toHaveProperty('description');
        expect(fm).toHaveProperty('model');
        expect(fm).toHaveProperty('color');
      });

      it('name follows kebab-case pattern', () => {
        const content = readFileSync(filePath, 'utf-8');
        const fm = parseFrontmatter(content);
        expect(fm.name).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
      });

      it('model is a valid option', () => {
        const content = readFileSync(filePath, 'utf-8');
        const fm = parseFrontmatter(content);
        expect(VALID_MODELS).toContain(fm.model);
      });

      it('color is a valid option', () => {
        const content = readFileSync(filePath, 'utf-8');
        const fm = parseFrontmatter(content);
        expect(VALID_COLORS).toContain(fm.color);
      });

      it('tools array references valid MCP tool names', () => {
        const content = readFileSync(filePath, 'utf-8');
        const fm = parseFrontmatter(content);
        const tools = Array.isArray(fm.tools) ? fm.tools : [];
        expect(tools.length).toBeGreaterThan(0);
        const mcpTools = tools.filter((t: string) => t.startsWith('mcp__'));
        expect(mcpTools.length).toBeGreaterThan(0);
        for (const tool of mcpTools) {
          expect(tool).toMatch(new RegExp(`^${MCP_TOOL_PREFIX}`));
        }
      });

      it('body contains at least 3 <example> blocks', () => {
        const content = readFileSync(filePath, 'utf-8');
        const body = content.replace(/^---\n[\s\S]*?\n---/, '');
        const exampleCount = (body.match(/<example>/g) || []).length;
        expect(exampleCount).toBeGreaterThanOrEqual(3);
      });

      it('has a substantive system prompt (200+ words in body)', () => {
        const content = readFileSync(filePath, 'utf-8');
        const body = content.replace(/^---\n[\s\S]*?\n---/, '').trim();
        const wordCount = body.split(/\s+/).length;
        expect(wordCount).toBeGreaterThanOrEqual(200);
      });
    });
  }
});
