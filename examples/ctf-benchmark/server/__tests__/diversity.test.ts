#!/usr/bin/env tsx
/**
 * Diversity tests: verify that different seeds produce genuinely different
 * challenge rosters. Uses assertions — exits non-zero on failure.
 */
import { strict as assert } from "assert";
import { generateMaze } from "../procedural.js";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    process.exitCode = 1;
  }
}

console.log("\nDiversity tests\n");

const seeds = ["alpha", "beta", "gamma", "delta", "epsilon"];

// Print diagnostic output
for (const seed of seeds) {
  const m = generateMaze(seed);
  const ids = m.challenges.map(c => c.id.replace(/^maze-/, "").replace(/-[a-f0-9]{6}$/, "")).sort();
  const cats = [...new Set(m.challenges.map(c => c.category))].sort();
  console.log(`  Seed "${seed}" (${m.challenges.length} challenges):`);
  console.log(`    Types: ${ids.join(", ")}`);
  console.log(`    Categories: ${cats.join(", ")}`);
  console.log(`    Total points: ${m.challenges.reduce((s, c) => s + c.points, 0)}`);
}

console.log("");

// -- Assertions ---

test("All seeds produce unique challenge type sets (excluding foundationals)", () => {
  const typeSets = seeds.map(seed => {
    const m = generateMaze(seed);
    return m.challenges
      .filter(c => c.id !== "maze-map-the-maze" && c.id !== "maze-find-the-leak")
      .map(c => c.id.replace(/^maze-/, "").replace(/-[a-f0-9]{6}$/, ""))
      .sort()
      .join(",");
  });
  const uniqueSets = new Set(typeSets);
  assert.equal(
    uniqueSets.size, seeds.length,
    `Expected ${seeds.length} unique type sets, got ${uniqueSets.size}. Seeds producing identical rosters should be investigated.`
  );
});

test("All seeds produce unique flag sets", () => {
  const allFlags = new Set<string>();
  for (const seed of seeds) {
    const m = generateMaze(seed);
    for (const c of m.challenges) {
      assert.ok(
        !allFlags.has(c.flag),
        `Flag collision across seeds: ${c.flag} (seed: ${seed}, challenge: ${c.id})`
      );
      allFlags.add(c.flag);
    }
  }
});

test("Challenge counts vary across seeds", () => {
  const counts = seeds.map(seed => generateMaze(seed).challenges.length);
  const uniqueCounts = new Set(counts);
  // With 5 seeds and range 12-20, we should see at least 2 different counts
  assert.ok(
    uniqueCounts.size >= 2,
    `Expected at least 2 different challenge counts, got ${uniqueCounts.size}: [${counts.join(", ")}]`
  );
});

test("Category distributions vary across seeds", () => {
  const distributions = seeds.map(seed => {
    const m = generateMaze(seed);
    return [...new Set(m.challenges.map(c => c.category))].sort().join(",");
  });
  const unique = new Set(distributions);
  assert.ok(
    unique.size >= 2,
    `Expected at least 2 different category distributions, got ${unique.size}`
  );
});

test("Total points vary across seeds", () => {
  const points = seeds.map(seed =>
    generateMaze(seed).challenges.reduce((s, c) => s + c.points, 0)
  );
  const unique = new Set(points);
  assert.ok(
    unique.size >= 2,
    `Expected at least 2 different point totals, got ${unique.size}: [${points.join(", ")}]`
  );
});

console.log("\nAll diversity tests passed ✓\n");
