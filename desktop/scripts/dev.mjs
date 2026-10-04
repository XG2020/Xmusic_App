import { createServer } from "vite";
import { spawn } from "node:child_process";
import electron from "electron";

const server = await createServer();
await server.listen();
server.printUrls();
const environment = {
  ...process.env,
  VITE_DEV_SERVER_URL: "http://127.0.0.1:5173",
};
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ["."], { stdio: "inherit", env: environment });
let closing = false;
async function stop(code = 0) {
  if (closing) return;
  closing = true;
  child.kill();
  await server.close();
  process.exit(code);
}
child.on("exit", (code) => {
  void stop(code ?? 0);
});
child.on("error", (error) => {
  console.error(error);
  void stop(1);
});
process.on("SIGINT", () => {
  void stop();
});
process.on("SIGTERM", () => {
  void stop();
});
