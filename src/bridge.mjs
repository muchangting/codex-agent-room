import { App } from "@modelcontextprotocol/ext-apps";
import { marked } from "marked";
import DOMPurify from "dompurify";
window.__roomMarkdown = (element, text) => {
  element.innerHTML = DOMPurify.sanitize(
    marked.parse(text, { gfm: true, breaks: true }),
    {
      FORBID_TAGS: [
        "style",
        "svg",
        "math",
        "iframe",
        "form",
        "input",
        "button",
        "img",
        "video",
        "audio",
      ],
      FORBID_ATTR: ["style"],
    },
  );
  for (const a of element.querySelectorAll("a")) {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  }
};
const app = new App({ name: "AI 协作群", version: "0.2.0" }, {});
const ready = app.connect();
let selectedRoom = 0,
  lastRequest = null,
  tasksBusy = false;
const $ = (id) => document.getElementById(id);
function status(text) {
  $("host-status").textContent = text;
  $("host-status").title = text;
}
async function call(name, args = {}) {
  await ready;
  const result = await app.callServerTool({ name, arguments: args });
  if (result.isError)
    throw new Error(
      result.content?.find((c) => c.type === "text")?.text || "群聊连接失败",
    );
  return (
    result.structuredContent ||
    JSON.parse(result.content.find((c) => c.type === "text").text)
  );
}
async function askLeader(room, seq) {
  if (!room) throw new Error("请先选择一个群聊");
  lastRequest = { room, seq };
  const result = await app.sendMessage({
    role: "user",
    content: [
      {
        type: "text",
        text: `请处理 AI 协作群 room_id=${room}${seq ? ` 的用户消息 #${seq}` : " 中尚未处理的用户消息"}。先用 room_read 阅读真实记录；用 room_post 公开计划，按需求用 room_dispatch 给 Gemini 派发独立任务，读取真实回报后用 room_review 验收并在群里总结。不要重复执行已处理的消息；不要把排队当完成或编造员工发言。`,
      },
    ],
  });
  if (result.isError)
    throw new Error("Codex 尚未接受请求，可点“请 Codex 跟进”重试");
  lastRequest = null;
  status("消息已送达 Codex 会话");
}
window.fetch = async (input, options = {}) => {
  const path = typeof input === "string" ? input : input.url;
  if (!path.startsWith("/api/"))
    throw new Error("群聊仅通过 Codex 内嵌连接通信");
  const method = options.method || "GET",
    url = new URL(path, "http://room.invalid");
  if (url.pathname === "/api/room") {
    selectedRoom = Number(url.searchParams.get("id")) || 0;
    $("task-summary").replaceChildren();
    $("member-list").replaceChildren();
    $("task-count").textContent = "";
  }
  const reply = await call("room_view_api", {
    path,
    method,
    ...(options.body ? { body: options.body } : {}),
  });
  if (url.pathname === "/api/rooms" && Array.isArray(reply.data.rooms))
    $("conversation-count").textContent = reply.data.rooms.length || "";
  if (
    url.pathname === "/api/post" &&
    reply.status === 200 &&
    !reply.data.error
  ) {
    const payload = JSON.parse(options.body);
    askLeader(payload.room, reply.data.seq).catch((error) =>
      status(`消息已保存 · ${error.message}`),
    );
  }
  if (url.pathname === "/api/room") refreshTasks();
  return new Response(JSON.stringify(reply.data), {
    status: reply.status,
    headers: { "Content-Type": "application/json" },
  });
};
const labels = {
  queued: "等待接单",
  running: "执行中",
  done: "等待验收",
  accepted: "已验收",
  needs_revision: "待修订",
  failed: "未完成",
};
function node(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}
function renderTasks(tasks, room) {
  const list = $("task-summary");
  list.replaceChildren();
  $("task-count").textContent = tasks.length || "";
  if (!tasks.length) {
    list.append(
      node("p", "empty-note", "暂时没有任务，和团队聊聊你的想法吧。"),
    );
    return;
  }
  for (const task of tasks.slice(0, 12)) {
    const card = node("details", "task-card"),
      summary = node("summary"),
      top = node("div", "task-top");
    top.append(
      node("span", "", "Gemini"),
      node(
        "span",
        "task-badge " + task.state,
        labels[task.state] || task.state,
      ),
    );
    summary.append(top, node("div", "task-title", task.task));
    card.append(summary);
    const detail = node(
      "div",
      "task-detail",
      task.error || "由 Codex 分配，交付后由 Codex 核对验收。",
    );
    detail.append(
      node(
        "div",
        "",
        new Date(task.created_at.replace(" ", "T") + "Z").toLocaleString(
          "zh-CN",
          {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          },
        ),
      ),
    );
    if (task.result_seq) {
      const view = node("button", "", "查看交付消息 →");
      view.onclick = () => {
        if (selectedRoom === room) window.__roomJump?.(task.result_seq);
      };
      detail.append(view);
    }
    card.append(detail);
    list.append(card);
  }
}
function renderMembers(members, tasks) {
  const items = [];
  const humans = members.filter((m) => m.is_human && m.present);
  for (const m of humans.slice(0, 8))
    items.push({
      kind: "human",
      avatar: "我",
      name: m.id.replace(/^human-/, "").replace(/-\d+$/, ""),
      role: "一起创造的人",
      state: "用户",
    });
  items.push({
    kind: "codex",
    avatar: "C",
    name: "Codex",
    role: "统筹 · 实现 · 验收",
    state: "负责人",
  });
  items.push({
    kind: "gemini",
    avatar: "G",
    name: "Gemini",
    role: "分析 · 整理 · 独立审查",
    state: tasks.some((t) => ["queued", "running"].includes(t.state))
      ? "执行中"
      : "按需接单",
  });
  const list = $("member-list");
  list.replaceChildren();
  $("member-count").textContent = items.length;
  for (const item of items) {
    const row = node("div", "member-item"),
      identity = node("div");
    identity.append(
      node("div", "member-name", item.name),
      node("div", "member-role", item.role),
    );
    row.append(
      node("div", "member-avatar " + item.kind, item.avatar),
      identity,
      node(
        "span",
        "member-status" + (item.state === "执行中" ? " busy" : ""),
        item.state,
      ),
    );
    list.append(row);
  }
}
async function refreshTasks() {
  if (!selectedRoom || tasksBusy) return;
  tasksBusy = true;
  const room = selectedRoom;
  try {
    const data = await call("room_tasks", { room_id: room });
    if (room !== selectedRoom) return;
    renderTasks(data.tasks, room);
    renderMembers(data.members || [], data.tasks);
  } catch (error) {
    status(error.message);
  } finally {
    tasksBusy = false;
  }
}
$("call-leader").onclick = () =>
  askLeader(
    selectedRoom,
    lastRequest?.room === selectedRoom ? lastRequest.seq : null,
  ).catch((error) => status(error.message));
$("new-room-button").onclick = () => {
  $("new-room-dialog").showModal();
  $("new-room-name").focus();
};
$("new-room-dialog").addEventListener("submit", (event) => {
  if (event.submitter?.value !== "cancel") {
    event.preventDefault();
    $("create-room").click();
  }
});
$("create-room").onclick = async () => {
  const input = $("new-room-name"),
    button = $("create-room");
  if (!input.reportValidity() || !input.value.trim()) return;
  button.disabled = true;
  $("create-error").textContent = "";
  try {
    const result = await call("room_create", { name: input.value.trim() });
    input.value = "";
    $("new-room-dialog").close();
    await window.__roomSelect?.(result.room.id);
    status("新的协作已开始");
  } catch (error) {
    $("create-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
};
$("toggle-team").onclick = () => document.body.classList.toggle("team-visible");
$("close-team").onclick = () => document.body.classList.remove("team-visible");
$("rail-tasks").onclick = () => {
  document.body.classList.add("team-visible");
  $("task-summary").scrollIntoView({ block: "nearest" });
};
$("rail-chat").onclick = () => {
  document.body.classList.remove("team-visible");
  if (matchMedia("(max-width:620px)").matches)
    document.body.classList.toggle("show-rooms");
};
$("about-button").onclick = () => $("about-dialog").showModal();
for (const member of ["codex", "gemini"])
  $("mention-" + member).onclick = () => {
    const input = $("compose-text");
    const mention = member === "codex" ? "@Codex " : "@Gemini ";
    const start = input.selectionStart ?? input.value.length,
      end = input.selectionEnd ?? start;
    input.value =
      input.value.slice(0, start) + mention + input.value.slice(end);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
    input.selectionStart = input.selectionEnd = start + mention.length;
  };
try {
  const saved = localStorage.getItem("agent-room.nickname");
  if (saved) $("join-name").value = saved;
} catch {}
$("join-name").addEventListener("change", (event) => {
  try {
    localStorage.setItem("agent-room.nickname", event.target.value);
  } catch {}
});
ready
  .then(() => status("已连接 · 本机记录"))
  .catch((error) => status("尚未连接 · " + error.message));
setInterval(refreshTasks, 3000);
app.ontoolresult = () => {
  window.__roomRefresh?.();
  refreshTasks();
};
window.__agentRoom = {
  call,
  ready,
  app,
  get room() {
    return selectedRoom;
  },
};
