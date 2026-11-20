import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  store,
  jobs,
  dbPath,
  upstream,
  ensureRoom,
  leader,
  post,
  read,
  taskList,
  close,
} from "./room.mjs";

const server = new McpServer({ name: "codex-agent-room", version: "0.2.0" });
const uri = "ui://codex-agent-room/chat.html";
ensureRoom();
let viewer, viewerReady;
function getViewer() {
  if (viewerReady) return viewerReady;
  viewerReady = new Promise((resolve, reject) => {
    viewer = spawn(process.execPath, [upstream + "web/server.mjs"], {
      env: {
        ...process.env,
        AGENT_CHAT_DB: dbPath,
        AGENT_CHAT_VIEWER_PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(
      () => reject(new Error("群聊数据连接启动超时")),
      12000,
    );
    viewer.stdout.on("data", (chunk) => {
      const match = String(chunk).match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
    viewer.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    viewer.once("exit", () => {
      clearTimeout(timer);
      viewerReady = null;
      reject(new Error("群聊数据连接已退出，请重试"));
    });
  });
  return viewerReady;
}
function tool(name, description, schema, action, readonly = false, meta = {}) {
  server.registerTool(
    name,
    {
      description,
      inputSchema: z.object(schema).strict(),
      annotations: {
        readOnlyHint: readonly,
        destructiveHint: false,
        openWorldHint: name === "room_dispatch",
      },
      _meta: meta,
    },
    async (args) => {
      try {
        const value = await action(args);
        return {
          content: [{ type: "text", text: JSON.stringify(value) }],
          structuredContent: value,
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: error.message }],
        };
      }
    },
  );
}
const roomId = z.number().int().positive();
tool(
  "room_open",
  "打开 Codex 内的多 Agent 聊天群。默认共享 AI 协作群；派活、讨论、交付记录跨聊天保留。",
  {},
  () => ({ room: ensureRoom(), leader: leader.id }),
  true,
  {
    ui: { resourceUri: uri },
    "openai/outputTemplate": uri,
    "openai/ui": { entrypoints: [{ type: "thread" }, { type: "global" }] },
  },
);
tool(
  "room_create",
  "创建或打开一个按目标命名的协作群。",
  { name: z.string().trim().min(1).max(200) },
  ({ name }) => ({ room: ensureRoom(name) }),
);
tool(
  "room_read",
  "阅读群内最近消息及任务状态。读取 Gemini 完成交付后，需由 Codex 验收并在群中发结论。",
  {
    room_id: roomId,
    limit: z.number().int().min(1).max(100).default(60),
    before_seq: z.number().int().positive().optional(),
  },
  ({ room_id, limit, before_seq }) => ({
    room: store.getRoom(room_id),
    ...read(room_id, limit, before_seq),
    members: store.listAgents(room_id, 5).agents,
    tasks: taskList(room_id),
  }),
  true,
);
tool(
  "room_post",
  "以当前 Codex 负责人身份向群里发布计划、讨论、进度或验收结论；不能冒充 Gemini 发言。",
  {
    room_id: roomId,
    text: z.string().min(1).max(50000),
    reply_to_seq: z.number().int().positive().optional(),
    message_key: z.string().min(1).max(150).optional(),
  },
  ({ room_id, text, reply_to_seq, message_key }) =>
    post(room_id, text, reply_to_seq ?? null, message_key ?? null),
);
tool(
  "room_dispatch",
  "向独立 Gemini API 员工派发分析、整理或审查任务，立即返回任务号。员工在后台实际调用 Gemini 并自行把结果写入群聊；当前无本机工具权限。材料必须明确提供，勿包含密钥。稍后用 room_read 验收，不能把 queued 当作完成。",
  {
    room_id: roomId,
    task: z.string().min(1).max(12000),
    context: z.string().max(120000).default(""),
    request_id: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,100}$/)
      .optional(),
  },
  ({ room_id, task, context, request_id }) => {
    if (!store.getRoom(room_id)) throw new Error("聊天室不存在");
    const id = request_id || randomUUID();
    const existing = jobs
      .prepare("SELECT * FROM codex_room_jobs WHERE id=?")
      .get(id);
    if (existing) {
      if (
        existing.room_id !== room_id ||
        existing.task !== task ||
        existing.context !== context
      )
        throw new Error("任务号已用于不同内容，请使用新的任务号");
      return { id, state: existing.state, reused: true };
    }
    const model = process.env.GEMINI_MODEL || "gemini-3.6-flash";
    if (!/^[a-zA-Z0-9._-]{1,100}$/.test(model))
      throw new Error("GEMINI_MODEL 必须是有效的模型标识");
    jobs
      .prepare(
        "INSERT INTO codex_room_jobs (id,room_id,task,context,model) VALUES (?,?,?,?,?)",
      )
      .run(id, room_id, task, context, model);
    post(room_id, `@Gemini\n${task}`, null, `${id}:assignment`);
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./worker.mjs", import.meta.url)), id],
      {
        env: { ...process.env, CODEX_AGENT_ROOM_DB: dbPath },
        detached: true,
        stdio: "ignore",
      },
    );
    child.once("error", () => {
      jobs
        .prepare(
          "UPDATE codex_room_jobs SET state='failed',error='无法启动员工进程' WHERE id=?",
        )
        .run(id);
    });
    jobs
      .prepare("UPDATE codex_room_jobs SET pid=? WHERE id=?")
      .run(child.pid ?? null, id);
    child.unref();
    return {
      id,
      state: "queued",
      note: "独立员工已派发，使用 room_read 等待真实交付后验收。",
    };
  },
);
tool(
  "room_review",
  "读取并核实 Gemini 交付后，由 Codex 发布验收结果。不能在员工尚未交付时验收。",
  {
    room_id: roomId,
    task_id: z.string().min(1).max(100),
    verdict: z.enum(["accepted", "needs_revision"]),
    note: z.string().min(1).max(12000),
  },
  ({ room_id, task_id, verdict, note }) => {
    const task = jobs
      .prepare("SELECT * FROM codex_room_jobs WHERE id=? AND room_id=?")
      .get(task_id, room_id);
    if (!task) throw new Error("此群中找不到该任务");
    if (!["done", "needs_revision", verdict].includes(task.state))
      throw new Error(
        "只有员工已交付或已核实修订的任务才能验收；失败或执行中的任务不能标为完成。",
      );
    const message = post(
      room_id,
      `${verdict === "accepted" ? "验收通过" : "需要修订"}\n\n${note}`,
      task.result_seq,
      `${task_id}:review-${verdict}`,
    );
    jobs
      .prepare(
        "UPDATE codex_room_jobs SET state=?,updated_at=datetime('now') WHERE id=?",
      )
      .run(verdict, task_id);
    return { id: task_id, state: verdict, seq: message.seq };
  },
);
// Preserve the original viewer API. Only bounded, explicitly listed local routes
// are available; never accept an arbitrary URL or expose its deletion endpoint.
const reads = new Set([
  "/api/rooms",
  "/api/room",
  "/api/room-exists",
  "/api/messages",
  "/api/me",
  "/api/search",
]);
const writes = new Set(["/api/join", "/api/leave", "/api/read", "/api/post"]);
tool(
  "room_view_api",
  "内嵌聊天面板专用的原版 Agent Chat 数据接口。禁止删除操作。",
  {
    path: z.string().max(3000),
    method: z.enum(["GET", "POST"]).default("GET"),
    body: z.string().max(150000).optional(),
  },
  async ({ path, method, body }) => {
    if (!path.startsWith("/api/") || path.startsWith("//"))
      throw new Error("只允许本机群聊接口");
    const parsed = new URL(path, "http://room.invalid");
    if (
      parsed.origin !== "http://room.invalid" ||
      !(method === "GET" ? reads : writes).has(parsed.pathname)
    )
      throw new Error("未开放此接口；删除群聊需要单独征得用户同意。");
    const base = await getViewer();
    const response = await fetch(base + parsed.pathname + parsed.search, {
      method,
      body: method === "POST" ? body : undefined,
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    const data = await response.json();
    return { status: response.status, data };
  },
  false,
  { ui: { visibility: ["app"] } },
);
tool(
  "room_tasks",
  "内嵌面板读取成员与任务状态。",
  { room_id: roomId },
  ({ room_id }) => ({
    tasks: taskList(room_id),
    members: store.listAgents(room_id, 5).agents,
  }),
  true,
  { ui: { visibility: ["app"] } },
);
server.registerResource(
  "agent-room",
  uri,
  { mimeType: "text/html;profile=mcp-app" },
  async () => ({
    contents: [
      {
        uri,
        mimeType: "text/html;profile=mcp-app",
        text: readFileSync(
          new URL("../dist/view.html", import.meta.url),
          "utf8",
        ),
        _meta: {
          ui: { csp: { connectDomains: [], resourceDomains: [] } },
          "openai/ui": {
            preferredDisplayMode: "fullscreen",
            availableDisplayModes: ["inline", "fullscreen", "pip"],
          },
        },
      },
    ],
  }),
);
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  viewer?.kill();
  close();
}
process.on("exit", shutdown);
process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});
process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});
process.stdin.on("end", () => {
  shutdown();
  process.exit(0);
});
await server.connect(new StdioServerTransport());
