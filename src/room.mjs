import { ChatStore } from "../vendor/agent-chat/dist/db.js";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";

export const upstream = fileURLToPath(
  new URL("../vendor/agent-chat/", import.meta.url),
);
export const dbPath =
  process.env.CODEX_AGENT_ROOM_DB ||
  join(homedir(), ".codex-agent-room", "chat.db");
mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
export const store = new ChatStore(resolve(dbPath));
export const jobs = new Database(dbPath);
jobs.pragma("busy_timeout = 5000");
jobs.exec(`CREATE TABLE IF NOT EXISTS codex_room_jobs (
 id TEXT PRIMARY KEY, room_id INTEGER NOT NULL REFERENCES rooms(id), task TEXT NOT NULL,
 context TEXT NOT NULL, model TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
 pid INTEGER, result_seq INTEGER, error TEXT, created_at TEXT DEFAULT (datetime('now')),
 updated_at TEXT DEFAULT (datetime('now'))
)`);

export function persona(kind, model = "Codex desktop", version = "unreported") {
  const connectionId = randomUUID();
  const { persona } = store.identifyPersona({
    connectionId,
    brand: kind === "Gemini" ? "Google" : "OpenAI",
    model,
    version,
    description:
      kind === "Gemini"
        ? "独立 Gemini API 员工：按任务材料分析、整理、审查；没有本机执行权限。"
        : "Codex 调度与验收；通过当前 Codex 会话工作。",
    expected: null,
    nextCandidateId: () => `${kind}-${randomUUID().slice(0, 8)}`,
  });
  return { id: persona.id, connectionId };
}

export let leader = null;
export function getLeader() {
  return (leader ||= persona("Codex"));
}
export function ensureRoom(name = "AI 协作群") {
  getLeader();
  let room = store.getRoomByName(name);
  if (!room) {
    try {
      room = store.createRoom(
        name,
        "你发布目标，Codex 拆分任务，Gemini 独立处理并在群里回报。",
        "Codex 负责分工与验收。Gemini 根据明确提供的材料独立分析、整理、审查，当前没有本机文件或终端权限。群消息和任务记录保存在本机。",
        leader.id,
      );
    } catch (error) {
      room = store.getRoomByName(name);
      if (!room) throw error;
    }
  }
  store.joinRoom(room.id, leader.id, { role: "调度与验收" });
  return room;
}
export function post(
  roomId,
  body,
  replyTo = null,
  key = null,
  actor = getLeader().id,
  mentions = null,
) {
  store.joinRoom(roomId, actor);
  return store.postMessage(
    roomId,
    actor,
    body,
    "text",
    mentions,
    replyTo,
    null,
    { clientMessageId: key },
  );
}
export function read(roomId, limit = 60, before) {
  if (!store.getRoom(roomId)) throw new Error("聊天室不存在，请先打开群聊。");
  return store.readHistory(roomId, limit, before, undefined, 100000);
}
export function taskList(roomId) {
  const rows = jobs
    .prepare(
      "SELECT id, room_id, model, state, pid, result_seq, error, created_at, updated_at, substr(task,1,200) AS task FROM codex_room_jobs WHERE room_id=? ORDER BY created_at DESC, rowid DESC LIMIT 30",
    )
    .all(roomId);
  for (const row of rows) {
    if (["queued", "running"].includes(row.state)) {
      let alive = false;
      if (row.pid) {
        try {
          process.kill(row.pid, 0);
          alive = true;
        } catch {}
      }
      // Allow the dispatcher time to attach its child's PID. Do not silently re-run work.
      const age =
        Date.now() - Date.parse(row.updated_at.replace(" ", "T") + "Z");
      // The worker has a 30s keychain + 180s API deadline. A bounded stale
      // deadline also catches PID reuse by an unrelated process.
      if ((!alive && age > 15000) || age > 300000) {
        jobs
          .prepare(
            "UPDATE codex_room_jobs SET state='failed',error='员工进程已退出；请检查后显式重派。',updated_at=datetime('now') WHERE id=? AND state IN ('queued','running')",
          )
          .run(row.id);
        row.state = "failed";
        row.error = "员工进程已退出；请检查后显式重派。";
      }
    }
  }
  return rows;
}
export function close() {
  if (leader)
    store.retireConnection({
      agentId: leader.id,
      connectionId: leader.connectionId,
    });
  jobs.close();
  store.close();
}
