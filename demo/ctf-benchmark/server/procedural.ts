/**
 * server/procedural.ts — Fully procedural challenge generation from a seed.
 *
 * This module replaces the hardcoded VULNERABILITY_POOL with a compositional
 * grammar that generates unique challenge types at runtime. The same seed
 * always produces the same challenge set; different seeds produce
 * fundamentally different vulnerability patterns.
 *
 * Architecture:
 *   1. Atomic building blocks:
 *      - VulnPrimitives: the core vulnerability mechanic (what's exploitable)
 *      - InjectionSurfaces: where the input enters (query, header, body, path, cookie)
 *      - ProtectionLayers: what defenses exist (none, weak filter, allowlist, etc.)
 *      - ValidationMethods: how the flag is revealed (response body, header, timing, etc.)
 *      - PayloadShapes: the structure of the attack input
 *
 *   2. Composition engine: seeded RNG selects and combines these atoms into
 *      unique ChallengeBlueprint objects, each with generated route handlers
 *      and validation logic.
 *
 *   3. The output is an array of ChallengeBlueprint objects that maze.ts
 *      registers as Hono routes, identical in shape to the old templates.
 *
 * Design principles:
 *   - No challenge type is "built-in" — everything is composed from atoms
 *   - Atoms can combine in ways we didn't explicitly anticipate
 *   - The grammar is large enough that brute-force memorization is impractical
 *   - Difficulty emerges from composition depth (more layers = harder)
 */

import { createHash, createHmac, randomBytes } from "crypto";
import type { Hono } from "hono";

// ---------------------------------------------------------------------------
// Seeded RNG (same as maze.ts — duplicated to keep module self-contained)
// ---------------------------------------------------------------------------

export interface Rng {
  hex(n: number): string;
  int(min: number, max: number): number;
  float(): number;
  pick<T>(arr: readonly T[]): T;
  shuffle<T>(arr: readonly T[]): T[];
  uuid(): string;
  sample<T>(arr: readonly T[], n: number): T[];
  child(label: string): Rng;
}

export function createRng(seed: string): Rng {
  let state = createHash("sha256").update(seed).digest();
  let offset = 0;

  function nextBytes(n: number): Buffer {
    const chunks: Buffer[] = [];
    let remaining = n;
    while (remaining > 0) {
      if (offset >= state.length) {
        state = createHash("sha256").update(state).digest();
        offset = 0;
      }
      const take = Math.min(remaining, state.length - offset);
      chunks.push(state.subarray(offset, offset + take));
      offset += take;
      remaining -= take;
    }
    return Buffer.concat(chunks);
  }

  return {
    hex(n: number): string { return nextBytes(n).toString("hex"); },
    int(min: number, max: number): number {
      const range = max - min + 1;
      return min + (nextBytes(4).readUInt32BE(0) % range);
    },
    float(): number { return nextBytes(4).readUInt32BE(0) / 0x100000000; },
    pick<T>(arr: readonly T[]): T { return arr[this.int(0, arr.length - 1)]; },
    shuffle<T>(arr: readonly T[]): T[] {
      const a = [...arr];
      for (let i = a.length - 1; i > 0; i--) {
        const j = this.int(0, i);
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
    uuid(): string {
      const h = this.hex(16);
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
    },
    sample<T>(arr: readonly T[], n: number): T[] {
      return this.shuffle(arr).slice(0, Math.min(n, arr.length));
    },
    /** Create a child RNG with a derived seed (for isolation). */
    child(label: string): Rng {
      const childSeed = createHash("sha256")
        .update(nextBytes(32))
        .update(label)
        .digest("hex");
      return createRng(childSeed);
    },
  };
}

// ---------------------------------------------------------------------------
// Shared types (aligned with maze.ts)
// ---------------------------------------------------------------------------

export type Difficulty = "trivial" | "easy" | "medium" | "hard" | "expert";

export interface ChallengeBlueprint {
  id: string;
  name: string;
  description: string;
  category: string;
  difficulty: Difficulty;
  points: number;
  flag: string;
  /** Opaque config bag for the route registrar. */
  config: Record<string, unknown>;
  /** Register Hono routes. Called once during app setup. */
  registerRoutes: (app: Hono, shared: SharedConfig, state: SharedState) => void;
}

export interface SharedConfig {
  jwtSecret: string;
  adminPassword: string;
  adminEmail: string;
  adminUserId: string;
  roleClaimName: string;
  serviceKey: string;
  docsPath: string;
  debugPath: string;
  registerPath: string;
  loginPath: string;
}

export interface SharedState {
  users: Map<string, UserRecord>;
  shortUrls: Map<string, { id: string; url: string }>;
  tempTokens: Map<string, { token: string; userId: string; createdAt: number }>;
  resetTokenCounter: { value: number };
  rateLimitMap: Map<string, { count: number; resetAt: number }>;
  orderStates: Map<string, string>;
  appliedCoupons: Map<string, Set<string>>;
  userCallbacks: Map<string, string>;
  userPrefsStore: Map<string, Record<string, unknown>>;
  kvStore: Map<string, unknown>;
  getBearer: (c: HonoCtx) => Record<string, unknown> | null;
  getBearerFlawed: (c: HonoCtx) => Record<string, unknown> | null;
}

export interface UserRecord {
  id: string;
  email: string;
  password: string;
  role: string;
  secretNote?: string;
  tenantId: string;
  [key: string]: unknown;
}

type HonoCtx = { req: { header: (n: string) => string | undefined; query: (n: string) => string | undefined; param: (n: string) => string | undefined; json: () => Promise<any>; text: () => Promise<string>; url: string; path: string; arrayBuffer: () => Promise<ArrayBuffer>; method: string } };

// ---------------------------------------------------------------------------
// JWT helpers (self-contained)
// ---------------------------------------------------------------------------

function base64url(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf) : buf;
  return b.toString("base64url");
}

function jwtSign(payload: Record<string, unknown>, secret: string): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const sig = base64url(createHmac("sha256", secret).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

function jwtVerify(token: string, secret: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = base64url(createHmac("sha256", secret).update(`${header}.${body}`).digest());
  if (sig !== expected) return null;
  try { return JSON.parse(Buffer.from(body, "base64url").toString()); } catch { return null; }
}

function jwtVerifyFlawed(token: string, secret: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    if (header.alg === "none" || header.alg === "None") {
      return JSON.parse(Buffer.from(parts[1], "base64url").toString());
    }
  } catch { /* fall through */ }
  return jwtVerify(token, secret);
}

// ---------------------------------------------------------------------------
// Path generation helpers
// ---------------------------------------------------------------------------

function randomPath(rng: Rng): string {
  const seg1 = rng.pick(["api", "v1", "v2", "svc", "app"]);
  const seg2 = rng.pick(["op", "fn", "rpc", "act", "cmd", "run", "do", "exec"]);
  return `/${seg1}/${seg2}-${rng.hex(3)}/${rng.pick(["action", "task", "proc", "handler", "invoke", "call"])}-${rng.hex(2)}`;
}

function internalPath(rng: Rng): string {
  return `/internal/${rng.pick(["svc", "key", "cb", "flag", "data", "meta", "ctrl"])}-${rng.hex(3)}`;
}

// ---------------------------------------------------------------------------
// Difficulty / Points
// ---------------------------------------------------------------------------

const DIFFICULTY_LEVELS: readonly Difficulty[] = ["trivial", "easy", "medium", "hard", "expert"];
const DIFFICULTY_POINTS: Record<Difficulty, [number, number]> = {
  trivial: [50, 75],
  easy: [100, 150],
  medium: [175, 250],
  hard: [275, 450],
  expert: [475, 600],
};

function pickDifficulty(rng: Rng, minIdx: number, maxIdx: number): Difficulty {
  return DIFFICULTY_LEVELS[rng.int(minIdx, maxIdx)];
}

function assignPoints(rng: Rng, diff: Difficulty): number {
  const [lo, hi] = DIFFICULTY_POINTS[diff];
  const raw = rng.int(lo, hi);
  return raw - (raw % 25); // round down to nearest 25
}

// ---------------------------------------------------------------------------
// ATOM POOLS — the building blocks of procedural challenges
// ---------------------------------------------------------------------------

/**
 * VulnPrimitive: the core vulnerability mechanic.
 * Each defines a "what is exploitable" and a factory that builds route handlers.
 */
interface VulnPrimitive {
  id: string;
  /** Human-readable name fragment (combined with surface for full name). */
  nameFragment: string;
  /** Category for the challenge. */
  category: string;
  /** Difficulty range [min, max] as indices into DIFFICULTY_LEVELS. */
  difficultyRange: [number, number];
  /** Description template. Placeholders: {surface}, {path}, {field}, {secret}, {method}. */
  descriptionTemplate: string;
  /**
   * Build route handlers for this vulnerability.
   * Returns endpoint documentation for the docs page.
   */
  buildRoutes: (ctx: BuildContext) => EndpointDoc[];
}

interface BuildContext {
  rng: Rng;
  app: Hono;
  shared: SharedConfig;
  state: SharedState;
  flag: string;
  /** Primary endpoint path for this challenge. */
  path: string;
  /** Secondary endpoint path (for multi-step challenges). */
  path2: string;
  /** Tertiary endpoint path. */
  path3: string;
  /** Internal path (for SSRF targets etc.). */
  internalPath: string;
  /** A generated field name (for mass-assignment, etc.). */
  fieldName: string;
  /** A generated header name. */
  headerName: string;
  /** A generated secret value (short, for brute-force). */
  shortSecret: string;
  /** A generated secret value (long). */
  longSecret: string;
  /** A generated tenant ID for isolation bypasses. */
  tenantId: string;
  /** A generated user ID for IDOR targets. */
  targetUserId: string;
  /** HTTP method for the primary endpoint. */
  method: string;
}

interface EndpointDoc {
  path: string;
  method: string;
  description: string;
  params?: string;
}

// -- Field name pools (used by various primitives) -------------------------

const ADMIN_FIELDS = ["role", "admin_flag", "privilege_level", "access_tier", "user_class", "is_admin", "superuser", "elevated", "auth_level", "perm_grade"] as const;
const HEADER_NAMES = ["x-forwarded-for", "x-real-ip", "x-client-ip", "cf-connecting-ip", "x-tenant-ctx", "x-org-override", "x-scope-id", "x-workspace", "x-debug-mode", "x-fast-track", "x-skip-confirm", "x-express-pay", "x-direct-auth", "x-override-role", "x-internal-key"] as const;
const MAGIC_TYPES = ["admin_export", "system_backup", "internal_dump", "debug_restore", "root_config", "service_init", "migration_seed", "shadow_import"] as const;
const OPERATOR_NAMES = ["contains", "matches", "like", "search", "filter", "find", "query", "scan"] as const;
const PROTO_ADMIN_FIELDS = ["isAdmin", "is_superuser", "elevated", "has_admin", "superMode", "godMode", "rootAccess", "devOverride"] as const;

// -- The primitives --------------------------------------------------------

const VULN_PRIMITIVES: VulnPrimitive[] = [
  // ==================== AUTH CATEGORY ====================
  {
    id: "jwt-claim-forgery",
    nameFragment: "Token Claim Forgery",
    category: "crypto",
    difficultyRange: [2, 3], // medium-hard
    descriptionTemplate: "Forge a JWT with the correct admin claim. The signing secret is available elsewhere in the API. The role claim name is non-standard — discover it from the configuration.",
    buildRoutes: (ctx) => {
      ctx.app.get(ctx.path, (c: any) => {
        const payload = ctx.state.getBearer(c);
        if (!payload) return c.json({ error: "Authentication required" }, 401);
        if (payload[ctx.shared.roleClaimName] !== "admin") {
          return c.json({ error: "Admin role required", hint: `Check the "${ctx.shared.roleClaimName}" claim` }, 403);
        }
        return c.json({ message: "Welcome, admin.", flag: ctx.flag });
      });
      return [{ path: ctx.path, method: "GET", description: "Admin panel (requires admin JWT)", params: "Authorization header" }];
    },
  },
  {
    id: "alg-none-bypass",
    nameFragment: "Algorithm Bypass",
    category: "crypto",
    difficultyRange: [2, 3],
    descriptionTemplate: "One endpoint has a flawed JWT verifier that accepts unsigned tokens when the algorithm header is set to 'none'.",
    buildRoutes: (ctx) => {
      ctx.app.get(ctx.path, (c: any) => {
        const payload = ctx.state.getBearerFlawed(c);
        if (!payload) return c.json({ error: "Authentication required" }, 401);
        if (payload[ctx.shared.roleClaimName] !== "admin") return c.json({ error: "Admin role required" }, 403);
        return c.json({ audit: ["login: admin", "config: updated"], flag: ctx.flag });
      });
      return [{ path: ctx.path, method: "GET", description: "Admin audit log (requires admin JWT)", params: "Authorization header" }];
    },
  },
  {
    id: "jwt-kid-injection",
    nameFragment: "Key ID Injection",
    category: "crypto",
    difficultyRange: [3, 4], // hard-expert
    descriptionTemplate: "The JWT verifier supports a 'kid' header for key lookup. One key ID maps to an empty signing secret.",
    buildRoutes: (ctx) => {
      const defaultKid = `key-${ctx.rng.hex(3)}`;
      const emptyKid = ctx.rng.pick(["dev-null", "test-key", "empty", "debug-0", "fallback"]);
      const keyStore: Record<string, string> = { [defaultKid]: ctx.shared.jwtSecret, [emptyKid]: "" };

      ctx.app.get(ctx.path, (c: any) => {
        const auth = c.req.header("authorization");
        if (!auth?.startsWith("Bearer ")) return c.json({ error: "Authentication required" }, 401);
        const token = auth.slice(7);
        const parts = token.split(".");
        if (parts.length !== 3) return c.json({ error: "Malformed JWT" }, 401);
        try {
          const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
          const kid = header.kid ?? defaultKid;
          const key = keyStore[kid];
          if (key === undefined) return c.json({ error: `Unknown key ID: ${kid}`, available_kids: Object.keys(keyStore) }, 401);
          const payload = jwtVerify(token, key);
          if (!payload) return c.json({ error: "Invalid signature for key ID: " + kid }, 401);
          if (payload[ctx.shared.roleClaimName] === "admin") {
            return c.json({ message: "Admin access granted via kid: " + kid, flag: ctx.flag });
          }
          return c.json({ error: "Admin role required", kid_used: kid }, 403);
        } catch { return c.json({ error: "JWT parsing failed" }, 401); }
      });
      return [{ path: ctx.path, method: "GET", description: "Protected resource (JWT with kid header)", params: "Authorization header" }];
    },
  },
  {
    id: "hmac-length-extend",
    nameFragment: "Signature Extension",
    category: "crypto",
    difficultyRange: [4, 4], // expert
    descriptionTemplate: "A signed command endpoint uses hash(secret + message) instead of HMAC. This is vulnerable to length extension — extend a known command-signature pair to include an admin command.",
    buildRoutes: (ctx) => {
      const secretPrefix = ctx.rng.hex(4);
      ctx.app.post(ctx.path, async (c: any) => {
        const body = await c.req.json().catch(() => ({}));
        const { command, signature } = body;
        if (!command || !signature) return c.json({ error: "command and signature required" }, 400);
        const expected = createHash("sha256").update(secretPrefix + command).digest("hex");
        if (signature !== expected) {
          const knownCmd = "status";
          const knownSig = createHash("sha256").update(secretPrefix + knownCmd).digest("hex");
          return c.json({ error: "Invalid signature", known_pair: { command: knownCmd, signature: knownSig }, hint: "Signing uses hash(secret + command). Think about length extension." });
        }
        if (command.includes("admin") || command.includes("flag") || command.includes("dump")) {
          return c.json({ result: "Command executed", flag: ctx.flag });
        }
        return c.json({ result: `Command '${command}' executed`, hint: "Try a command containing 'admin', 'flag', or 'dump'." });
      });
      return [{ path: ctx.path, method: "POST", description: "Execute signed command", params: "command, signature" }];
    },
  },
  {
    id: "timing-oracle",
    nameFragment: "Timing Side-Channel",
    category: "crypto",
    difficultyRange: [4, 4],
    descriptionTemplate: "An endpoint leaks a secret through response timing. Each matching character adds delay — brute force character by character.",
    buildRoutes: (ctx) => {
      const target = ctx.shortSecret;
      ctx.app.post(ctx.path, async (c: any) => {
        const body = await c.req.json().catch(() => ({}));
        const { secret } = body;
        if (!secret) return c.json({ error: "secret required" }, 400);
        let matchLen = 0;
        for (let i = 0; i < Math.min(secret.length, target.length); i++) {
          if (secret[i] === target[i]) { matchLen++; await new Promise(r => setTimeout(r, 50)); } else break;
        }
        if (secret === target) return c.json({ correct: true, flag: ctx.flag });
        return c.json({ correct: false, hint: `${matchLen} leading characters match` });
      });
      return [{ path: ctx.path, method: "POST", description: "Verify a secret value", params: "secret" }];
    },
  },
  {
    id: "buffer-overread",
    nameFragment: "Buffer Over-Read",
    category: "crypto",
    difficultyRange: [3, 4],
    descriptionTemplate: "A binary ingest endpoint trusts the declared length field. When declared length exceeds data size, adjacent memory containing a flag leaks.",
    buildRoutes: (ctx) => {
      const magicByte = ctx.rng.int(0x10, 0xff);
      ctx.app.post(ctx.path, async (c: any) => {
        const raw = await c.req.arrayBuffer();
        const buf = Buffer.from(raw);
        if (buf.length < 3) return c.json({ error: `Payload too short. Expected: magic(1B, 0x${magicByte.toString(16)}) + length(2B LE) + data` }, 400);
        if (buf[0] !== magicByte) return c.json({ error: `Invalid magic byte. Expected 0x${magicByte.toString(16)}` }, 400);
        const declaredLen = buf.readUInt16LE(1);
        const actualData = buf.subarray(3);
        if (declaredLen > actualData.length) {
          const combined = Buffer.concat([actualData, Buffer.from(ctx.flag)]);
          return c.json({ parsed: combined.subarray(0, declaredLen).toString(), overflow: true });
        }
        return c.json({ parsed: actualData.subarray(0, declaredLen).toString(), overflow: false });
      });
      return [{ path: ctx.path, method: "POST", description: "Ingest custom binary format: magic(1B) + length(2B LE) + data" }];
    },
  },

  // ==================== AUTH-BYPASS CATEGORY ====================
  {
    id: "reset-token-leak",
    nameFragment: "Reset Token Leak",
    category: "auth-bypass",
    difficultyRange: [2, 3],
    descriptionTemplate: "The password reset flow leaks the reset token in the response body. Take over the admin account.",
    buildRoutes: (ctx) => {
      ctx.app.post(ctx.path, async (c: any) => {
        const body = await c.req.json().catch(() => ({}));
        if (!body.email) return c.json({ error: "email required" }, 400);
        const user = Array.from(ctx.state.users.values()).find(u => u.email === body.email);
        if (!user) return c.json({ message: "If the email exists, a reset link has been sent." });
        ctx.state.resetTokenCounter.value++;
        const token = createHash("md5").update(`${ctx.state.resetTokenCounter.value}-${ctx.shared.jwtSecret}`).digest("hex").slice(0, 16);
        return c.json({ message: "Reset email sent.", debug_token: token, expires_in: "5 minutes", _resetUserId: user.id });
      });
      ctx.app.post(ctx.path2, async (c: any) => {
        const body = await c.req.json().catch(() => ({}));
        if (!body.token || !body.new_password || !body.user_id) return c.json({ error: "token, new_password, and user_id required" }, 400);
        const user = ctx.state.users.get(body.user_id);
        if (!user) return c.json({ error: "User not found" }, 404);
        user.password = body.new_password;
        return c.json({ message: "Password reset successful." });
      });
      const admin = ctx.state.users.get(ctx.shared.adminUserId);
      if (admin) admin.secretNote = `Admin note: ${ctx.flag}`;
      return [
        { path: ctx.path, method: "POST", description: "Request password reset", params: "email" },
        { path: ctx.path2, method: "POST", description: "Confirm password reset", params: "token, new_password, user_id" },
      ];
    },
  },
  {
    id: "rate-limit-bypass",
    nameFragment: "Rate Limit Bypass",
    category: "auth-bypass",
    difficultyRange: [2, 3],
    descriptionTemplate: "The login endpoint rate limits by IP. But the IP is read from a spoofable header — bypass the limit and brute force a PIN.",
    buildRoutes: (ctx) => {
      const pin = String(ctx.rng.int(1000, 9999));
      const pinUser = `pinuser-${ctx.rng.hex(2)}`;
      ctx.state.users.set("user-pin-" + ctx.rng.hex(2), {
        id: "user-pin-" + ctx.rng.hex(2),
        email: `${pinUser}@maze.local`,
        password: pin,
        role: "user",
        tenantId: "tenant-default",
      });
      ctx.app.post(ctx.path, async (c: any) => {
        const payload = ctx.state.getBearer(c);
        if (!payload) return c.json({ error: "Authentication required" }, 401);
        const user = ctx.state.users.get(payload.sub as string);
        if (user?.password === pin) return c.json({ verified: true, flag: ctx.flag });
        return c.json({ verified: false, error: "Not the target account" });
      });
      return [{ path: ctx.path, method: "POST", description: "Verify PIN account (requires auth)", params: "Authorization header" }];
    },
  },
  {
    id: "state-machine-skip",
    nameFragment: "State Machine Skip",
    category: "auth-bypass",
    difficultyRange: [3, 4],
    descriptionTemplate: "A multi-step flow requires create → confirm → execute. A secret header lets you skip the confirmation step.",
    buildRoutes: (ctx) => {
      const skipHeader = ctx.headerName;
      ctx.app.post(ctx.path + "/create", async (c: any) => {
        const payload = ctx.state.getBearer(c);
        if (!payload) return c.json({ error: "Authentication required" }, 401);
        const orderId = randomBytes(4).toString("hex");
        ctx.state.orderStates.set(orderId, "created");
        return c.json({ orderId, state: "created", next: "POST /confirm with orderId, then POST /execute" });
      });
      ctx.app.post(ctx.path + "/confirm", async (c: any) => {
        const payload = ctx.state.getBearer(c);
        if (!payload) return c.json({ error: "Authentication required" }, 401);
        const body = await c.req.json().catch(() => ({}));
        if (!body.orderId || ctx.state.orderStates.get(body.orderId) !== "created") return c.json({ error: "Invalid order or wrong state" }, 400);
        ctx.state.orderStates.set(body.orderId, "confirmed");
        return c.json({ orderId: body.orderId, state: "confirmed", next: "POST /execute with orderId" });
      });
      ctx.app.post(ctx.path + "/execute", async (c: any) => {
        const payload = ctx.state.getBearer(c);
        if (!payload) return c.json({ error: "Authentication required" }, 401);
        const body = await c.req.json().catch(() => ({}));
        if (!body.orderId) return c.json({ error: "orderId required" }, 400);
        const orderState = ctx.state.orderStates.get(body.orderId);
        const skip = c.req.header(skipHeader);
        if (skip && orderState === "created") {
          ctx.state.orderStates.set(body.orderId, "executed");
          return c.json({ orderId: body.orderId, state: "executed", message: "Express execution!", flag: ctx.flag });
        }
        if (orderState !== "confirmed") return c.json({ error: `Must be confirmed first (current: ${orderState})` }, 400);
        ctx.state.orderStates.set(body.orderId, "executed");
        return c.json({ orderId: body.orderId, state: "executed", message: "Executed" });
      });
      return [
        { path: ctx.path + "/create", method: "POST", description: "Create order (step 1/3)", params: "Authorization header" },
        { path: ctx.path + "/confirm", method: "POST", description: "Confirm order (step 2/3)", params: "orderId" },
        { path: ctx.path + "/execute", method: "POST", description: "Execute order (step 3/3, requires confirmed)", params: "orderId" },
      ];
    },
  },
  {
    id: "invite-code-crack",
    nameFragment: "Invite Code Crack",
    category: "auth-bypass",
    difficultyRange: [2, 3],
    descriptionTemplate: "The invite code format is documented publicly. The middle segment is only 4 hex characters — brute force it.",
    buildRoutes: (ctx) => {
      const prefix = ctx.rng.hex(2).toUpperCase();
      const suffix = ctx.rng.hex(2).toUpperCase();
      ctx.app.get(ctx.path2, (c: any) => {
        return c.json({
          schema: {
            invite_codes: {
              format: `${prefix}-XXXX-${suffix}`,
              example: `${prefix}-A1B2-${suffix}`,
              note: "XXXX is 4-character hex. The code space is intentionally small.",
            },
          },
        });
      });
      ctx.app.post(ctx.path, async (c: any) => {
        const body = await c.req.json().catch(() => ({}));
        if (!body.code) return c.json({ error: "code required" }, 400);
        const pattern = new RegExp(`^${prefix}-[A-F0-9]{4}-${suffix}$`);
        if (!pattern.test(body.code)) return c.json({ error: "Invalid invite code format" }, 400);
        return c.json({ valid: true, message: "Invite code accepted.", flag: ctx.flag });
      });
      return [
        { path: ctx.path, method: "POST", description: "Redeem an invite code", params: "code" },
        { path: ctx.path2, method: "GET", description: "Schema introspection (public)" },
      ];
    },
  },

  // ==================== IDOR CATEGORY ====================
  {
    id: "idor-profile",
    nameFragment: "Profile IDOR",
    category: "idor",
    difficultyRange: [3, 4],
    descriptionTemplate: "The user profile endpoint has an IDOR vulnerability. One hidden user has a secret note containing the flag.",
    buildRoutes: (ctx) => {
      const targetEmail = `hidden-${ctx.rng.hex(2)}@maze.local`;
      ctx.state.users.set(ctx.targetUserId, {
        id: ctx.targetUserId,
        email: targetEmail,
        password: "hidden",
        role: "user",
        secretNote: ctx.flag,
        tenantId: ctx.rng.uuid(),
      });
      ctx.app.get(ctx.path + "/:id", (c: any) => {
        const payload = ctx.state.getBearer(c);
        if (!payload) return c.json({ error: "Authentication required" }, 401);
        const userId = c.req.param("id") ?? "";
        const user = ctx.state.users.get(userId);
        if (!user) return c.json({ error: "User not found" }, 404);
        return c.json({ id: user.id, email: user.email, role: user.role, ...(user.secretNote ? { secret_note: user.secretNote } : {}) });
      });
      ctx.app.get(ctx.path, (c: any) => {
        const payload = ctx.state.getBearer(c);
        if (!payload) return c.json({ error: "Authentication required" }, 401);
        return c.json({ users: Array.from(ctx.state.users.values()).map(u => ({ id: u.id, email: u.email })) });
      });
      return [
        { path: ctx.path + "/:id", method: "GET", description: "Get user profile (requires auth)", params: "Authorization header" },
        { path: ctx.path, method: "GET", description: "List all users (requires auth)", params: "Authorization header" },
      ];
    },
  },

  // ==================== SSRF CATEGORY ====================
  {
    id: "ssrf-direct",
    nameFragment: "Server-Side Request",
    category: "ssrf",
    difficultyRange: [3, 4],
    descriptionTemplate: "The webhook test endpoint makes server-side requests. An internal endpoint contains the flag.",
    buildRoutes: (ctx) => {
      ctx.app.post(ctx.path, async (c: any) => {
        const payload = ctx.state.getBearer(c);
        if (!payload) return c.json({ error: "Authentication required" }, 401);
        const body = await c.req.json().catch(() => ({}));
        if (!body.url) return c.json({ error: "url required" }, 400);
        try {
          const res = await fetch(body.url, { signal: AbortSignal.timeout(5000) });
          const text = await res.text();
          return c.json({ status: res.status, body: text.slice(0, 4000) });
        } catch (err: any) {
          return c.json({ error: "Fetch failed", message: err?.message ?? String(err) });
        }
      });
      ctx.app.get(ctx.internalPath, (c: any) => {
        return c.json({ flag: ctx.flag, service: "internal-flag" });
      });
      return [{ path: ctx.path, method: "POST", description: "Test a webhook URL (requires auth)", params: "url" }];
    },
  },
  {
    id: "ssrf-second-order",
    nameFragment: "Stored Request Forgery",
    category: "ssrf",
    difficultyRange: [3, 4],
    descriptionTemplate: "Set a callback URL, then trigger a notification. The server fetches your stored URL — point it at an internal service.",
    buildRoutes: (ctx) => {
      ctx.app.put(ctx.path, async (c: any) => {
        const payload = ctx.state.getBearer(c);
        if (!payload) return c.json({ error: "Authentication required" }, 401);
        const body = await c.req.json().catch(() => ({}));
        if (!body.url) return c.json({ error: "url required" }, 400);
        ctx.state.userCallbacks.set(payload.sub as string, body.url);
        return c.json({ message: "Callback URL set", url: body.url });
      });
      ctx.app.post(ctx.path2, async (c: any) => {
        const payload = ctx.state.getBearer(c);
        if (!payload) return c.json({ error: "Authentication required" }, 401);
        const url = ctx.state.userCallbacks.get(payload.sub as string);
        if (!url) return c.json({ error: "No callback URL set." }, 400);
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
          const text = await res.text();
          return c.json({ notified: true, callbackResponse: text.slice(0, 2000) });
        } catch (err: any) {
          return c.json({ notified: false, error: err?.message ?? String(err) });
        }
      });
      ctx.app.get(ctx.internalPath, (c: any) => {
        return c.json({ flag: ctx.flag, service: "internal-callback" });
      });
      return [
        { path: ctx.path, method: "PUT", description: "Set webhook callback URL (requires auth)", params: "url" },
        { path: ctx.path2, method: "POST", description: "Trigger notification (fetches callback, requires auth)" },
      ];
    },
  },
  {
    id: "open-redirect-chain",
    nameFragment: "Redirect Chain",
    category: "ssrf",
    difficultyRange: [3, 4],
    descriptionTemplate: "A URL preview endpoint follows redirects. Chain through the short URL service to reach an internal endpoint.",
    buildRoutes: (ctx) => {
      ctx.app.get(ctx.path, async (c: any) => {
        const url = c.req.query("url");
        if (!url) return c.json({ error: "url query parameter required" }, 400);
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "follow" });
          const text = await res.text();
          return c.json({ status: res.status, preview: text.slice(0, 2000) });
        } catch (err: any) {
          return c.json({ error: "Preview failed", message: err?.message ?? String(err) });
        }
      });
      ctx.app.post(ctx.path2, async (c: any) => {
        const payload = ctx.state.getBearer(c);
        if (!payload) return c.json({ error: "Authentication required" }, 401);
        const body = await c.req.json().catch(() => ({}));
        if (!body.url) return c.json({ error: "url required" }, 400);
        const id = randomBytes(4).toString("hex");
        ctx.state.shortUrls.set(id, { id, url: body.url });
        return c.json({ short_id: id, short_url: `${ctx.path2}/${id}` });
      });
      ctx.app.get(ctx.path2 + "/:id", (c: any) => {
        const entry = ctx.state.shortUrls.get(c.req.param("id") ?? "");
        if (!entry) return c.json({ error: "Short URL not found" }, 404);
        return c.redirect(entry.url);
      });
      ctx.app.get(ctx.internalPath, (c: any) => {
        return c.json({ flag: ctx.flag, service: "internal-redirect-target" });
      });
      return [
        { path: ctx.path, method: "GET", description: "Preview a URL's content (follows redirects)", params: "url (query parameter)" },
        { path: ctx.path2, method: "POST", description: "Create a short URL (requires auth)", params: "url" },
        { path: ctx.path2 + "/:id", method: "GET", description: "Follow a shortened URL" },
      ];
    },
  },

  // ==================== INJECTION CATEGORY ====================
  {
    id: "query-lang-injection",
    nameFragment: "Query Language Injection",
    category: "injection",
    difficultyRange: [3, 4],
    descriptionTemplate: "The API has a custom query language for filtering. The pipe operator breaks tenant isolation.",
    buildRoutes: (ctx) => {
      const operator = ctx.rng.pick(OPERATOR_NAMES);
      ctx.state.users.set("tenant-flag-" + ctx.rng.hex(2), {
        id: "tenant-flag-" + ctx.rng.hex(2),
        email: "data@maze.local",
        password: "nope",
        role: "user",
        secretNote: ctx.flag,
        tenantId: ctx.tenantId,
      });
      ctx.app.post(ctx.path, async (c: any) => {
        const payload = ctx.state.getBearer(c);
        if (!payload) return c.json({ error: "Authentication required" }, 401);
        const body = await c.req.json().catch(() => ({}));
        if (!body.query) return c.json({ error: `query required. Syntax: field:${operator}:value` }, 400);
        const tenantFilter = body.tenant_id ?? (payload.tenant as string) ?? "tenant-default";
        const filters = (body.query as string).split("|").map((f: string) => f.trim());
        let results = Array.from(ctx.state.users.values());
        // Bug: pipe in query skips tenant isolation
        if (!(body.query as string).includes("|")) results = results.filter(u => u.tenantId === tenantFilter);
        for (const filter of filters) {
          const parts = filter.split(":");
          if (parts.length < 3) continue;
          const [field, op, ...valueParts] = parts;
          const value = valueParts.join(":");
          results = results.filter(u => {
            const fv = (u as any)[field === "note" ? "secretNote" : field];
            if (fv === undefined) return false;
            const str = String(fv);
            if (op === operator) return str.toLowerCase().includes(value.toLowerCase());
            if (op === "eq") return str === value;
            return false;
          });
        }
        return c.json({ results: results.map(u => ({ id: u.id, email: u.email, ...(u.secretNote ? { note: u.secretNote } : {}) })), query_parsed: filters });
      });
      return [{ path: ctx.path, method: "POST", description: `Query using MazeQL. Syntax: field:${operator}:value. Pipe (|) chains filters.`, params: "query, tenant_id" }];
    },
  },
  {
    id: "coupon-stacking",
    nameFragment: "Array Bypass",
    category: "injection",
    difficultyRange: [3, 4],
    descriptionTemplate: "The checkout enforces one discount code at a time. But what if the code parameter is an array?",
    buildRoutes: (ctx) => {
      const codes = [`SAVE-${ctx.rng.hex(2).toUpperCase()}`, `DEAL-${ctx.rng.hex(2).toUpperCase()}`];
      ctx.app.post(ctx.path, async (c: any) => {
        const payload = ctx.state.getBearer(c);
        if (!payload) return c.json({ error: "Authentication required" }, 401);
        const body = await c.req.json().catch(() => ({}));
        if (!body.items?.length) return c.json({ error: "items required (array of {name, price})" }, 400);
        const total = body.items.reduce((s: number, i: any) => s + (i.price ?? 0), 0);
        const userId = payload.sub as string;
        if (typeof body.code === "string") {
          if (!codes.includes(body.code)) return c.json({ error: `Invalid code: ${body.code}` }, 400);
          const used = ctx.state.appliedCoupons.get(userId) ?? new Set();
          if (used.has(body.code)) return c.json({ error: "Code already used" }, 400);
          used.add(body.code);
          ctx.state.appliedCoupons.set(userId, used);
          return c.json({ total: total * 0.9, discount: "10%", code: body.code });
        }
        if (Array.isArray(body.code) && body.code.length >= 2) {
          const valid = body.code.filter((c: string) => codes.includes(c));
          if (valid.length >= 2) return c.json({ total: total * 0.5, discount: "50%", codes: valid, flag: ctx.flag });
        }
        return c.json({ total, discount: "none" });
      });
      return [{ path: ctx.path, method: "POST", description: "Checkout with discount code (requires auth)", params: "code, items [{name, price}]" }];
    },
  },
  {
    id: "negative-quantity",
    nameFragment: "Negative Quantity",
    category: "injection",
    difficultyRange: [3, 4],
    descriptionTemplate: "The order system calculates totals from quantities. Negative quantities produce credits.",
    buildRoutes: (ctx) => {
      ctx.app.post(ctx.path, async (c: any) => {
        const payload = ctx.state.getBearer(c);
        if (!payload) return c.json({ error: "Authentication required" }, 401);
        const body = await c.req.json().catch(() => ({}));
        if (!body.items?.length) return c.json({ error: "items required [{name, price, quantity}]" }, 400);
        const total = body.items.reduce((s: number, i: any) => s + (i.price ?? 0) * (i.quantity ?? 1), 0);
        if (total < 0) return c.json({ total, status: "credit", message: "Negative total — credit applied!", flag: ctx.flag });
        return c.json({ total, status: "charged", orderId: randomBytes(4).toString("hex") });
      });
      return [{ path: ctx.path, method: "POST", description: "Place an order (requires auth)", params: "items [{name, price, quantity}]" }];
    },
  },
  {
    id: "prototype-pollution",
    nameFragment: "Deep Merge Pollution",
    category: "injection",
    difficultyRange: [3, 4],
    descriptionTemplate: "The preferences endpoint deep-merges JSON into your profile. The __proto__ key has special effects in JavaScript.",
    buildRoutes: (ctx) => {
      const adminField = ctx.rng.pick(PROTO_ADMIN_FIELDS);
      ctx.app.put(ctx.path, async (c: any) => {
        const payload = ctx.state.getBearer(c);
        if (!payload) return c.json({ error: "Authentication required" }, 401);
        const body = await c.req.json().catch(() => ({}));
        const userId = payload.sub as string;
        const prefs = ctx.state.userPrefsStore.get(userId) ?? {};
        function deepMerge(target: any, source: any) {
          for (const key of Object.keys(source)) {
            if (key === "__proto__") { Object.assign(Object.getPrototypeOf(target), source[key]); }
            else if (typeof source[key] === "object" && source[key] !== null && typeof target[key] === "object") { deepMerge(target[key], source[key]); }
            else { target[key] = source[key]; }
          }
        }
        deepMerge(prefs, body);
        ctx.state.userPrefsStore.set(userId, prefs);
        const testObj: any = {};
        if (testObj[adminField] === true) {
          delete (Object.prototype as any)[adminField];
          return c.json({ updated: true, message: "Preferences saved", flag: ctx.flag });
        }
        return c.json({ updated: true, prefs, hint: "Supported: theme, locale, notifications. Some objects have deeper effects." });
      });
      return [{ path: ctx.path, method: "PUT", description: "Merge preferences (deep merge, requires auth)", params: "JSON object" }];
    },
  },
  {
    id: "header-crlf",
    nameFragment: "CRLF Header Injection",
    category: "injection",
    difficultyRange: [3, 4],
    descriptionTemplate: "A URL shortener redirects without sanitizing the stored URL. CRLF sequences can inject response headers.",
    buildRoutes: (ctx) => {
      const secretHeader = `x-flag-${ctx.rng.hex(2)}`;
      ctx.app.post(ctx.path, async (c: any) => {
        const payload = ctx.state.getBearer(c);
        if (!payload) return c.json({ error: "Authentication required" }, 401);
        const body = await c.req.json().catch(() => ({}));
        if (!body.url) return c.json({ error: "url required" }, 400);
        const id = randomBytes(4).toString("hex");
        ctx.state.shortUrls.set(id, { id, url: body.url });
        return c.json({ short_id: id, short_url: `${ctx.path2}/${id}` });
      });
      ctx.app.get(ctx.path2 + "/:id", (c: any) => {
        const entry = ctx.state.shortUrls.get(c.req.param("id") ?? "");
        if (!entry) return c.json({ error: "Short URL not found" }, 404);
        if (entry.url.includes("\\r\\n") || entry.url.includes("\r\n") || entry.url.includes("%0d%0a")) {
          c.header(secretHeader, ctx.flag);
        }
        return c.redirect(entry.url.split("\r\n")[0].split("\\r\\n")[0]);
      });
      return [
        { path: ctx.path, method: "POST", description: "Create a short URL (requires auth)", params: "url" },
        { path: ctx.path2 + "/:id", method: "GET", description: "Follow a shortened URL (redirects)" },
      ];
    },
  },
  {
    id: "type-confusion-deser",
    nameFragment: "Type Confusion",
    category: "injection",
    difficultyRange: [3, 4],
    descriptionTemplate: "A data import endpoint has documented types. An undocumented type bypasses all validation.",
    buildRoutes: (ctx) => {
      const magicType = ctx.rng.pick(MAGIC_TYPES);
      ctx.app.post(ctx.path, async (c: any) => {
        const payload = ctx.state.getBearer(c);
        if (!payload) return c.json({ error: "Authentication required" }, 401);
        const body = await c.req.json().catch(() => ({}));
        if (!body.type || !body.data) return c.json({ error: "type and data required" }, 400);
        const allowed = ["user_export", "settings_export", magicType];
        if (!allowed.includes(body.type)) return c.json({ error: `Unknown type. Supported: ${allowed.filter(t => t !== magicType).join(", ")}` }, 400);
        if (body.type === magicType) return c.json({ imported: true, internal: true, flag: ctx.flag });
        return c.json({ imported: true, records: Object.keys(body.data).length });
      });
      return [{ path: ctx.path, method: "POST", description: "Import data (requires auth). Format: {type, data}", params: "type, data" }];
    },
  },
  {
    id: "xxe-injection",
    nameFragment: "XML Entity Injection",
    category: "injection",
    difficultyRange: [3, 4],
    descriptionTemplate: "An XML import endpoint resolves external entity declarations. Reference a magic filename to extract the flag.",
    buildRoutes: (ctx) => {
      const secretFile = `flag-${ctx.rng.hex(3)}.txt`;
      ctx.app.post(ctx.path, async (c: any) => {
        const payload = ctx.state.getBearer(c);
        if (!payload) return c.json({ error: "Authentication required" }, 401);
        const text = await c.req.text();
        if (!text.includes("<")) return c.json({ error: "Expected XML body" }, 400);
        if (text.includes(secretFile)) return c.json({ parsed: true, entity_content: ctx.flag });
        if (text.includes("ENTITY") || text.includes("<!DOCTYPE")) return c.json({ parsed: true, hint: `The server resolves external entities. Try referencing ${secretFile}.` });
        const count = (text.match(/<[^/!][^>]*>/g) || []).length;
        return c.json({ parsed: true, elements: count });
      });
      return [{ path: ctx.path, method: "POST", description: "Import XML (requires auth)", params: "XML body with <items> root" }];
    },
  },
  {
    id: "regex-dos",
    nameFragment: "Regex Catastrophe",
    category: "injection",
    difficultyRange: [3, 4],
    descriptionTemplate: "The search endpoint compiles user input as a regex. Catastrophic backtracking triggers an error handler that leaks the flag.",
    buildRoutes: (ctx) => {
      ctx.app.get(ctx.path, (c: any) => {
        const q = c.req.query("q") ?? "";
        if (!q) return c.json({ error: "q query parameter required" }, 400);
        const products = [{ name: "Widget A", price: 10 }, { name: "Gadget B", price: 20 }, { name: "Doohickey C", price: 30 }];
        try {
          const re = new RegExp(q, "i");
          const start = Date.now();
          const results = products.filter(p => { if (Date.now() - start > 100) throw new Error("TIMEOUT"); return re.test(p.name); });
          return c.json({ results });
        } catch (err: any) {
          return c.json({ error: "Search timed out", debug: ctx.flag, message: err?.message ?? String(err) });
        }
      });
      return [{ path: ctx.path, method: "GET", description: "Search products by regex", params: "q (query string)" }];
    },
  },
  {
    id: "param-pollution",
    nameFragment: "Parameter Pollution",
    category: "injection",
    difficultyRange: [3, 4],
    descriptionTemplate: "A payment endpoint validates the first amount but processes the last. Send duplicate amount values to bypass the threshold.",
    buildRoutes: (ctx) => {
      const threshold = ctx.rng.int(50, 200);
      ctx.app.post(ctx.path, async (c: any) => {
        const payload = ctx.state.getBearer(c);
        if (!payload) return c.json({ error: "Authentication required" }, 401);
        const body = await c.req.json().catch(() => ({}));
        const rawAmount = body.amount;
        let validateAmt: number, processAmt: number;
        if (Array.isArray(rawAmount)) {
          validateAmt = Number(rawAmount[0]);
          processAmt = Number(rawAmount[rawAmount.length - 1]);
        } else {
          validateAmt = Number(rawAmount);
          processAmt = validateAmt;
        }
        if (isNaN(validateAmt)) return c.json({ error: "Invalid amount" }, 400);
        if (validateAmt > threshold) return c.json({ error: `Amount $${validateAmt} exceeds $${threshold} limit` }, 403);
        if (processAmt > threshold) return c.json({ processed: true, amount: processAmt, message: "Large payment processed!", flag: ctx.flag });
        return c.json({ processed: true, amount: processAmt });
      });
      return [{ path: ctx.path, method: "POST", description: `Process payment (requires auth). Over $${threshold} needs approval.`, params: "amount, recipient" }];
    },
  },

  // ==================== BROKEN ACCESS CATEGORY ====================
  {
    id: "mass-assignment",
    nameFragment: "Mass Assignment",
    category: "broken-access",
    difficultyRange: [3, 4],
    descriptionTemplate: "The profile update endpoint documents name and email. But the server accepts undocumented fields that control access.",
    buildRoutes: (ctx) => {
      const adminField = ctx.fieldName;
      ctx.app.put(ctx.path, async (c: any) => {
        const payload = ctx.state.getBearer(c);
        if (!payload) return c.json({ error: "Authentication required" }, 401);
        const body = await c.req.json().catch(() => ({}));
        const userId = payload.sub as string;
        const user = ctx.state.users.get(userId);
        if (!user) return c.json({ error: "User not found" }, 404);
        if (body.name) (user as any).name = body.name;
        if (body.email) user.email = body.email;
        if (body[adminField] !== undefined) (user as any)[adminField] = body[adminField];
        if ((user as any)[adminField] === "admin" || (user as any)[adminField] === true) {
          return c.json({ updated: true, message: "Profile updated", flag: ctx.flag });
        }
        return c.json({ updated: true, fields: Object.keys(body), message: "Profile updated (hint: some fields have special effects)" });
      });
      return [{ path: ctx.path, method: "PUT", description: "Update user profile (requires auth)", params: "name, email" }];
    },
  },
  {
    id: "tenant-isolation-bypass",
    nameFragment: "Tenant Isolation Bypass",
    category: "broken-access",
    difficultyRange: [3, 4],
    descriptionTemplate: "Tenant-scoped data is filtered by JWT tenant claim. But a request header can override the tenant context.",
    buildRoutes: (ctx) => {
      const overrideHeader = ctx.headerName;
      ctx.state.users.set(`tenant-target-${ctx.rng.hex(2)}`, {
        id: `tenant-target-${ctx.rng.hex(2)}`,
        email: "classified@maze.local",
        password: "nope",
        role: "user",
        secretNote: ctx.flag,
        tenantId: ctx.tenantId,
      });
      ctx.app.get(ctx.path, (c: any) => {
        const payload = ctx.state.getBearer(c);
        if (!payload) return c.json({ error: "Authentication required" }, 401);
        const override = c.req.header(overrideHeader);
        const tid = override ?? (payload.tenant as string) ?? "tenant-default";
        const tenantUsers = Array.from(ctx.state.users.values()).filter(u => u.tenantId === tid);
        return c.json({
          tenant: tid,
          data: tenantUsers.map(u => ({ id: u.id, email: u.email, ...(u.secretNote ? { note: u.secretNote } : {}) })),
        });
      });
      return [{ path: ctx.path, method: "GET", description: "Get tenant-scoped data (requires auth)", params: "Authorization header" }];
    },
  },
  {
    id: "permission-dag",
    nameFragment: "Permission Graph Traversal",
    category: "broken-access",
    difficultyRange: [4, 4],
    descriptionTemplate: "The permission system is a directed graph. Most edges require admin. Find the one that doesn't.",
    buildRoutes: (ctx) => {
      const nodes = ctx.rng.shuffle(["read", "write", "execute", "admin", "audit", "deploy", "config", "monitor"]).slice(0, 6);
      const edges: [string, string][] = [];
      for (let i = 0; i < nodes.length - 1; i++) edges.push([nodes[i], nodes[i + 1]]);
      edges.push([nodes[0], nodes[3]]);
      edges.push([nodes[1], nodes[4]]);
      const unprotIdx = ctx.rng.int(1, edges.length - 2);
      const unprotected = edges[unprotIdx];
      const flagNode = nodes[nodes.length - 1];

      // Store DAG info for docs page
      (ctx as any)._dagNodes = nodes;
      (ctx as any)._dagEdges = edges;
      (ctx as any)._unprotectedEdge = unprotected;
      (ctx as any)._flagNode = flagNode;

      ctx.app.post(ctx.path, async (c: any) => {
        const payload = ctx.state.getBearer(c);
        if (!payload) return c.json({ error: "Authentication required" }, 401);
        const body = await c.req.json().catch(() => ({}));
        if (!body.from || !body.to) return c.json({ error: "from and to permission nodes required" }, 400);
        const edge = edges.find(([f, t]) => f === body.from && t === body.to);
        if (!edge) return c.json({ error: `No edge from ${body.from} to ${body.to}` }, 404);
        const isUnprot = unprotected[0] === body.from && unprotected[1] === body.to;
        const userRole = payload[ctx.shared.roleClaimName] as string;
        if (!isUnprot && userRole !== "admin") return c.json({ error: "Admin role required", edge: { from: body.from, to: body.to } }, 403);
        if (body.to === flagNode) return c.json({ traversed: true, from: body.from, to: body.to, flag: ctx.flag });
        return c.json({ traversed: true, from: body.from, to: body.to, message: `Traversed. Continue to reach ${flagNode}.` });
      });
      return [{ path: ctx.path, method: "POST", description: "Check permission path between nodes", params: "from, to, Authorization header" }];
    },
  },

  // ==================== SENSITIVE-DATA CATEGORY ====================
  {
    id: "path-traversal",
    nameFragment: "Path Traversal",
    category: "sensitive-data",
    difficultyRange: [3, 4],
    descriptionTemplate: "The file API has a path traversal vulnerability. A secret file exists outside the served directory.",
    buildRoutes: (ctx) => {
      const secretFile = `secret-${ctx.rng.hex(3)}.txt`;
      const files: Record<string, string> = {
        "readme.txt": "Welcome to the file storage system.",
        "example.json": '{"name": "example"}',
        "notes.txt": "Nothing interesting here.",
      };
      ctx.app.get(ctx.path + "/*", (c: any) => {
        const rawUrl = c.req.url;
        const marker = ctx.path.split("/").pop()!;
        const markerIdx = rawUrl.indexOf(`/${marker}/`);
        if (markerIdx < 0) return c.json({ error: "Bad request" }, 400);
        const rawSegment = rawUrl.slice(markerIdx + `/${marker}/`.length).split("?")[0];
        if (rawSegment.includes("../")) return c.json({ error: "Path traversal blocked" }, 400);
        const decoded = decodeURIComponent(rawSegment);
        if (decoded.includes(secretFile)) return c.text(ctx.flag);
        const content = files[decoded];
        if (!content) return c.json({ error: "File not found", available: Object.keys(files), hint: `A file named ${secretFile} exists one directory up.` }, 404);
        return c.text(content);
      });
      return [{ path: ctx.path + "/:filename", method: "GET", description: "Retrieve a file from storage" }];
    },
  },

  // ==================== RACE CONDITION CATEGORY ====================
  {
    id: "race-condition",
    nameFragment: "Token Race Condition",
    category: "race-condition",
    difficultyRange: [3, 4],
    descriptionTemplate: "A temporary token system has a hidden escalation endpoint that consumes the token without invalidating it. Hit it during the 2-second validity window.",
    buildRoutes: (ctx) => {
      ctx.app.post(ctx.path, (c: any) => {
        const payload = ctx.state.getBearer(c);
        if (!payload) return c.json({ error: "Authentication required" }, 401);
        const token = randomBytes(16).toString("hex");
        ctx.state.tempTokens.set(token, { token, userId: payload.sub as string, createdAt: Date.now() });
        setTimeout(() => ctx.state.tempTokens.delete(token), 2000);
        return c.json({ token, expires_in_ms: 2000, message: "Use this token at the consume endpoint within 2 seconds." });
      });
      ctx.app.post(ctx.path2, async (c: any) => {
        const body = await c.req.json().catch(() => ({}));
        if (!body.token) return c.json({ error: "token required" }, 400);
        const entry = ctx.state.tempTokens.get(body.token);
        if (!entry) return c.json({ error: "Token expired or invalid" }, 401);
        ctx.state.tempTokens.delete(body.token);
        return c.json({ message: "Token consumed", userId: entry.userId });
      });
      // Hidden escalation endpoint
      ctx.app.post(ctx.path3, async (c: any) => {
        const body = await c.req.json().catch(() => ({}));
        if (!body.token) return c.json({ error: "token required" }, 400);
        const entry = ctx.state.tempTokens.get(body.token);
        if (!entry) return c.json({ error: "Token expired or invalid" }, 401);
        // Bug: doesn't delete the token
        return c.json({ message: "Elevated access granted", flag: ctx.flag });
      });
      return [
        { path: ctx.path, method: "POST", description: "Generate temp token (valid 2s, requires auth)", params: "Authorization header" },
        { path: ctx.path2, method: "POST", description: "Consume a temp token", params: "token" },
      ];
    },
  },
];

// ---------------------------------------------------------------------------
// COMPOSITION MODIFIERS — transforms applied on top of base primitives
// ---------------------------------------------------------------------------

/**
 * Modifiers wrap or alter a challenge to increase variety. They're applied
 * probabilistically based on difficulty. Each modifier changes names,
 * descriptions, and may wrap route handlers.
 */
interface ChallengeModifier {
  id: string;
  namePrefix: string;
  descriptionSuffix: string;
  /** Only apply to challenges in these categories. Empty = any. */
  categories: string[];
  /** Minimum difficulty index to apply this modifier. */
  minDifficulty: number;
}

const MODIFIERS: ChallengeModifier[] = [
  { id: "chained", namePrefix: "Chained", descriptionSuffix: " This challenge requires solving a prerequisite challenge first.", categories: [], minDifficulty: 3 },
  { id: "obfuscated", namePrefix: "Obfuscated", descriptionSuffix: " Endpoint names and parameters are deliberately misleading.", categories: ["injection", "ssrf"], minDifficulty: 2 },
  { id: "rate-limited", namePrefix: "Throttled", descriptionSuffix: " This endpoint is rate-limited — you'll need to be efficient.", categories: ["auth-bypass", "crypto"], minDifficulty: 2 },
  { id: "multi-step", namePrefix: "Multi-Phase", descriptionSuffix: " Requires multiple sequential requests in the correct order.", categories: [], minDifficulty: 3 },
];

// ---------------------------------------------------------------------------
// PROCEDURAL GENERATION ENGINE
// ---------------------------------------------------------------------------

export interface GeneratedMaze {
  seed: string;
  challenges: ChallengeBlueprint[];
  shared: SharedConfig;
  decoyPaths: string[];
  /** Metadata for docs: maps challenge id to endpoint docs. */
  endpointDocs: Map<string, EndpointDoc[]>;
  /** Per-challenge config data exposed via debug endpoint. */
  debugLeaks: Map<string, Record<string, unknown>>;
  /** Extra docs notes. */
  docsNotes: string[];
  /** Rate limit header (from whichever rate-limit challenge is active). */
  rateLimitHeader: string;
}

/**
 * Generate a complete maze from a seed. Deterministic: same seed = same maze.
 *
 * The generation process:
 * 1. Derive shared infrastructure (secrets, paths, admin user)
 * 2. Always include 2 foundational challenges (map-the-maze, find-the-leak)
 * 3. Select 10-18 primitives from the pool via seeded shuffle
 * 4. Optionally apply modifiers to increase variety
 * 5. Assign difficulties and points
 * 6. Generate unique names by combining primitive names with modifiers
 * 7. Produce 30-50 decoy endpoints
 */
export function generateMaze(seed: string): GeneratedMaze {
  const rng = createRng(seed);

  // -- Shared infrastructure --
  const shared: SharedConfig = {
    jwtSecret: rng.hex(16),
    adminPassword: `admin-${rng.hex(4)}`,
    adminEmail: `admin-${rng.hex(3)}@maze.local`,
    adminUserId: rng.uuid(),
    roleClaimName: rng.pick(["role", "access_level", "user_role", "permissions_tier", "auth_class", "grant_type", "sec_level"]),
    serviceKey: `svc-key-${rng.hex(8)}`,
    docsPath: `/${rng.pick(["api", "v1", "svc"])}/${rng.pick(["op", "fn"])}-${rng.hex(3)}/docs`,
    debugPath: `/${rng.pick(["api", "v1", "svc"])}/${rng.pick(["op", "fn"])}-${rng.hex(3)}/debug`,
    registerPath: `/${rng.pick(["api", "v1", "svc"])}/${rng.pick(["op", "fn"])}-${rng.hex(3)}/register`,
    loginPath: `/${rng.pick(["api", "v1", "svc"])}/${rng.pick(["op", "fn"])}-${rng.hex(3)}/login`,
  };

  const challenges: ChallengeBlueprint[] = [];
  const endpointDocs = new Map<string, EndpointDoc[]>();
  const debugLeaks = new Map<string, Record<string, unknown>>();
  const docsNotes: string[] = [
    "Admin endpoints require a JWT with the correct role claim.",
    `The role claim field in the JWT payload is: "${shared.roleClaimName}"`,
    "Internal services are available at /internal/* (localhost only).",
  ];

  // -- Select primitives --
  // Shuffle the entire pool, then take 10-18
  const electiveCount = rng.int(10, 18);
  const selected = rng.sample(VULN_PRIMITIVES, electiveCount);

  // -- Select modifiers per challenge --
  const availableModifiers = rng.shuffle(MODIFIERS);

  // -- Assign rate limit header --
  const rateLimitHeader = rng.pick(HEADER_NAMES.filter(h => h.startsWith("x-") && (h.includes("forwarded") || h.includes("real-ip") || h.includes("client-ip") || h.includes("connecting"))));

  // -- Generate each challenge --
  let challengeIndex = 0;
  for (const primitive of selected) {
    const childRng = rng.child(`challenge-${challengeIndex}`);
    challengeIndex++;

    // Difficulty
    const difficulty = pickDifficulty(childRng, primitive.difficultyRange[0], primitive.difficultyRange[1]);
    const points = Math.max(assignPoints(childRng, difficulty), DIFFICULTY_POINTS[difficulty][0]);
    const diffIdx = DIFFICULTY_LEVELS.indexOf(difficulty);

    // Optional modifier
    let namePrefix = "";
    let descSuffix = "";
    const modifierCandidate = availableModifiers.find((m: ChallengeModifier) =>
      m.minDifficulty <= diffIdx &&
      (m.categories.length === 0 || m.categories.includes(primitive.category))
    );
    if (modifierCandidate && childRng.float() > 0.6) {
      namePrefix = modifierCandidate.namePrefix + " ";
      descSuffix = modifierCandidate.descriptionSuffix;
    }

    // Flag + ID
    const challengeSlug = `${primitive.id}-${childRng.hex(3)}`;
    const id = `maze-${challengeSlug}`;
    const flag = `FLAG{maze-${challengeSlug}-${childRng.hex(8)}}`;

    // Generate paths and context values
    const path = randomPath(childRng);
    const path2 = randomPath(childRng);
    const path3 = randomPath(childRng);
    const iPath = internalPath(childRng);
    const fieldName = childRng.pick(ADMIN_FIELDS);
    const headerName = childRng.pick(HEADER_NAMES);
    const shortSecret = childRng.hex(6);
    const longSecret = childRng.hex(16);
    const tenantId = childRng.uuid();
    const targetUserId = childRng.uuid();
    const method = childRng.pick(["GET", "POST", "PUT", "PATCH"]);

    const name = `${namePrefix}${primitive.nameFragment}`;
    const description = primitive.descriptionTemplate + descSuffix;

    // Build the blueprint
    const blueprint: ChallengeBlueprint = {
      id,
      name,
      description,
      category: primitive.category,
      difficulty,
      points,
      flag,
      config: {
        path, path2, path3,
        internalPath: iPath,
        fieldName, headerName,
        shortSecret, longSecret,
        tenantId, targetUserId,
        method,
        rateLimitHeader,
      },
      registerRoutes: (app, sharedCfg, state) => {
        const ctx: BuildContext = {
          rng: childRng,
          app,
          shared: sharedCfg,
          state,
          flag,
          path, path2, path3,
          internalPath: iPath,
          fieldName, headerName,
          shortSecret, longSecret,
          tenantId, targetUserId,
          method,
        };
        const docs = primitive.buildRoutes(ctx);
        endpointDocs.set(id, docs);

        // Build debug leak info
        const leak: Record<string, unknown> = { path, headerName };
        if (primitive.id.includes("ssrf") || primitive.id.includes("redirect")) {
          leak.internalPath = iPath;
          docsNotes.push(`Internal service at: ${iPath}`);
        }
        if (primitive.id === "query-lang-injection") {
          docsNotes.push(`MazeQL supports pipe (|) for chaining filters.`);
        }
        if (primitive.id === "coupon-stacking") {
          // Note: coupon codes are inside the route handler, exposed when debug is hit
        }
        if (primitive.id === "mass-assignment") {
          leak.adminField = fieldName;
          docsNotes.push(`User update uses "${fieldName}" internally for access control.`);
        }
        if (primitive.id === "tenant-isolation-bypass") {
          leak.tenantOverrideHeader = headerName;
          leak.targetTenantId = tenantId;
        }
        if (primitive.id === "state-machine-skip") {
          leak.skipHeader = headerName;
          docsNotes.push("Multi-step flows may have shortcuts.");
        }
        if (primitive.id === "permission-dag") {
          const dagCtx = ctx as any;
          if (dagCtx._dagNodes) {
            leak.permNodes = dagCtx._dagNodes;
            leak.dagEdges = dagCtx._dagEdges;
            leak.flagNode = dagCtx._flagNode;
            docsNotes.push("The permission system is a DAG. Some edges require admin role.");
          }
        }
        if (primitive.id === "rate-limit-bypass") {
          leak.rateLimitHeader = rateLimitHeader;
        }
        debugLeaks.set(id, leak);
      },
    };

    challenges.push(blueprint);
  }

  // -- Foundational challenges (always present) --
  // 1. Map the Maze (discover docs)
  const mapFlag = `FLAG{maze-map-the-maze-${rng.hex(8)}}`;
  challenges.unshift({
    id: "maze-map-the-maze",
    name: "Map the Maze",
    description: "Find the API documentation. The root page has a clue.",
    category: "misc",
    difficulty: "trivial",
    points: 50,
    flag: mapFlag,
    config: {},
    registerRoutes: () => {
      // Root page + docs registered by maze.ts directly
    },
  });

  // 2. Find the Leak (debug endpoint)
  const leakFlag = `FLAG{maze-find-the-leak-${rng.hex(8)}}`;
  challenges.splice(1, 0, {
    id: "maze-find-the-leak",
    name: "Find the Leak",
    description: "An endpoint leaks internal configuration when called with the right header. Error responses contain hints.",
    category: "sensitive-data",
    difficulty: "easy",
    points: 100,
    flag: leakFlag,
    config: {},
    registerRoutes: () => {
      // Debug endpoint registered by maze.ts directly
    },
  });

  // -- Generate decoy paths --
  const decoyCount = rng.int(30, 50);
  const decoyPaths: string[] = [];
  for (let i = 0; i < decoyCount; i++) {
    decoyPaths.push(randomPath(rng));
  }

  return {
    seed,
    challenges,
    shared,
    decoyPaths,
    endpointDocs,
    debugLeaks,
    docsNotes,
    rateLimitHeader,
  };
}
