import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync, readdirSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = join(__dirname, '..');
const MARKETPLACE_JSON = join(REPO_ROOT, '.claude-plugin', 'marketplace.json');

describe('marketplace.json', () => {
  it('exists at .claude-plugin/marketplace.json', () => {
    expect(existsSync(MARKETPLACE_JSON)).toBe(true);
  });

  const raw = readFileSync(MARKETPLACE_JSON, 'utf-8');

  it('is valid JSON', () => {
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  const marketplace = JSON.parse(raw);

  it('has required top-level fields', () => {
    expect(marketplace).toHaveProperty('name');
    expect(marketplace).toHaveProperty('owner');
    expect(marketplace).toHaveProperty('plugins');
    expect(marketplace.owner).toHaveProperty('name');
  });

  it('name is kebab-case without spaces', () => {
    expect(marketplace.name).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
  });

  it('plugins is a non-empty array', () => {
    expect(Array.isArray(marketplace.plugins)).toBe(true);
    expect(marketplace.plugins.length).toBeGreaterThan(0);
  });

  it('each plugin has name, source, and description', () => {
    for (const plugin of marketplace.plugins) {
      expect(plugin).toHaveProperty('name');
      expect(plugin).toHaveProperty('source');
      expect(plugin).toHaveProperty('description');
    }
  });

  it('each plugin source path points to a directory that exists', () => {
    for (const plugin of marketplace.plugins) {
      const source = typeof plugin.source === 'string' ? plugin.source : plugin.source.path;
      const pluginDir = join(REPO_ROOT, source);
      expect(existsSync(pluginDir)).toBe(true);
      expect(statSync(pluginDir).isDirectory()).toBe(true);
    }
  });

  it('each plugin directory contains .claude-plugin/plugin.json', () => {
    for (const plugin of marketplace.plugins) {
      const source = typeof plugin.source === 'string' ? plugin.source : plugin.source.path;
      const pluginJson = join(REPO_ROOT, source, '.claude-plugin', 'plugin.json');
      expect(existsSync(pluginJson)).toBe(true);
      const content = JSON.parse(readFileSync(pluginJson, 'utf-8'));
      expect(content).toHaveProperty('name');
      expect(content.name).toBe(plugin.name);
    }
  });
});

describe('plugin structure: inerrata', () => {
  const PLUGIN_DIR = join(REPO_ROOT, 'plugins', 'inerrata');

  it('has .mcp.json with at least one MCP server', () => {
    const mcpPath = join(PLUGIN_DIR, '.mcp.json');
    expect(existsSync(mcpPath)).toBe(true);
    const mcp = JSON.parse(readFileSync(mcpPath, 'utf-8'));
    expect(mcp).toHaveProperty('mcpServers');
    expect(Object.keys(mcp.mcpServers).length).toBeGreaterThan(0);
  });

  it('MCP servers use canonical inerrata.ai URLs (not Railway)', () => {
    const mcpPath = join(PLUGIN_DIR, '.mcp.json');
    const raw = readFileSync(mcpPath, 'utf-8');
    expect(raw).not.toContain('railway.app');
    expect(raw).toContain('inerrata.ai');
  });

  it('has hooks/hooks.json with lifecycle hooks', () => {
    const hooksPath = join(PLUGIN_DIR, 'hooks', 'hooks.json');
    expect(existsSync(hooksPath)).toBe(true);
    const hooks = JSON.parse(readFileSync(hooksPath, 'utf-8'));
    expect(hooks).toHaveProperty('hooks');
    expect(Object.keys(hooks.hooks).length).toBeGreaterThanOrEqual(3);
  });

  it('has CLAUDE.md behavioral contract', () => {
    const claudePath = join(PLUGIN_DIR, 'CLAUDE.md');
    expect(existsSync(claudePath)).toBe(true);
    const content = readFileSync(claudePath, 'utf-8');
    expect(content).toContain('Behavioral Contract');
    expect(content).toContain('search');
    expect(content).toContain('contribute');
  });

  it('has at least 5 skills with SKILL.md files', () => {
    const skillsDir = join(PLUGIN_DIR, 'skills');
    expect(existsSync(skillsDir)).toBe(true);
    const skills = readdirSync(skillsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .filter(d => existsSync(join(skillsDir, d.name, 'SKILL.md')));
    expect(skills.length).toBeGreaterThanOrEqual(5);
  });

  it('each skill has valid SKILL.md frontmatter with name and description', () => {
    const skillsDir = join(PLUGIN_DIR, 'skills');
    const skillDirs = readdirSync(skillsDir, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const dir of skillDirs) {
      const skillMd = join(skillsDir, dir.name, 'SKILL.md');
      if (!existsSync(skillMd)) continue;
      const content = readFileSync(skillMd, 'utf-8');
      // Check frontmatter exists with name and description
      expect(content).toMatch(/^---\n/);
      expect(content).toMatch(/name:\s+\S+/);
      expect(content).toMatch(/description:\s+.+/);
    }
  });

  it('all hook scripts are executable', () => {
    const hooksDir = join(PLUGIN_DIR, 'hooks');
    const scripts = readdirSync(hooksDir)
      .filter(f => f.endsWith('.sh'));

    expect(scripts.length).toBeGreaterThanOrEqual(4);

    for (const script of scripts) {
      const stat = statSync(join(hooksDir, script));
      expect(stat.mode & 0o111).toBeGreaterThan(0);
    }
  });

  it('plugin.json omits legacy agents and commands fields for current Claude Code installs', () => {
    const pluginJson = JSON.parse(
      readFileSync(join(PLUGIN_DIR, '.claude-plugin', 'plugin.json'), 'utf-8')
    );
    expect(pluginJson).not.toHaveProperty('agents');
    expect(pluginJson).not.toHaveProperty('commands');
  });

  it('no files reference Railway infrastructure URLs', () => {
    const checkDir = (dir: string) => {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== '__tests__') {
          checkDir(fullPath);
        } else if (entry.isFile() && !entry.name.endsWith('.test.ts')) {
          const content = readFileSync(fullPath, 'utf-8');
          expect(content).not.toContain('railway.app');
        }
      }
    };
    checkDir(PLUGIN_DIR);
  });
});
