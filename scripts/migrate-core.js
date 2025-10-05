const { spawn } = require("node:child_process");

function run(cmd, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit", env });
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(cmd + " exited " + code))
    );
  });
}

(async () => {
  if (!process.env.DATABASE_URL)
    throw new Error("CORE_DATABASE_URL is required");
  const env = { ...process.env, DATABASE_URL: process.env.DATABASE_URL };
  console.log("🔧 Running CORE migrations (prisma/schema.prisma) ...");
  await run(
    "npx",
    ["prisma", "migrate", "deploy", "--schema", "prisma/schema.prisma"],
    env
  );
  console.log("✅ CORE migrations complete");
})();
