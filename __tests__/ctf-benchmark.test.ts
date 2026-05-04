import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildMcpConfig } from '../demo/ctf-benchmark/benchmark/mcp-config';
import { EQUALIZATION_WAVES, FUNNEL_WAVES } from '../demo/ctf-benchmark/benchmark/waves';
import { buildSystemPrompt } from '../demo/ctf-benchmark/agents/prompts';

const REPO_ROOT = join(__dirname, '..');
const MARKETPLACE_JSON = join(REPO_ROOT, '.claude-plugin', 'marketplace.json');
const CTF_PLUGIN_DIR = join(REPO_ROOT, 'demo', 'ctf-benchmark');
const INERRATA_PLUGIN_DIR = join(REPO_ROOT, 'plugins', 'inerrata');
const CTF_MANIFEST_PATH = join(CTF_PLUGIN_DIR, '.claude-plugin', 'plugin.json');

/**
 * Extract skill names from SKILL.md frontmatter in a given skills directory.
 * Returns an array of { dir, name } objects.
 */
function getSkillNames(skillsDir: string): { dir: string; name: string }[] {
  if (!existsSync(skillsDir)) return [];
  const dirs = readdirSync(skillsDir, { withFileTypes: true }).filter(d => d.isDirectory());
  const results: { dir: string; name: string }[] = [];
  for (const d of dirs) {
    const skillMd = join(skillsDir, d.name, 'SKILL.md');
    if (!existsSync(skillMd)) continue;
    const content = readFileSync(skillMd, 'utf-8');
    const nameMatch = content.match(/^---\n[\s\S]*?name:\s*(.+)/m);
    if (nameMatch) {
      results.push({ dir: d.name, name: nameMatch[1].trim().replace(/^["']|["']$/g, '') });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Group 1: Marketplace Registration
// ---------------------------------------------------------------------------
describe('Marketplace Registration', () => {
  const raw = readFileSync(MARKETPLACE_JSON, 'utf-8');
  const marketplace = JSON.parse(raw);

  it('marketplace.json lists a "ctf-benchmark" plugin entry', () => {
    const entry = marketplace.plugins.find((p: any) => p.name === 'ctf-benchmark');
    expect(entry).toBeDefined();
  });

  it('ctf-benchmark entry has source pointing to "./demo/ctf-benchmark"', () => {
    const entry = marketplace.plugins.find((p: any) => p.name === 'ctf-benchmark');
    expect(entry).toBeDefined();
    const source = typeof entry.source === 'string' ? entry.source : entry.source.path;
    expect(source).toBe('./demo/ctf-benchmark');
  });

  it('ctf-benchmark entry has category and tags', () => {
    const entry = marketplace.plugins.find((p: any) => p.name === 'ctf-benchmark');
    expect(entry).toBeDefined();
    expect(entry).toHaveProperty('category');
    expect(typeof entry.category).toBe('string');
    expect(entry.category.length).toBeGreaterThan(0);
    expect(entry).toHaveProperty('tags');
    expect(Array.isArray(entry.tags)).toBe(true);
    expect(entry.tags.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Group 2: Plugin Manifest
// ---------------------------------------------------------------------------
describe('Plugin Manifest', () => {
  it('demo/ctf-benchmark/.claude-plugin/plugin.json exists', () => {
    expect(existsSync(CTF_MANIFEST_PATH)).toBe(true);
  });

  it('plugin.json parses as valid JSON', () => {
    if (!existsSync(CTF_MANIFEST_PATH)) {
      expect.fail('plugin.json does not exist');
      return;
    }
    const raw = readFileSync(CTF_MANIFEST_PATH, 'utf-8');
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      expect.fail(`plugin.json is not valid JSON: ${(e as Error).message}`);
    }
    expect(parsed).toBeDefined();
  });

  it('has required fields: name, version, description, author', () => {
    if (!existsSync(CTF_MANIFEST_PATH)) {
      expect.fail('plugin.json does not exist');
      return;
    }
    const manifest = JSON.parse(readFileSync(CTF_MANIFEST_PATH, 'utf-8'));
    expect(manifest).toHaveProperty('name');
    expect(manifest).toHaveProperty('version');
    expect(manifest).toHaveProperty('description');
    expect(manifest).toHaveProperty('author');
  });

  it('name equals "ctf-benchmark"', () => {
    if (!existsSync(CTF_MANIFEST_PATH)) {
      expect.fail('plugin.json does not exist');
      return;
    }
    const manifest = JSON.parse(readFileSync(CTF_MANIFEST_PATH, 'utf-8'));
    expect(manifest.name).toBe('ctf-benchmark');
  });

  it('version matches the marketplace entry version (if marketplace tracks versions)', () => {
    const marketplace = JSON.parse(readFileSync(MARKETPLACE_JSON, 'utf-8'));
    const entry = marketplace.plugins.find((p: any) => p.name === 'ctf-benchmark');
    if (!entry) {
      expect.fail('ctf-benchmark not found in marketplace.json');
      return;
    }

    // If the marketplace entry has a version field, it must match the manifest
    if (entry.version) {
      if (!existsSync(CTF_MANIFEST_PATH)) {
        expect.fail('plugin.json does not exist');
        return;
      }
      const manifest = JSON.parse(readFileSync(CTF_MANIFEST_PATH, 'utf-8'));
      expect(manifest.version).toBe(entry.version);
    }
  });

  it('references skills that exist on disk', () => {
    if (!existsSync(CTF_MANIFEST_PATH)) {
      expect.fail('plugin.json does not exist');
      return;
    }
    const manifest = JSON.parse(readFileSync(CTF_MANIFEST_PATH, 'utf-8'));
    // Skills may be declared as an array of paths or inferred from skills/ directory
    if (manifest.skills && Array.isArray(manifest.skills)) {
      for (const skillPath of manifest.skills) {
        const resolved = join(CTF_PLUGIN_DIR, skillPath);
        expect(existsSync(resolved)).toBe(true);
      }
    } else {
      // If no explicit skills array, verify the skills/ directory exists
      const skillsDir = join(CTF_PLUGIN_DIR, 'skills');
      expect(existsSync(skillsDir)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Group 3: Skills Validation
// ---------------------------------------------------------------------------
describe('Skills Validation', () => {
  const skillsDir = join(CTF_PLUGIN_DIR, 'skills');

  it('skills directory exists', () => {
    expect(existsSync(skillsDir)).toBe(true);
  });

  it('each skill directory has a SKILL.md', () => {
    if (!existsSync(skillsDir)) {
      expect.fail('skills directory does not exist');
      return;
    }
    const dirs = readdirSync(skillsDir, { withFileTypes: true }).filter(d => d.isDirectory());
    expect(dirs.length).toBeGreaterThan(0);
    for (const d of dirs) {
      const skillMd = join(skillsDir, d.name, 'SKILL.md');
      expect(existsSync(skillMd)).toBe(true);
    }
  });

  it('each SKILL.md starts with valid YAML frontmatter (between --- delimiters)', () => {
    if (!existsSync(skillsDir)) {
      expect.fail('skills directory does not exist');
      return;
    }
    const dirs = readdirSync(skillsDir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const d of dirs) {
      const skillMd = join(skillsDir, d.name, 'SKILL.md');
      if (!existsSync(skillMd)) continue;
      const content = readFileSync(skillMd, 'utf-8');
      expect(content).toMatch(/^---\n[\s\S]*?\n---/);
    }
  });

  it('each SKILL.md frontmatter has name and description fields', () => {
    if (!existsSync(skillsDir)) {
      expect.fail('skills directory does not exist');
      return;
    }
    const dirs = readdirSync(skillsDir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const d of dirs) {
      const skillMd = join(skillsDir, d.name, 'SKILL.md');
      if (!existsSync(skillMd)) continue;
      const content = readFileSync(skillMd, 'utf-8');
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      expect(fmMatch).not.toBeNull();
      const frontmatter = fmMatch![1];
      expect(frontmatter).toMatch(/name:\s+\S+/);
      expect(frontmatter).toMatch(/description:\s+.+/);
    }
  });

  it('no skill names collide with skills in plugins/inerrata/skills/', () => {
    const ctfSkills = getSkillNames(skillsDir);
    const inerataSkillsDir = join(INERRATA_PLUGIN_DIR, 'skills');
    const inerrataSkills = getSkillNames(inerataSkillsDir);
    const inerrataNames = new Set(inerrataSkills.map(s => s.name));

    for (const ctfSkill of ctfSkills) {
      expect(inerrataNames.has(ctfSkill.name)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Group 4: Bridge Skill
// ---------------------------------------------------------------------------
describe('Bridge Skill', () => {
  const bridgePath = join(INERRATA_PLUGIN_DIR, 'skills', 'benchmark', 'SKILL.md');

  it('plugins/inerrata/skills/benchmark/SKILL.md exists', () => {
    expect(existsSync(bridgePath)).toBe(true);
  });

  it('frontmatter name is "benchmark"', () => {
    if (!existsSync(bridgePath)) {
      expect.fail('plugins/inerrata/skills/benchmark/SKILL.md does not exist');
      return;
    }
    const content = readFileSync(bridgePath, 'utf-8');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    expect(fmMatch).not.toBeNull();
    const nameMatch = fmMatch![1].match(/name:\s*(.+)/);
    expect(nameMatch).not.toBeNull();
    expect(nameMatch![1].trim().replace(/^["']|["']$/g, '')).toBe('benchmark');
  });

  it('body references ctf-benchmark (mentions the sibling plugin or its commands)', () => {
    if (!existsSync(bridgePath)) {
      expect.fail('plugins/inerrata/skills/benchmark/SKILL.md does not exist');
      return;
    }
    const content = readFileSync(bridgePath, 'utf-8');
    // Strip frontmatter to get the body
    const body = content.replace(/^---\n[\s\S]*?\n---/, '').trim();
    expect(body.toLowerCase()).toMatch(/ctf[- ]?benchmark/i);
  });
});

// ---------------------------------------------------------------------------
// Group 5: Project Files
// ---------------------------------------------------------------------------
describe('Project Files', () => {
  it('demo/ctf-benchmark/package.json exists and parses', () => {
    const pkgPath = join(CTF_PLUGIN_DIR, 'package.json');
    expect(existsSync(pkgPath)).toBe(true);
    let pkg: any;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    } catch (e) {
      expect.fail(`package.json is not valid JSON: ${(e as Error).message}`);
    }
    expect(pkg).toBeDefined();
  });

  it('package.json has scripts: start, benchmark, dashboard', () => {
    const pkgPath = join(CTF_PLUGIN_DIR, 'package.json');
    if (!existsSync(pkgPath)) {
      expect.fail('demo/ctf-benchmark/package.json does not exist');
      return;
    }
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    expect(pkg).toHaveProperty('scripts');
    expect(pkg.scripts).toHaveProperty('start');
    expect(pkg.scripts).toHaveProperty('benchmark');
    expect(pkg.scripts).toHaveProperty('dashboard');
  });

  it('demo/ctf-benchmark/tsconfig.json exists', () => {
    const tsconfigPath = join(CTF_PLUGIN_DIR, 'tsconfig.json');
    expect(existsSync(tsconfigPath)).toBe(true);
  });

  it('demo/ctf-benchmark/.mcp.json exists and references INERRATA_API_KEY', () => {
    const mcpPath = join(CTF_PLUGIN_DIR, '.mcp.json');
    expect(existsSync(mcpPath)).toBe(true);
    const raw = readFileSync(mcpPath, 'utf-8');
    let mcp: any;
    try {
      mcp = JSON.parse(raw);
    } catch (e) {
      expect.fail(`.mcp.json is not valid JSON: ${(e as Error).message}`);
    }
    expect(raw).toContain('INERRATA_API_KEY');
    // Word-boundary check: INERRATA_API_KEY contains ERRATA_API_KEY as substring,
    // so we check for standalone occurrences (not preceded by 'IN')
    expect(raw).not.toMatch(/(?<![IN])ERRATA_API_KEY/);
  });

  it('demo/ctf-benchmark/.gitignore exists', () => {
    const giPath = join(CTF_PLUGIN_DIR, '.gitignore');
    expect(existsSync(giPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group 6: No Naming Collisions
// ---------------------------------------------------------------------------
describe('No Naming Collisions', () => {
  it('no skill in ctf-benchmark has the same name as a skill in inerrata', () => {
    const ctfSkillsDir = join(CTF_PLUGIN_DIR, 'skills');
    const inerrataSkillsDir = join(INERRATA_PLUGIN_DIR, 'skills');

    const ctfSkills = getSkillNames(ctfSkillsDir);
    const inerrataSkills = getSkillNames(inerrataSkillsDir);

    const inerrataNames = new Set(inerrataSkills.map(s => s.name));
    const collisions: string[] = [];

    for (const ctfSkill of ctfSkills) {
      if (inerrataNames.has(ctfSkill.name)) {
        collisions.push(ctfSkill.name);
      }
    }

    expect(collisions).toEqual([]);
  });

  it('no skill directory in ctf-benchmark has the same directory name as one in inerrata', () => {
    const ctfSkillsDir = join(CTF_PLUGIN_DIR, 'skills');
    const inerrataSkillsDir = join(INERRATA_PLUGIN_DIR, 'skills');

    if (!existsSync(ctfSkillsDir) || !existsSync(inerrataSkillsDir)) {
      expect(existsSync(ctfSkillsDir)).toBe(true);
      return;
    }

    const ctfDirs = readdirSync(ctfSkillsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
    const inerrataDirs = new Set(
      readdirSync(inerrataSkillsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
    );

    const collisions = ctfDirs.filter(d => inerrataDirs.has(d));
    expect(collisions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Group 7: Framing Wave Contract
// ---------------------------------------------------------------------------
describe('CTF Framing Wave Contract', () => {
  it('buildMcpConfig none writes empty mcpServers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ctf-mcp-'));
    try {
      const path = buildMcpConfig({ auth: 'none', resultsDir: dir, agentId: 'none' });
      const config = JSON.parse(readFileSync(path, 'utf-8'));
      expect(config).toEqual({ mcpServers: {} });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('buildMcpConfig anonymous writes URL-only config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ctf-mcp-'));
    try {
      const path = buildMcpConfig({ auth: 'anonymous', resultsDir: dir, agentId: 'anon' });
      const config = JSON.parse(readFileSync(path, 'utf-8'));
      expect(config.mcpServers.inerrata.url).toBe('https://mcp.inerrata.ai/mcp');
      expect(config.mcpServers.inerrata.headers).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('buildMcpConfig authenticated writes bearer header', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ctf-mcp-'));
    try {
      const path = buildMcpConfig({ auth: 'authenticated', apiKey: 'err_test', resultsDir: dir, agentId: 'auth' });
      const config = JSON.parse(readFileSync(path, 'utf-8'));
      expect(config.mcpServers.inerrata.headers.Authorization).toBe('Bearer err_test');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('buildMcpConfig authenticated without apiKey throws', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ctf-mcp-'));
    try {
      expect(() => buildMcpConfig({ auth: 'authenticated', resultsDir: dir, agentId: 'auth' })).toThrow(/apiKey/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('buildSystemPrompt with auth none has no inErrata section', () => {
    const prompt = buildSystemPrompt(EQUALIZATION_WAVES[0]);
    expect(prompt).not.toMatch(/inErrata/i);
    expect(prompt).not.toMatch(/mcp__inerrata__/);
  });

  it('buildSystemPrompt with anonymous includes read-only tool list', () => {
    const prompt = buildSystemPrompt(EQUALIZATION_WAVES[1]);
    expect(prompt).toContain('read-only');
    expect(prompt).toContain('mcp__inerrata__search');
    expect(prompt).toContain('mcp__inerrata__burst');
    expect(prompt).not.toContain('call mcp__inerrata__contribute');
  });

  it('buildSystemPrompt with authenticated includes full behavioral template', () => {
    const prompt = buildSystemPrompt(EQUALIZATION_WAVES[2]);
    expect(prompt).toContain('Knowledge Graph for AI Agents');
    expect(prompt).toContain('mcp__inerrata__contribute');
  });

  it('EQUALIZATION_WAVES runs every model type in each graph tier', () => {
    expect(EQUALIZATION_WAVES.map(w => [w.label, w.model, w.auth, w.runtime])).toEqual([
      ['cold', 'mixed', 'none', 'mixed'],
      ['anonymous', 'mixed', 'anonymous', 'mixed'],
      ['authenticated', 'mixed', 'authenticated', 'mixed'],
    ]);
    expect(EQUALIZATION_WAVES.map(w => w.number)).toEqual([1, 2, 3]);
    for (const wave of EQUALIZATION_WAVES) {
      expect(wave.agents?.map(a => [a.model, a.auth, a.runtime])).toEqual([
        ['opus', wave.auth, 'claude'],
        ['sonnet', wave.auth, 'claude'],
        ['haiku', wave.auth, 'claude'],
        ['qwen2.5-14b', wave.auth, 'ollama'],
      ]);
    }
  });

  it('FUNNEL_WAVES has 3 graph tiers with every model type', () => {
    expect(FUNNEL_WAVES.map(w => w.model)).toEqual(['mixed', 'mixed', 'mixed']);
    expect(FUNNEL_WAVES.map(w => w.auth)).toEqual(['none', 'anonymous', 'authenticated']);
    expect(FUNNEL_WAVES.map(w => w.number)).toEqual([1, 2, 3]);
    for (const wave of FUNNEL_WAVES) {
      expect(wave.agents?.map(a => a.model)).toEqual(['opus', 'sonnet', 'haiku', 'qwen2.5-14b']);
    }
  });
});
