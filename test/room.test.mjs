import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const db = join(mkdtempSync(join(tmpdir(), "codex-room-test-")), "chat.db");
async function connect() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [root + "/src/server.mjs"],
    env: { ...process.env, CODEX_AGENT_ROOM_DB: db },
    stderr: "pipe",
  });
  const client = new Client({ name: "room-tests", version: "1.0" });
  let errors = "";
  transport.stderr?.on("data", (data) => (errors += data));
  await client.connect(transport);
  async function call(name, args = {}) {
    const r = await client.callTool({ name, arguments: args });
    assert.ok(!r.isError, r.content?.[0]?.text + "\n" + errors);
    return r.structuredContent;
  }
  return { client, call };
}
test("原版群聊内嵌资源、真人发言、Codex身份与重启持久化", async () => {
  const { client, call } = await connect();
  let room;
  try {
    const open = await call("room_open");
    room = open.room;
    const resources = await client.readResource({
      uri: "ui://codex-agent-room/chat.html",
    });
    const html = resources.contents[0].text;
    assert.match(html, /AI 协作群/);
    assert.match(html, /id="msgs"/);
    assert.match(html, /app\.callServerTool|callServerTool/);
    assert.ok(!html.includes("@import url("));
    assert.ok(!html.includes("fonts.googleapis.com"));
    assert.match(html, /message-avatar/);
    assert.match(html, /team-panel/);
    await call("room_post", {
      room_id: room.id,
      text: "独立测试计划",
      message_key: "test-plan",
    });
    await call("room_post", {
      room_id: room.id,
      text: "独立测试计划",
      message_key: "test-plan",
    });
    const join = await call("room_view_api", {
      path: "/api/join",
      method: "POST",
      body: JSON.stringify({
        room: room.id,
        base_name: "Tester",
        operation_id: "31783f25-e8eb-4670-882a-c5f88078e080",
      }),
    });
    assert.equal(join.status, 200, JSON.stringify(join.data));
    assert.ok(join.data.agent_id, JSON.stringify(join.data));
    const human = await call("room_view_api", {
      path: "/api/post",
      method: "POST",
      body: JSON.stringify({
        room: room.id,
        agent_id: join.data.agent_id,
        body: "用户消息，Codex 请处理",
        client_message_id: "human-post",
      }),
    });
    assert.equal(human.status, 200, JSON.stringify(human.data));
    const history = await call("room_read", { room_id: room.id });
    assert.equal(history.messages.length, 2);
    assert.equal(
      history.messages.filter((x) => x.content === "独立测试计划").length,
      1,
    );
    const humanMessage = history.messages.find((x) =>
      x.content.startsWith("用户"),
    );
    assert.equal(humanMessage.from, join.data.agent_id);
    assert.equal(
      history.members.find((x) => x.id === humanMessage.from).is_human,
      true,
    );
    for (const path of [
      "/api/delete-room",
      "https://example.com/api/rooms",
      "//example.com/api/rooms",
    ]) {
      const rejected = await client.callTool({
        name: "room_view_api",
        arguments: { path, method: "POST", body: "{}" },
      });
      assert.equal(rejected.isError, true);
    }
    const list = await call("room_view_api", { path: "/api/rooms" });
    assert.equal(list.data.rooms.length, 1);
  } finally {
    await client.close();
  }
  const again = await connect();
  try {
    assert.equal((await again.call("room_open")).room.id, room.id);
    const history = await again.call("room_read", { room_id: room.id });
    assert.equal(history.messages.length, 2);
  } finally {
    await again.client.close();
  }
});
test("任务号去重、跨群防混淆、异常退出与验收状态", async () => {
  const { client, call } = await connect();
  const sql = new Database(db);
  try {
    const { room } = await call("room_open");
    sql
      .prepare(
        "INSERT INTO codex_room_jobs(id,room_id,task,context,model,state,pid,updated_at) VALUES (?,?,?,?,?,'running',?,datetime('now','-6 minutes'))",
      )
      .run("stale-fixture", room.id, "test fixture", "", "test", process.pid);
    const stale = (await call("room_read", { room_id: room.id })).tasks.find(
      (x) => x.id === "stale-fixture",
    );
    assert.equal(stale.state, "failed");
    const invalid = await client.callTool({
      name: "room_review",
      arguments: {
        room_id: room.id,
        task_id: "stale-fixture",
        verdict: "accepted",
        note: "不能验收失败任务",
      },
    });
    assert.equal(invalid.isError, true);
    const result = await call("room_post", {
      room_id: room.id,
      text: "仅测试：模拟已交付状态以验证验收闸门",
    });
    sql
      .prepare(
        "INSERT INTO codex_room_jobs(id,room_id,task,context,model,state,result_seq) VALUES (?,?,?,?,?,'done',?)",
      )
      .run("done-fixture", room.id, "test fixture", "", "test", result.seq);
    const accepted = await call("room_review", {
      room_id: room.id,
      task_id: "done-fixture",
      verdict: "accepted",
      note: "仅测试数据库验收转换",
    });
    assert.equal(accepted.state, "accepted");
    const repeated = await call("room_review", {
      room_id: room.id,
      task_id: "done-fixture",
      verdict: "accepted",
      note: "仅测试数据库验收转换",
    });
    assert.equal(repeated.seq, accepted.seq);
    const existing = await call("room_dispatch", {
      room_id: room.id,
      request_id: "done-fixture",
      task: "test fixture",
      context: "",
    });
    assert.equal(existing.reused, true);
    assert.equal(existing.state, "accepted");
    const other = (await call("room_create", { name: "另一测试群" })).room;
    const conflict = await client.callTool({
      name: "room_dispatch",
      arguments: {
        room_id: other.id,
        request_id: "done-fixture",
        task: "test fixture",
        context: "",
      },
    });
    assert.equal(conflict.isError, true);
    sql
      .prepare(
        "INSERT INTO codex_room_jobs(id,room_id,task,context,model,state,result_seq) VALUES (?,?,?,?,?,'needs_revision',?)",
      )
      .run(
        "revised-fixture",
        room.id,
        "test revised fixture",
        "",
        "test",
        result.seq,
      );
    assert.equal(
      (
        await call("room_review", {
          room_id: room.id,
          task_id: "revised-fixture",
          verdict: "accepted",
          note: "仅测试修订后验收",
        })
      ).state,
      "accepted",
    );
  } finally {
    sql.close();
    await client.close();
  }
});
