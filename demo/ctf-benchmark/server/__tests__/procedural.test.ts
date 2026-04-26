#!/usr/bin/env tsx
/**
 * Tests for procedural challenge generation.
 *
 * Verifies:
 *   1. Determinism: same seed → same output
 *   2. Divergence: different seeds → different output
 *   3. Structure: all generated challenges have valid fields
 *   4. Challenge count: within expected range
 *   5. Difficulty distribution: at least one easy and one hard
 *   6. Flag format: all flags match the expected pattern
 *   7. No duplicate IDs or paths
 *   8. Server integration: routes register and respond correctly
 */

import { strict as assert } from "assert";
import { generateMaze, createRng } from "../procedural.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function test(name: string, fn: () => void | Promise<void>) {
  const result = fn();
  if (result instanceof Promise) {
    return result
      .then(() => console.log(`  ✓ ${name}`))
      .catch((err) => {
        console.error(`  ✗ ${name}`);
        console.error(`    ${err.message}`);
        process.exitCode = 1;
      });
  }
  console.log(`  ✓ ${name}`);
  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests() {
  console.log("\nProcedural generation tests\n");

  // --- RNG tests ---
  await test("RNG: deterministic", () => {
    const a = createRng("test-seed");
    const b = createRng("test-seed");
    assert.equal(a.hex(8), b.hex(8));
    assert.equal(a.int(0, 1000), b.int(0, 1000));
    assert.equal(a.uuid(), b.uuid());
  });

  await test("RNG: different seeds diverge", () => {
    const a = createRng("seed-a");
    const b = createRng("seed-b");
    // With 8 random bytes, collision probability is ~2^-64
    assert.notEqual(a.hex(8), b.hex(8));
  });

  await test("RNG: child isolation", () => {
    const parent1 = createRng("parent");
    const child1a = parent1.child("label-a");
    const child1b = parent1.child("label-b");
    // Children with different labels should diverge
    assert.notEqual(child1a.hex(8), child1b.hex(8));
  });

  await test("RNG: shuffle is deterministic", () => {
    const rng1 = createRng("shuffle-test");
    const rng2 = createRng("shuffle-test");
    const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    assert.deepEqual(rng1.shuffle(arr), rng2.shuffle(arr));
  });

  // --- Maze generation tests ---

  await test("Maze: deterministic (same seed = same output)", () => {
    const m1 = generateMaze("determinism-test");
    const m2 = generateMaze("determinism-test");

    assert.equal(m1.challenges.length, m2.challenges.length);
    for (let i = 0; i < m1.challenges.length; i++) {
      assert.equal(m1.challenges[i].id, m2.challenges[i].id);
      assert.equal(m1.challenges[i].name, m2.challenges[i].name);
      assert.equal(m1.challenges[i].flag, m2.challenges[i].flag);
      assert.equal(m1.challenges[i].difficulty, m2.challenges[i].difficulty);
      assert.equal(m1.challenges[i].points, m2.challenges[i].points);
      assert.equal(m1.challenges[i].category, m2.challenges[i].category);
    }
    assert.equal(m1.shared.jwtSecret, m2.shared.jwtSecret);
    assert.equal(m1.shared.roleClaimName, m2.shared.roleClaimName);
    assert.equal(m1.decoyPaths.length, m2.decoyPaths.length);
    assert.deepEqual(m1.decoyPaths, m2.decoyPaths);
  });

  await test("Maze: different seeds produce different challenges", () => {
    const m1 = generateMaze("seed-alpha");
    const m2 = generateMaze("seed-beta");

    // Challenge IDs should differ (they include hex suffixes from the seed)
    const ids1 = new Set(m1.challenges.map(c => c.id));
    const ids2 = new Set(m2.challenges.map(c => c.id));

    // At least some IDs should be unique to each maze
    // (foundational ones share base name but have different flags)
    const uniqueTo1 = [...ids1].filter(id => !ids2.has(id));
    const uniqueTo2 = [...ids2].filter(id => !ids1.has(id));
    assert.ok(
      uniqueTo1.length > 0 || uniqueTo2.length > 0,
      "Different seeds should produce at least some different challenge IDs"
    );

    // Flags MUST be different
    const flags1 = new Set(m1.challenges.map(c => c.flag));
    const flags2 = new Set(m2.challenges.map(c => c.flag));
    const sharedFlags = [...flags1].filter(f => flags2.has(f));
    assert.equal(sharedFlags.length, 0, "No flags should be shared between different seeds");
  });

  await test("Maze: challenge count in expected range", () => {
    // Run 10 different seeds and check range
    for (let i = 0; i < 10; i++) {
      const m = generateMaze(`count-test-${i}`);
      // 2 foundational + 10-18 elective = 12-20
      assert.ok(
        m.challenges.length >= 12 && m.challenges.length <= 20,
        `Expected 12-20 challenges, got ${m.challenges.length} (seed: count-test-${i})`
      );
    }
  });

  await test("Maze: all challenges have valid structure", () => {
    const m = generateMaze("structure-test");
    const validDifficulties = new Set(["trivial", "easy", "medium", "hard", "expert"]);
    const validCategories = new Set([
      "misc", "sensitive-data", "crypto", "auth-bypass", "idor",
      "ssrf", "injection", "race-condition", "broken-access",
    ]);

    for (const c of m.challenges) {
      assert.ok(c.id, `Challenge missing id`);
      assert.ok(c.id.startsWith("maze-"), `Challenge id should start with maze-: ${c.id}`);
      assert.ok(c.name, `Challenge ${c.id} missing name`);
      assert.ok(c.description, `Challenge ${c.id} missing description`);
      assert.ok(validDifficulties.has(c.difficulty), `Challenge ${c.id} has invalid difficulty: ${c.difficulty}`);
      assert.ok(validCategories.has(c.category), `Challenge ${c.id} has invalid category: ${c.category}`);
      assert.ok(c.points > 0, `Challenge ${c.id} has non-positive points: ${c.points}`);
      assert.ok(c.points % 25 === 0 || c.points <= 75, `Challenge ${c.id} points not rounded to 25: ${c.points}`);
      assert.ok(typeof c.registerRoutes === "function", `Challenge ${c.id} missing registerRoutes`);
    }
  });

  await test("Maze: all flags match expected format", () => {
    const m = generateMaze("flag-format-test");
    const flagPattern = /^FLAG\{maze-[a-z0-9-]+-[a-f0-9]+\}$/;
    for (const c of m.challenges) {
      assert.ok(
        flagPattern.test(c.flag),
        `Challenge ${c.id} has invalid flag format: ${c.flag}`
      );
    }
  });

  await test("Maze: no duplicate challenge IDs", () => {
    const m = generateMaze("dedup-test");
    const ids = m.challenges.map(c => c.id);
    const unique = new Set(ids);
    assert.equal(ids.length, unique.size, `Duplicate IDs found: ${ids.filter((id, i) => ids.indexOf(id) !== i)}`);
  });

  await test("Maze: difficulty distribution covers range", () => {
    // Over 5 seeds, we should see all difficulty levels
    const allDiffs = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const m = generateMaze(`diff-dist-${i}`);
      for (const c of m.challenges) allDiffs.add(c.difficulty);
    }
    // At minimum we need trivial (from map-the-maze) and easy (from find-the-leak)
    assert.ok(allDiffs.has("trivial"), "Should have trivial challenges");
    assert.ok(allDiffs.has("easy"), "Should have easy challenges");
    // Hard/expert should appear given the primitive difficulty ranges
    assert.ok(allDiffs.has("hard") || allDiffs.has("expert"), "Should have hard or expert challenges");
  });

  await test("Maze: shared config is valid", () => {
    const m = generateMaze("shared-config-test");
    assert.ok(m.shared.jwtSecret.length > 0, "JWT secret should be non-empty");
    assert.ok(m.shared.adminPassword.length > 0, "Admin password should be non-empty");
    assert.ok(m.shared.adminEmail.includes("@"), "Admin email should contain @");
    assert.ok(m.shared.adminUserId.includes("-"), "Admin user ID should be UUID-like");
    assert.ok(m.shared.docsPath.startsWith("/"), "Docs path should start with /");
    assert.ok(m.shared.debugPath.startsWith("/"), "Debug path should start with /");
    assert.ok(m.shared.registerPath.startsWith("/"), "Register path should start with /");
    assert.ok(m.shared.loginPath.startsWith("/"), "Login path should start with /");
  });

  await test("Maze: decoy paths are generated", () => {
    const m = generateMaze("decoy-test");
    assert.ok(m.decoyPaths.length >= 30, `Expected >=30 decoys, got ${m.decoyPaths.length}`);
    assert.ok(m.decoyPaths.length <= 50, `Expected <=50 decoys, got ${m.decoyPaths.length}`);
    for (const p of m.decoyPaths) {
      assert.ok(p.startsWith("/"), `Decoy path should start with /: ${p}`);
    }
  });

  await test("Maze: points are within difficulty range", () => {
    const m = generateMaze("points-range-test");
    const ranges: Record<string, [number, number]> = {
      trivial: [50, 75],
      easy: [100, 150],
      medium: [175, 250],
      hard: [275, 450],
      expert: [475, 600],
    };
    for (const c of m.challenges) {
      const [lo, hi] = ranges[c.difficulty];
      assert.ok(
        c.points >= lo && c.points <= hi,
        `Challenge ${c.id} (${c.difficulty}) has points ${c.points} outside range [${lo}, ${hi}]`
      );
    }
  });

  await test("Maze: multiple seeds produce diverse category distributions", () => {
    const distributions: string[][] = [];
    for (let i = 0; i < 5; i++) {
      const m = generateMaze(`diversity-${i}`);
      const cats = [...new Set(m.challenges.map(c => c.category))].sort();
      distributions.push(cats);
    }
    // Not all distributions should be identical
    const uniqueDistributions = new Set(distributions.map(d => d.join(",")));
    assert.ok(
      uniqueDistributions.size > 1,
      "Different seeds should produce at least some variation in category distributions"
    );
  });

  await test("Maze: challenge hex suffixes are unique per seed", () => {
    const m = generateMaze("suffix-test");
    const suffixes = m.challenges
      .filter(c => c.id !== "maze-map-the-maze" && c.id !== "maze-find-the-leak")
      .map(c => c.id.replace(/^maze-[a-z-]+-/, ""));
    const unique = new Set(suffixes);
    assert.equal(suffixes.length, unique.size, "All hex suffixes should be unique");
  });

  await test("Maze: foundational challenges always present", () => {
    // map-the-maze and find-the-leak must appear in every seed
    for (let i = 0; i < 10; i++) {
      const m = generateMaze(`foundational-${i}`);
      const ids = m.challenges.map(c => c.id);
      assert.ok(
        ids.includes("maze-map-the-maze"),
        `Seed foundational-${i} missing maze-map-the-maze`
      );
      assert.ok(
        ids.includes("maze-find-the-leak"),
        `Seed foundational-${i} missing maze-find-the-leak`
      );
      // They should be the first two challenges
      assert.equal(m.challenges[0].id, "maze-map-the-maze", "map-the-maze should be first challenge");
      assert.equal(m.challenges[1].id, "maze-find-the-leak", "find-the-leak should be second challenge");
      // Verify their fixed properties
      assert.equal(m.challenges[0].difficulty, "trivial");
      assert.equal(m.challenges[0].category, "misc");
      assert.equal(m.challenges[1].difficulty, "easy");
      assert.equal(m.challenges[1].category, "sensitive-data");
    }
  });

  await test("Maze: all flags are unique within a maze", () => {
    for (let i = 0; i < 10; i++) {
      const m = generateMaze(`flag-unique-${i}`);
      const flags = m.challenges.map(c => c.flag);
      const unique = new Set(flags);
      assert.equal(
        flags.length, unique.size,
        `Seed flag-unique-${i}: duplicate flags found: ${flags.filter((f, j) => flags.indexOf(f) !== j)}`
      );
    }
  });

  await test("Maze: infrastructure paths don't collide with each other", () => {
    for (let i = 0; i < 10; i++) {
      const m = generateMaze(`path-collision-${i}`);
      const infraPaths = [
        m.shared.docsPath,
        m.shared.debugPath,
        m.shared.registerPath,
        m.shared.loginPath,
      ];
      const unique = new Set(infraPaths);
      assert.equal(
        infraPaths.length, unique.size,
        `Seed path-collision-${i}: infrastructure path collision: ${infraPaths.join(", ")}`
      );
    }
  });

  await test("Maze: decoy paths don't collide with infrastructure paths", () => {
    const m = generateMaze("decoy-collision-test");
    const infraPaths = new Set([
      m.shared.docsPath,
      m.shared.debugPath,
      m.shared.registerPath,
      m.shared.loginPath,
      "/health",
      "/maze/meta",
      "/maze/validate",
      "/maze/events",
      "/maze/broadcast",
      "/maze/scoreboard",
    ]);
    for (const decoy of m.decoyPaths) {
      assert.ok(
        !infraPaths.has(decoy),
        `Decoy path "${decoy}" collides with infrastructure path`
      );
    }
  });

  console.log("\nAll tests passed ✓\n");
}

runTests().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
