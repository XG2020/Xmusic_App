import { spawn } from "node:child_process";

// The committed API origin is intentionally blank. Give the suite a reserved HTTPS
// root so built-in-service requests can be validated without shipping a fake host.
const env = {
  ...process.env,
  XMUSIC_BUILTIN_BASE_URL: "https://builtin.example.test",
};

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: "inherit", env });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`node ${args.join(" ")} exited with code ${code ?? 1}`));
    });
  });
}

await run(["./node_modules/vitest/vitest.mjs", "run"]);
await run(["--test", "electron/*.test.cjs"]);
