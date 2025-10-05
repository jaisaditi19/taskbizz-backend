// scripts/migrate-orgs.js
/* eslint-disable no-console */
const { spawn } = require("node:child_process");
const { Pool } = require("pg");
const path = require("path");

// Use the current Node binary and Prisma CLI JS entry (avoid PATH issues)
const NODE_BIN = process.execPath;
const PRISMA_CLI = require.resolve("prisma/build/index.js");

// small delay between tenants (be gentle on DB)
const SLEEP_MS = 400;

// ---------- helpers ----------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Run a command with a **minimal env** (do NOT spread process.env)
function run(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit", env });
    p.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${path.basename(cmd)} exited ${code}`))
    );
    p.on("error", (err) => reject(err));
  });
}

// Build tenant DB URL.
// Preferred: ORG_DB_BASE_URL (e.g. "postgresql://user:pass@host:port")
// Fallback: DB_USER / DB_PASS / DB_HOST / DB_PORT
// Appends "?schema=public" and optionally "&sslmode=require".
function getTenantUrl(dbName) {
  if (!dbName) throw new Error("dbName is required");

  const sslSuffix =
    process.env.ORG_DB_SSLMODE_REQUIRE === "true" ? "&sslmode=require" : "";
  const query = `?schema=public${sslSuffix}`;

  const base = process.env.ORG_DB_BASE_URL;
  if (base) {
    const safeBase = base.replace(/\/+$/, ""); // strip trailing slashes
    return `${safeBase}/${encodeURIComponent(dbName)}${query}`;
  }

  const user = process.env.DB_USER;
  const pass = process.env.DB_PASS;
  const host = process.env.DB_HOST;
  const port = process.env.DB_PORT || "5432";
  if (!user || !pass || !host) {
    throw new Error(
      "DB_USER/DB_PASS/DB_HOST must be set for tenant URLs (or set ORG_DB_BASE_URL)."
    );
  }

  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(
    pass
  )}@${host}:${port}/${encodeURIComponent(dbName)}${query}`;
}

const FETCH_ORG_NAMES_SQL = `
  SELECT "dbName" AS db_name
  FROM "Organization"
  WHERE "dbName" IS NOT NULL
`;

// Read org names from the **core** DB using CORE_DATABASE_URL
async function fetchOrgDbNames() {
  const CORE_URL = process.env.CORE_DATABASE_URL;
  if (!CORE_URL)
    throw new Error("CORE_DATABASE_URL is required to read organizations.");

  const pool = new Pool({
    connectionString: CORE_URL,
    ssl: { rejectUnauthorized: false }, // set true if you have a trusted CA
  });

  try {
    const res = await pool.query(FETCH_ORG_NAMES_SQL);
    return res.rows.map((r) => (r.db_name || "").trim()).filter(Boolean);
  } finally {
    await pool.end();
  }
}

// Migrate a single tenant DB (status -> deploy; ignore status failures)
async function migrateOne(tenantUrl) {
  console.log(`\n🔧 Migrating org DB:\n  DATABASE_URL=${tenantUrl}\n`);

  // Minimal env for Prisma (avoid leaking parent env)
  const prismaEnv = {
    NODE_ENV: "production",
    DATABASE_URL: tenantUrl,
    DIRECT_URL: tenantUrl, // prevent using any leaked DIRECT_URL
    PRISMA_MIGRATE_SKIP_GENERATE: "1", // faster deploy
  };

  // 1) Best-effort status (may exit non-zero if pending migrations; that's fine)
  try {
    await run(
      NODE_BIN,
      [
        PRISMA_CLI,
        "migrate",
        "status",
        "--schema",
        "prisma/org/org-schema.prisma",
      ],
      prismaEnv
    );
  } catch {
    console.log(
      "ℹ️ migrate status reported pending or warnings; proceeding to deploy…"
    );
  }

  // 2) Apply migrations (the real action)
  await run(
    NODE_BIN,
    [
      PRISMA_CLI,
      "migrate",
      "deploy",
      "--schema",
      "prisma/org/org-schema.prisma",
    ],
    prismaEnv
  );

  console.log("✅ Done");
}

// ---------- main ----------
(async () => {
  try {
    const names = await fetchOrgDbNames();
    if (!names.length) {
      console.log("ℹ️ No org databases found. Skipping org migrations.");
      return;
    }
    console.log(`Found ${names.length} org DB(s).`);

    const urls = names.map(getTenantUrl);

    let ok = 0;
    let fail = 0;

    for (const url of urls) {
      try {
        await migrateOne(url);
        ok += 1;
      } catch (e) {
        fail += 1;
        console.error(`❌ Migration failed for ${url}`);
        console.error(e?.message || e);
      }
      await sleep(SLEEP_MS);
    }

    console.log(
      `\n🎉 Org migrations complete. Success: ${ok}, Failed: ${fail}`
    );
    if (fail > 0) process.exit(1);
  } catch (e) {
    console.error("Fatal:", e?.message || e);
    process.exit(1);
  }
})();
