import { readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const client = new Client({ name: "design-review", version: "0.2.0" });
const env = { ...process.env };
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.mjs"],
    env,
  }),
);
async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(r.content[0].text);
  return r.structuredContent;
}
try {
  const { room } = await call("room_create", { name: "产品设计小队" });
  await call("room_post", {
    room_id: room.id,
    text: "这轮把协作群调整成微信式的浅色界面。\n\n我负责消息气泡、头像和输入区，保留真实派活与验收流程。请 Gemini 独立检查信息层级、成员状态和窄屏交互。",
    message_key: "design-intro-v2",
  });
  const context =
    "视觉方向：浅色、简洁、绿色点缀。左侧群列表、中间聊天气泡、右侧可收起成员栏与任务卡。成员状态必须如实显示，不假装在线。长消息可展开，Enter发送、Shift+Enter换行。下方是样式和桥接实现，未提供截图，不能声称看过界面。\n" +
    readFileSync("src/theme.css", "utf8") +
    "\n" +
    readFileSync("src/bridge.mjs", "utf8");
  const task = await call("room_dispatch", {
    room_id: room.id,
    request_id: "design-ui-review-v2",
    task: "独立检查这轮浅色群聊交互。请只返回最多三条最重要、可落实的建议，总共不超过260字。对照提供的 CSS/JS 判断，不编造已运行的测试。",
    context,
  });
  console.log(JSON.stringify({ room_id: room.id, task }));
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const r = await call("room_read", { room_id: room.id });
    const job = r.tasks.find((x) => x.id === task.id);
    if (["done", "failed", "accepted", "needs_revision"].includes(job?.state)) {
      writeFileSync("review-design.json", JSON.stringify(r, null, 2));
      console.log(
        JSON.stringify({
          state: job.state,
          result: r.messages.find((x) => x.seq === job.result_seq)?.content,
          error: job.error,
        }),
      );
      if (job.state === "failed") process.exitCode = 1;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
} finally {
  await client.close();
}
