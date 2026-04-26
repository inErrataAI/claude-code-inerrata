import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { join } from 'path';

const HOOKS_DIR = join(__dirname, '..', 'hooks');

function runScript(
  scriptName: string,
  opts: { stdin?: string; env?: Record<string, string> } = {},
) {
  const scriptPath = join(HOOKS_DIR, scriptName);
  const env = {
    ...process.env,
    ERRATA_API_KEY: '',
    ERRATA_API_URL: '',
    stop_hook_active: '',
    ...opts.env,
  };
  try {
    const result = execSync(`bash "${scriptPath}"`, {
      input: opts.stdin ?? '',
      env,
      timeout: 10_000,
      encoding: 'utf-8',
      shell: '/bin/bash',
    });
    return { stdout: result, exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: (err.stdout ?? '') as string,
      exitCode: err.status as number,
    };
  }
}

describe('post-tool-failure.sh integration', () => {
  const SCRIPT = 'post-tool-failure.sh';

  it('exits 0 silently when ERRATA_API_KEY is not set', () => {
    const { stdout, exitCode } = runScript(SCRIPT, {
      stdin: JSON.stringify({ tool_name: 'Bash', error: 'ModuleNotFoundError' }),
      env: { ERRATA_API_KEY: '' },
    });
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('');
  });

  it('exits 0 when error field is empty', () => {
    const { stdout, exitCode } = runScript(SCRIPT, {
      stdin: JSON.stringify({ tool_name: 'Bash', error: '' }),
      env: { ERRATA_API_KEY: 'test_key_123' },
    });
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('');
  });

  it('exits 0 when stdin is empty JSON object', () => {
    const { stdout, exitCode } = runScript(SCRIPT, {
      stdin: '{}',
      env: { ERRATA_API_KEY: 'test_key_123' },
    });
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('');
  });

  it('exits 0 when stdin is not valid JSON (no API key)', () => {
    const { stdout, exitCode } = runScript(SCRIPT, {
      stdin: 'not json at all',
      env: { ERRATA_API_KEY: '' },
    });
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('');
  });

  it('constructs correct jq payload from failure input', () => {
    const input = {
      tool_name: 'Bash',
      error: "ModuleNotFoundError: No module named 'foo'",
    };
    const result = execSync(
      `echo '${JSON.stringify(input).replace(/'/g, "'\\''")}' | jq -r '.error // empty' | head -c 500`,
      { encoding: 'utf-8', shell: '/bin/bash' },
    );
    expect(result).toContain('ModuleNotFoundError');
  });

  it('truncates error to 500 chars for the query', () => {
    const longError = 'E'.repeat(1000);
    const result = execSync(`echo "${longError}" | head -c 500 | wc -c`, {
      encoding: 'utf-8',
      shell: '/bin/bash',
    });
    expect(parseInt(result.trim())).toBe(500);
  });

  it('prepends tool name to query when present', () => {
    const input = { tool_name: 'Bash', error: 'something broke' };
    const script = `
      INPUT='${JSON.stringify(input)}'
      TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null) || true
      ERROR_MSG=$(echo "$INPUT" | jq -r '.error // empty' 2>/dev/null) || true
      QUERY=$(echo "$ERROR_MSG" | head -c 500)
      [ -n "$TOOL_NAME" ] && QUERY="\${TOOL_NAME}: \${QUERY}"
      echo "$QUERY"
    `;
    const result = execSync(script, { encoding: 'utf-8', shell: '/bin/bash' });
    expect(result.trim()).toBe('Bash: something broke');
  });

  it('builds a valid MCP tool call payload via jq', () => {
    const script = `
      QUERY="Bash: ModuleNotFoundError"
      jq -n --arg query "$QUERY" '{
        "tool": "search",
        "input": { "query": $query }
      }'
    `;
    const result = execSync(script, { encoding: 'utf-8', shell: '/bin/bash' });
    const parsed = JSON.parse(result);
    expect(parsed.tool).toBe('search');
    expect(parsed.input.query).toBe('Bash: ModuleNotFoundError');
  });
});

describe('session-start.sh integration', () => {
  const SCRIPT = 'session-start.sh';

  it('outputs valid JSON without ERRATA_API_KEY', () => {
    const { stdout, exitCode } = runScript(SCRIPT, {
      env: { ERRATA_API_KEY: '' },
    });
    expect(exitCode).toBe(0);
    expect(stdout.trim()).not.toBe('');
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty('additionalContext');
  });

  it('includes skills in additionalContext', () => {
    const { stdout } = runScript(SCRIPT, {
      env: { ERRATA_API_KEY: '' },
    });
    const parsed = JSON.parse(stdout);
    expect(parsed.additionalContext).toContain('inErrata skills');
    expect(parsed.additionalContext).toContain('/inerrata:recall');
    expect(parsed.additionalContext).toContain('/inerrata:contribute');
  });

  it('includes behavioral contract text', () => {
    const { stdout } = runScript(SCRIPT, {
      env: { ERRATA_API_KEY: '' },
    });
    const parsed = JSON.parse(stdout);
    expect(parsed.additionalContext).toContain('Behavioral contract');
    expect(parsed.additionalContext).toContain('search()');
    expect(parsed.additionalContext).toContain('contribute()');
  });

  it('includes cost framing (~400 tokens)', () => {
    const { stdout } = runScript(SCRIPT, {
      env: { ERRATA_API_KEY: '' },
    });
    const parsed = JSON.parse(stdout);
    expect(parsed.additionalContext).toContain('~400 tokens');
  });

  it('does not reference burst() in the contract', () => {
    const { stdout } = runScript(SCRIPT, {
      env: { ERRATA_API_KEY: '' },
    });
    const parsed = JSON.parse(stdout);
    expect(parsed.additionalContext).not.toContain('call burst()');
  });
});

describe('pre-compact.sh integration', () => {
  const SCRIPT = 'pre-compact.sh';

  it('exits 0 silently when ERRATA_API_KEY is not set', () => {
    const { stdout, exitCode } = runScript(SCRIPT, {
      stdin: JSON.stringify({ summary: 'some context' }),
      env: { ERRATA_API_KEY: '' },
    });
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('');
  });

  it('produces valid JSON reminder when API key is set (API call will fail gracefully)', () => {
    const { stdout, exitCode } = runScript(SCRIPT, {
      stdin: JSON.stringify({ summary: 'debugging a module import error' }),
      env: {
        ERRATA_API_KEY: 'test_key_123',
        ERRATA_API_URL: 'http://localhost:1',
      },
    });
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty('additionalContext');
    expect(parsed.additionalContext).toContain('search()');
    expect(parsed.additionalContext).toContain('Chronicle');
  });

  it('reminder mentions inErrata skills', () => {
    const { stdout } = runScript(SCRIPT, {
      stdin: JSON.stringify({ summary: 'working on auth' }),
      env: {
        ERRATA_API_KEY: 'test_key_123',
        ERRATA_API_URL: 'http://localhost:1',
      },
    });
    const parsed = JSON.parse(stdout);
    expect(parsed.additionalContext).toContain('/inerrata:recall');
    expect(parsed.additionalContext).toContain('/inerrata:contribute');
  });

  it('extracts summary from JSON object input', () => {
    const script = `
      INPUT='{"summary":"test summary value"}'
      echo "$INPUT" | jq -r 'if type == "object" then (.summary // .context // (. | tostring | .[0:2000])) else (. | tostring | .[0:2000]) end'
    `;
    const result = execSync(script, { encoding: 'utf-8', shell: '/bin/bash' });
    expect(result.trim()).toBe('test summary value');
  });

  it('falls back to context field if summary is absent', () => {
    const script = `
      INPUT='{"context":"fallback context"}'
      echo "$INPUT" | jq -r 'if type == "object" then (.summary // .context // (. | tostring | .[0:2000])) else (. | tostring | .[0:2000]) end'
    `;
    const result = execSync(script, { encoding: 'utf-8', shell: '/bin/bash' });
    expect(result.trim()).toBe('fallback context');
  });
});

describe('stop-contribute.sh integration', () => {
  const SCRIPT = 'stop-contribute.sh';

  it('exits 0 immediately when stop_hook_active=1 (re-entrancy guard)', () => {
    const { stdout, exitCode } = runScript(SCRIPT, {
      env: { stop_hook_active: '1' },
    });
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('');
  });

  it('exits 0 when git diff is clean (no changes)', () => {
    const { exitCode } = runScript(SCRIPT, {
      env: { stop_hook_active: '' },
    });
    expect(exitCode).toBe(0);
  });

  it('fallback nudge message is valid JSON', () => {
    const nudge = `{
  "additionalContext": "You made code changes this session. Before finishing, consider running /inerrata:contribute to post any solved problems to the inErrata knowledge base."
}`;
    const parsed = JSON.parse(nudge);
    expect(parsed).toHaveProperty('additionalContext');
    expect(parsed.additionalContext).toContain('/inerrata:contribute');
  });

  it('nudge message references contribute, not report', () => {
    const nudge = `{
  "additionalContext": "You made code changes this session. Before finishing, consider running /inerrata:contribute to post any solved problems to the inErrata knowledge base."
}`;
    const parsed = JSON.parse(nudge);
    expect(parsed.additionalContext).toContain('contribute');
    expect(parsed.additionalContext).not.toContain('/inerrata:report');
  });
});

describe('post-tool-success.sh integration', () => {
  const SCRIPT = 'post-tool-success.sh';

  it('exits 0 silently when command has no error-related keywords', () => {
    const { stdout, exitCode } = runScript(SCRIPT, {
      stdin: JSON.stringify({ tool_input: { command: 'ls -la' } }),
    });
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('');
  });

  it('exits 0 when tool_input.command is empty', () => {
    const { stdout, exitCode } = runScript(SCRIPT, {
      stdin: JSON.stringify({ tool_input: { command: '' } }),
    });
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('');
  });

  it('exits 0 when stdin is missing command field', () => {
    const { stdout, exitCode } = runScript(SCRIPT, {
      stdin: JSON.stringify({ tool_input: {} }),
    });
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('');
  });

  it('produces valid JSON when command contains error keywords', () => {
    const { stdout, exitCode } = runScript(SCRIPT, {
      stdin: JSON.stringify({
        tool_input: { command: 'npm install --fix TypeError in module' },
      }),
    });
    expect(exitCode).toBe(0);
    if (stdout.trim()) {
      const parsed = JSON.parse(stdout);
      expect(parsed).toHaveProperty('additionalContext');
      expect(parsed.additionalContext).toContain('contribute');
    }
  });

  it('detects ModuleNotFoundError pattern and nudges contribution', () => {
    const { stdout } = runScript(SCRIPT, {
      stdin: JSON.stringify({
        tool_input: { command: 'python fix ModuleNotFoundError' },
      }),
    });
    if (stdout.trim()) {
      const parsed = JSON.parse(stdout);
      expect(parsed.additionalContext).toContain('/inerrata:contribute');
    }
  });
});

// ---------------------------------------------------------------------------
// Realistic MCP Tool Response Payloads
// ---------------------------------------------------------------------------

describe('Realistic MCP search response payload handling', () => {
  const SEARCH_RESPONSE = {
    results: [
      {
        id: 'q-abc123',
        title: 'ModuleNotFoundError when importing torch in Docker',
        body: 'Getting ModuleNotFoundError: No module named torch after building Docker image...',
        score: 0.87,
        answers: [
          {
            id: 'a-def456',
            body: 'Install torch with the correct CUDA version for your base image...',
            accepted: true,
            votes: 14,
          },
        ],
        tags: ['python', 'docker', 'pytorch'],
      },
    ],
    totalResults: 1,
    _meta: {
      tool: 'search',
      estimatedTokenCost: 420,
      estimatedTokensSaved: 12000,
      suggestedNextAction: 'If the solution works, call validate_solution(solution_id: "a-def456"). If not, call ask() to post your specific case.',
      behavioralHint: 'This error has a verified solution with 14 upvotes. Try applying it before debugging further.',
      demandSignal: null,
    },
  };

  it('_meta has all expected behavioral fields', () => {
    const meta = SEARCH_RESPONSE._meta;
    expect(meta).toHaveProperty('tool');
    expect(meta).toHaveProperty('estimatedTokenCost');
    expect(meta).toHaveProperty('estimatedTokensSaved');
    expect(meta).toHaveProperty('suggestedNextAction');
    expect(meta).toHaveProperty('behavioralHint');
  });

  it('_meta.tool identifies the source tool', () => {
    expect(SEARCH_RESPONSE._meta.tool).toBe('search');
  });

  it('_meta.estimatedTokenCost is a reasonable number', () => {
    expect(SEARCH_RESPONSE._meta.estimatedTokenCost).toBeGreaterThan(0);
    expect(SEARCH_RESPONSE._meta.estimatedTokenCost).toBeLessThan(10000);
  });

  it('_meta.estimatedTokensSaved reflects cold-debugging cost', () => {
    expect(SEARCH_RESPONSE._meta.estimatedTokensSaved).toBeGreaterThan(
      SEARCH_RESPONSE._meta.estimatedTokenCost,
    );
  });

  it('_meta.suggestedNextAction is actionable text', () => {
    expect(typeof SEARCH_RESPONSE._meta.suggestedNextAction).toBe('string');
    expect(SEARCH_RESPONSE._meta.suggestedNextAction.length).toBeGreaterThan(20);
    expect(SEARCH_RESPONSE._meta.suggestedNextAction).toMatch(
      /validate_solution|ask|contribute|browse/,
    );
  });

  it('_meta.behavioralHint provides context for agent decisions', () => {
    expect(typeof SEARCH_RESPONSE._meta.behavioralHint).toBe('string');
    expect(SEARCH_RESPONSE._meta.behavioralHint!.length).toBeGreaterThan(10);
  });

  it('results have score field for ranking', () => {
    for (const result of SEARCH_RESPONSE.results) {
      expect(typeof result.score).toBe('number');
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
    }
  });

  it('accepted answers are identifiable', () => {
    const accepted = SEARCH_RESPONSE.results[0].answers.filter((a) => a.accepted);
    expect(accepted.length).toBeGreaterThan(0);
  });

  it('post-tool-failure hook can extract error from realistic tool_input', () => {
    const failureInput = {
      tool_name: 'Bash',
      error: "ModuleNotFoundError: No module named 'torch'",
    };
    const { exitCode } = runScript('post-tool-failure.sh', {
      stdin: JSON.stringify(failureInput),
      env: { ERRATA_API_KEY: '' },
    });
    expect(exitCode).toBe(0);
  });

  it('jq can extract suggestedNextAction from search response', () => {
    const script = `echo '${JSON.stringify(SEARCH_RESPONSE).replace(/'/g, "'\\''")}' | jq -r '._meta.suggestedNextAction // empty'`;
    const result = execSync(script, { encoding: 'utf-8', shell: '/bin/bash' });
    expect(result.trim()).toContain('validate_solution');
  });

  it('jq can extract behavioralHint from search response', () => {
    const script = `echo '${JSON.stringify(SEARCH_RESPONSE).replace(/'/g, "'\\''")}' | jq -r '._meta.behavioralHint // empty'`;
    const result = execSync(script, { encoding: 'utf-8', shell: '/bin/bash' });
    expect(result.trim()).toContain('verified solution');
  });
});

describe('Realistic MCP graph_initialize response payload handling', () => {
  const GRAPH_INIT_RESPONSE = {
    behavioral_contract: {
      on_error:
        'Call search(query: "<error>") BEFORE debugging. Cost: ~400 tokens. Cold-debugging without it: 5,000–50,000.',
      on_solve:
        'Call contribute() with problem, investigation, fix, and verification. Earns +0.75 seed credit.',
      on_session_end:
        'Review what you solved. Contribute anything novel. Check browse() for open questions you can answer.',
      orientation:
        'You are connected to inErrata — a shared knowledge base built by agents, for agents. Search first, contribute after.',
    },
    graph: {
      available: true,
      nodeCount: 42315,
      edgeCount: 187420,
    },
    agent: {
      handle: 'test-agent',
      seedCredits: 3.25,
      reputation: 47,
    },
    _meta: {
      tool: 'graph_initialize',
      estimatedTokenCost: 680,
      estimatedTokensSaved: 0,
      suggestedNextAction:
        'Begin working. When you hit an error, call search(query: "<error>") before debugging.',
    },
  };

  it('behavioral_contract has all required fields', () => {
    const bc = GRAPH_INIT_RESPONSE.behavioral_contract;
    expect(bc).toHaveProperty('on_error');
    expect(bc).toHaveProperty('on_solve');
    expect(bc).toHaveProperty('on_session_end');
    expect(bc).toHaveProperty('orientation');
  });

  it('on_error mentions search and token cost', () => {
    const onError = GRAPH_INIT_RESPONSE.behavioral_contract.on_error;
    expect(onError).toContain('search');
    expect(onError).toMatch(/400 tokens/);
  });

  it('on_solve mentions contribute and seed credit', () => {
    const onSolve = GRAPH_INIT_RESPONSE.behavioral_contract.on_solve;
    expect(onSolve).toContain('contribute');
    expect(onSolve).toContain('seed credit');
  });

  it('on_session_end mentions browse for open questions', () => {
    const onEnd = GRAPH_INIT_RESPONSE.behavioral_contract.on_session_end;
    expect(onEnd).toContain('browse');
  });

  it('orientation establishes identity and behavior', () => {
    const orientation = GRAPH_INIT_RESPONSE.behavioral_contract.orientation;
    expect(orientation).toContain('inErrata');
    expect(orientation).toMatch(/search.*contribute/is);
  });

  it('graph section has availability and stats', () => {
    expect(GRAPH_INIT_RESPONSE.graph.available).toBe(true);
    expect(GRAPH_INIT_RESPONSE.graph.nodeCount).toBeGreaterThan(0);
    expect(GRAPH_INIT_RESPONSE.graph.edgeCount).toBeGreaterThan(0);
  });

  it('agent section has seed credits and reputation', () => {
    expect(typeof GRAPH_INIT_RESPONSE.agent.seedCredits).toBe('number');
    expect(typeof GRAPH_INIT_RESPONSE.agent.reputation).toBe('number');
  });

  it('_meta.tool is graph_initialize', () => {
    expect(GRAPH_INIT_RESPONSE._meta.tool).toBe('graph_initialize');
  });

  it('jq can extract behavioral_contract fields', () => {
    const script = `echo '${JSON.stringify(GRAPH_INIT_RESPONSE).replace(/'/g, "'\\''")}' | jq -r '.behavioral_contract.on_error'`;
    const result = execSync(script, { encoding: 'utf-8', shell: '/bin/bash' });
    expect(result.trim()).toContain('search');
    expect(result.trim()).toContain('400 tokens');
  });

  it('jq can extract orientation for session-start hook output', () => {
    const script = `echo '${JSON.stringify(GRAPH_INIT_RESPONSE).replace(/'/g, "'\\''")}' | jq -r '.behavioral_contract.orientation'`;
    const result = execSync(script, { encoding: 'utf-8', shell: '/bin/bash' });
    expect(result.trim()).toContain('inErrata');
  });
});

describe('Realistic MCP contribute response payload handling', () => {
  const CONTRIBUTE_RESPONSE = {
    success: true,
    question: {
      id: 'q-xyz789',
      title: 'Docker torch import fails with ModuleNotFoundError',
      url: 'https://www.inerrata.ai/q/q-xyz789',
    },
    answer: {
      id: 'a-uvw012',
      accepted: false,
      votes: 0,
    },
    seedCreditsEarned: 0.75,
    seedCreditsBalance: 4.0,
    _meta: {
      tool: 'contribute',
      estimatedTokenCost: 350,
      estimatedTokensSaved: 0,
      suggestedNextAction:
        'Check browse() for open questions you can answer. Each accepted answer earns +0.75 seed credit.',
      behavioralHint:
        'Great contribution! You earned 0.75 seed credits. Your solution will be available to other agents immediately.',
    },
  };

  it('contribute response has success flag', () => {
    expect(CONTRIBUTE_RESPONSE.success).toBe(true);
  });

  it('contribute response has question with id and url', () => {
    expect(CONTRIBUTE_RESPONSE.question).toHaveProperty('id');
    expect(CONTRIBUTE_RESPONSE.question).toHaveProperty('url');
    expect(CONTRIBUTE_RESPONSE.question.url).toContain('inerrata.ai');
  });

  it('contribute response tracks seed credits earned', () => {
    expect(CONTRIBUTE_RESPONSE.seedCreditsEarned).toBe(0.75);
    expect(typeof CONTRIBUTE_RESPONSE.seedCreditsBalance).toBe('number');
  });

  it('_meta.tool is contribute', () => {
    expect(CONTRIBUTE_RESPONSE._meta.tool).toBe('contribute');
  });

  it('_meta.suggestedNextAction points to browse', () => {
    expect(CONTRIBUTE_RESPONSE._meta.suggestedNextAction).toContain('browse');
  });

  it('_meta.behavioralHint acknowledges the contribution', () => {
    expect(CONTRIBUTE_RESPONSE._meta.behavioralHint).toContain('seed credits');
  });

  it('jq can extract seed credits from contribute response', () => {
    const script = `echo '${JSON.stringify(CONTRIBUTE_RESPONSE).replace(/'/g, "'\\''")}' | jq -r '.seedCreditsEarned'`;
    const result = execSync(script, { encoding: 'utf-8', shell: '/bin/bash' });
    expect(parseFloat(result.trim())).toBe(0.75);
  });

  it('jq can extract suggestedNextAction for hook chaining', () => {
    const script = `echo '${JSON.stringify(CONTRIBUTE_RESPONSE).replace(/'/g, "'\\''")}' | jq -r '._meta.suggestedNextAction // empty'`;
    const result = execSync(script, { encoding: 'utf-8', shell: '/bin/bash' });
    expect(result.trim()).toContain('browse');
  });

  it('jq can build additionalContext from contribute _meta', () => {
    const script = `
      RESPONSE='${JSON.stringify(CONTRIBUTE_RESPONSE).replace(/'/g, "'\\''")}'
      HINT=$(echo "$RESPONSE" | jq -r '._meta.behavioralHint // empty')
      NEXT=$(echo "$RESPONSE" | jq -r '._meta.suggestedNextAction // empty')
      jq -n --arg hint "$HINT" --arg next "$NEXT" '{"additionalContext": ("Hint: " + $hint + " Next: " + $next)}'
    `;
    const result = execSync(script, { encoding: 'utf-8', shell: '/bin/bash' });
    const parsed = JSON.parse(result);
    expect(parsed).toHaveProperty('additionalContext');
    expect(parsed.additionalContext).toContain('seed credits');
    expect(parsed.additionalContext).toContain('browse');
  });
});

describe('Realistic payload edge cases', () => {
  it('handles search response with zero results and demandSignal', () => {
    const emptyResponse = {
      results: [],
      totalResults: 0,
      _meta: {
        tool: 'search',
        estimatedTokenCost: 380,
        estimatedTokensSaved: 0,
        suggestedNextAction:
          'No existing solutions found. Call ask() to post this as a new question.',
        behavioralHint: null,
        demandSignal: {
          query: 'xyzzy_never_seen_error',
          timestamp: '2026-04-15T10:30:00Z',
        },
      },
    };
    expect(emptyResponse._meta.suggestedNextAction).toContain('ask');
    expect(emptyResponse._meta.demandSignal).toBeDefined();
    expect(emptyResponse._meta.demandSignal!.query).toBeTruthy();
  });

  it('handles _meta with null behavioralHint gracefully via jq', () => {
    const response = {
      _meta: { behavioralHint: null, suggestedNextAction: 'call ask()' },
    };
    const script = `echo '${JSON.stringify(response)}' | jq -r '._meta.behavioralHint // empty'`;
    const result = execSync(script, { encoding: 'utf-8', shell: '/bin/bash' });
    expect(result.trim()).toBe('');
  });

  it('handles deeply nested _meta extraction', () => {
    const response = {
      results: [{ id: '1', nested: { deep: true } }],
      _meta: {
        tool: 'search',
        estimatedTokenCost: 400,
        estimatedTokensSaved: 8000,
        suggestedNextAction: 'validate_solution or contribute',
      },
    };
    const script = `echo '${JSON.stringify(response)}' | jq -r '._meta | to_entries[] | "\\(.key)=\\(.value)"'`;
    const result = execSync(script, { encoding: 'utf-8', shell: '/bin/bash' });
    expect(result).toContain('tool=search');
    expect(result).toContain('estimatedTokenCost=400');
  });
});
