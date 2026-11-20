import { readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["src/server.mjs"],
  env: process.env,
  stderr: "pipe",
});
const client = new Client({
  name: "installation-verification",
  version: "1.0",
});
await client.connect(transport);
async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(r.content[0].text);
  return r.structuredContent;
}
try {
  const { room } = await call("room_open");
  const context = ["room.mjs", "server.mjs", "worker.mjs", "bridge.mjs"]
    .map((file) => `FILE ${file}\n${readFileSync("src/" + file, "utf8")}`)
    .join("\n\n");
  await call("room_post", {
    room_id: room.id,
    text: "安装验收：我正在让独立 Gemini 员工审查群聊适配代码，重点检查身份、任务状态、重复派活和安全边界。这里只记录实际 API 执行和真实回报。",
    message_key: "installation-intro-v1",
  });
  const job = await call("room_dispatch", {
    room_id: room.id,
    task: "审查群聊插件的实现，找出具体可复现的高优先级缺陷，重点是任务重复执行、跨群混淆、消息身份和进程生命周期。只列真实代码依据，不把未执行的测试说成执行过。请用中文给出最多五项问题及最小修复建议。",
    context,
    request_id: "installation-review-v1",
  });
  console.log(JSON.stringify({ room_id: room.id, job }));
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const result = await call("room_read", { room_id: room.id });
    const task = result.tasks.find((t) => t.id === job.id);
    if (["done", "failed"].includes(task?.state)) {
      writeFileSync("review-result.json", JSON.stringify(result, null, 2));
      console.log(
        JSON.stringify({
          state: task.state,
          error: task.error,
          result_seq: task.result_seq,
        }),
      );
      if (task.state === "failed") process.exitCode = 1;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
} finally {
  await client.close();
}
