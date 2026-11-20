import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const root = fileURLToPath(new URL("..", import.meta.url));
if (!existsSync(resolve(root, "dist/view.html")))
  throw new Error("先运行 npm run build，再运行 npm run setup。");
const configPath = resolve(root, ".mcp.json");
const config = existsSync(configPath)
  ? JSON.parse(readFileSync(configPath, "utf8"))
  : {};
const previous = config.mcpServers?.["agent-room"] || {};
const dbIndex = process.argv.indexOf("--db");
if (dbIndex >= 0 && !process.argv[dbIndex + 1])
  throw new Error("--db 后需要提供数据库路径");
const env = { ...(previous.env || {}) };
if (dbIndex >= 0) env.CODEX_AGENT_ROOM_DB = resolve(process.argv[dbIndex + 1]);
config.mcpServers = {
  ...config.mcpServers,
  "agent-room": {
    command: process.execPath,
    args: [resolve(root, "src/server.mjs")],
    ...(Object.keys(env).length ? { env } : {}),
  },
};
writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", {
  mode: 0o600,
});
console.log("本机 MCP 配置已生成。保留了现有配置；没有写入 API 密钥。");
console.log("MCP server: " + resolve(root, "src/server.mjs"));
