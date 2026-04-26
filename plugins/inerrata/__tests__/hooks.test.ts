import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';

const PLUGIN_ROOT = join(__dirname, '..');
const HOOKS_DIR = join(PLUGIN_ROOT, 'hooks');

describe('hooks.json', () => {
  const raw = readFileSync(join(HOOKS_DIR, 'hooks.json'), 'utf-8');

  it('is valid JSON', () => {
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('has a hooks key with expected event types', () => {
    const config = JSON.parse(raw);
    expect(config).toHaveProperty('hooks');
    expect(Object.keys(config.hooks)).toEqual(
      expect.arrayContaining(['SessionStart', 'Stop', 'PostToolUseFailure', 'PreCompact', 'PostToolUse'])
    );
  });

  it('references scripts that exist', () => {
    const config = JSON.parse(raw);
    for (const entries of Object.values(config.hooks) as any[][]) {
      for (const entry of entries) {
        for (const hook of entry.hooks) {
          if (hook.type === 'command') {
            const scriptPath = hook.command.replace(
              '${CLAUDE_PLUGIN_ROOT}',
              PLUGIN_ROOT
            );
            expect(existsSync(scriptPath)).toBe(true);
          }
        }
      }
    }
  });

  it('references scripts that are executable', () => {
    const config = JSON.parse(raw);
    for (const entries of Object.values(config.hooks) as any[][]) {
      for (const entry of entries) {
        for (const hook of entry.hooks) {
          if (hook.type === 'command') {
            const scriptPath = hook.command.replace(
              '${CLAUDE_PLUGIN_ROOT}',
              PLUGIN_ROOT
            );
            const stat = statSync(scriptPath);
            // Check owner execute bit (0o100)
            expect(stat.mode & 0o111).toBeGreaterThan(0);
          }
        }
      }
    }
  });
});

describe('post-tool-failure.sh', () => {
  const content = readFileSync(join(HOOKS_DIR, 'post-tool-failure.sh'), 'utf-8');

  it('uses the search tool, not burst', () => {
    expect(content).toContain('"tool": "search"');
    expect(content).not.toContain('"tool": "burst"');
  });

  it('parses result.results (not result.nodes)', () => {
    expect(content).toContain('.result.results');
    expect(content).not.toContain('.result.nodes');
  });

  it('builds a valid-looking API call payload', () => {
    const payloadMatch = content.match(/PAYLOAD=\$\(jq -n --arg query "\$QUERY" '(\{[\s\S]*?\})'\)/);
    expect(payloadMatch).not.toBeNull();
    const payloadTemplate = payloadMatch![1]
      .replace('$query', '"test"');
    expect(() => JSON.parse(payloadTemplate)).not.toThrow();
  });
});

describe('session-start.sh', () => {
  const content = readFileSync(join(HOOKS_DIR, 'session-start.sh'), 'utf-8');

  it('references search() in the behavioral contract, not burst()', () => {
    expect(content).toContain('call search()');
    expect(content).not.toContain('call burst()');
  });
});

describe('pre-compact.sh', () => {
  const content = readFileSync(join(HOOKS_DIR, 'pre-compact.sh'), 'utf-8');

  it('references search() in the reminder, not burst()', () => {
    expect(content).toContain('use search()');
    expect(content).not.toContain('use burst()');
  });
});
