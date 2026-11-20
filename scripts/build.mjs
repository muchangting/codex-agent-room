import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
await build({
  entryPoints: ["vendor/agent-chat/src/db.ts"],
  outdir: "vendor/agent-chat/dist",
  platform: "node",
  format: "esm",
  bundle: true,
  packages: "external",
});
const compiled = await build({
  entryPoints: ["src/bridge.mjs"],
  bundle: true,
  platform: "browser",
  format: "iife",
  charset: "utf8",
  write: false,
});
let html = readFileSync("vendor/agent-chat/web/index.html", "utf8");
function swap(from, to) {
  if (!html.includes(from))
    throw new Error("Upstream viewer marker changed: " + from.slice(0, 60));
  html = html.replace(from, to);
}
html = html.replace(/@import\s+url\([^)]*\);/, "");
swap('<html lang="en">', '<html lang="zh-CN">');
swap("<title>agent-chat</title>", "<title>AI 协作群 · Agent Room</title>");
const strings = {
  "live coordination log": "把好想法，交给好团队",
  "Filter rooms": "搜索会话",
  "Search room messages": "搜索聊天记录",
  "Search room": "搜索聊天记录",
  ">Rooms<": ">会话<",
  ">Pinned<": ">群公告<",
  "Connection lost. Retrying.": "暂时断开连接，正在重新连接…",
  ">Back to live<": ">返回聊天<",
  "Pick a room.": "开始一段协作",
  "Rooms are listed on the left; the activity dot marks messages you have not seen.":
    "选择左侧的群聊，和你的 AI 团队一起工作。",
  "Loading...": "正在连接你的团队…",
  "posting as ": "",
  ">Load earlier messages<": ">查看更早的消息<",
  ">Mark all as read<": ">全部已读<",
  "Your name": "设置你的昵称（字母或数字）",
  ">Join room<": ">开始聊天<",
  ">Change name<": ">修改昵称<",
  ">Leave room<": ">退出会话<",
  ">Send<": ">发送<",
  "no password: human identity is self-asserted": "起个昵称，加入这场协作",
  "Message the room. Enter sends, Shift+Enter breaks, @name tags an agent":
    "发消息，和团队一起把事情做好",
  '"Today"': '"今天"',
  '"Yesterday"': '"昨天"',
  '"reply"': '"回复"',
  '"Collapse"': '"收起"',
  '"Show all (" + m.body.length + " chars)"': '"展开完整消息"',
  '"now"': '"刚刚"',
  '" present"': '" 位成员"',
  '"you"': '"我"',
  '"Join room"': '"加入群聊"',
  '"Change name"': '"修改昵称"',
  '"Join as " + current.agent_id': '"以 " + current.base_name + " 加入"',
  '"reply to #"': '"回复 #"',
  '"replying to #"': '"正在回复 #"',
  '"  (cancel)"': '"  · 点击取消"',
  '"join the room to reply"': '"加入群聊后即可回复"',
};
for (const [a, b] of Object.entries(strings)) html = html.replaceAll(a, b);
html = html
  .replace(
    '`${data.matches.length} match(es) for "${q}", best first. Click one to view it in the stream.`',
    "`找到 ${data.matches.length} 条与“${q}”相关的消息，点击查看上下文。`",
  )
  .replace('`No matches for "${q}".`', "`没有找到与“${q}”相关的消息。`")
  .replace('"Search failed: "', '"搜索失败："')
  .replace(
    '" (more matches exist beyond those shown; narrow your query.)"',
    '"（还有更多结果，可缩小搜索范围。）"',
  );
swap(
  "agent<em>-</em>chat",
  '<span class="brand-mark">A</span><span>协作群</span>',
);
swap(
  "</style>",
  "</style><style>" + readFileSync("src/theme.css", "utf8") + "</style>",
);
swap(
  "<body>",
  `<body><div id="shell"><nav id="rail" aria-label="工作区"><div class="rail-brand">A<span></span></div><button id="rail-chat" class="rail-action active" aria-label="会话" title="会话">${icon("chat")}</button><button id="rail-tasks" class="rail-action" aria-label="查看任务" title="任务">${icon("task")}</button><div class="rail-bottom"><button id="about-button" class="rail-action" aria-label="关于协作群" title="关于">${icon("info")}</button><div class="self-avatar" title="本机用户">我</div></div></nav>`,
);
const pinned = html.match(/<details id="pinned"[\s\S]*?<\/details>/)?.[0];
if (!pinned) throw new Error("Missing pinned section");
html = html.replace(pinned, "");
swap(
  "</main>\n    </div>",
  `</main><aside id="team-panel"><div class="panel-heading"><span>群聊信息</span><button id="close-team" class="icon-button" aria-label="关闭成员栏">×</button></div><section class="panel-section"><h3>群成员 <span id="member-count"></span></h3><div id="member-list"></div></section><section class="panel-section">${pinned}</section><section class="panel-section"><h3>协作任务 <span id="task-count"></span></h3><div id="task-summary"><p class="empty-note">任务开始后，进度会出现在这里</p></div></section><div class="panel-foot"><span class="privacy-dot"></span>聊天记录保存在本机</div></aside></div></div><dialog id="new-room-dialog"><form method="dialog"><div class="dialog-symbol">${icon("chat")}</div><h2>开始新的协作</h2><p>给这个群起个名字，邀请你的 AI 团队开始工作。</p><label for="new-room-name">群聊名称</label><input id="new-room-name" placeholder="例如：产品设计小队" maxlength="200" required><div class="dialog-actions"><button value="cancel" class="secondary-button">取消</button><button id="create-room" type="button" class="primary-button">创建群聊</button></div><p id="create-error" role="alert"></p></form></dialog><dialog id="about-dialog"><form method="dialog"><div class="dialog-symbol">A</div><h2>AI 协作群</h2><p>在 Codex 里，和你的 AI 团队一起工作。</p><p class="about-detail">基于 Agent Chat · Apache-2.0<br>Codex 统筹与验收，Gemini 独立分析与审查。<br>当前版本 0.2.0</p><button class="primary-button">知道了</button></form></dialog>`,
);
swap('<div class="filter-wrap">', '<div class="filter-wrap">');
swap(
  '<nav id="rooms" aria-label="Rooms"></nav>',
  '<div class="list-label">消息 <span id="conversation-count"></span><button id="new-room-button" class="icon-button" aria-label="新建群聊" title="新建群聊">+</button></div><nav id="rooms" aria-label="群聊"></nav><div class="sidebar-footer"><span id="live-status-dot"></span><span id="host-status">正在连接…</span></div>',
);
swap(
  '<div id="room-stats"></div>',
  `<div id="room-stats"></div><button id="call-leader" class="leader-button">${icon("spark")}<span>请 Codex 跟进</span></button><button id="toggle-team" class="icon-button" aria-label="显示群成员" title="群成员">${icon("people")}</button>`,
);
swap(
  '<div id="compose-box" hidden>',
  `<div id="compose-box" hidden><div class="composer-tools"><button id="mention-codex" class="tool-button" title="提及 Codex">@ Codex</button><button id="mention-gemini" class="tool-button" title="提及 Gemini">@ Gemini</button><span>Enter 发送 · Shift + Enter 换行</span></div>`,
);
swap(
  '"use strict";',
  `"use strict";window.__roomRefresh=()=>loadRooms();window.__roomSelect=async(id)=>{await loadRooms();const r=state.rooms.find(x=>x.id===id);if(r)openRoom(r);};window.__roomJump=seq=>jumpToSeq(seq);`,
);
swap(
  "const room = state.rooms.find((r) => r.id === savedId);",
  "const room = state.rooms.find((r) => r.id === savedId) || state.rooms[0];",
);
swap(
  "el.composeIdent.textContent = identity();",
  "el.composeIdent.textContent = currentIdentity()?.base_name || '我';",
);
swap(
  "linkify(body, m.body);",
  "if(window.__roomMarkdown)window.__roomMarkdown(body,m.body);else linkify(body,m.body);",
);
swap(
  "row.dataset.seq = m.seq;",
  `row.dataset.seq = m.seq;row.dataset.kind=m.is_human?'human':m.from.startsWith('Gemini-')?'gemini':'codex';row.dataset.self=String(m.from===identity());const avatar=document.createElement('div');avatar.className='message-avatar '+row.dataset.kind;avatar.textContent=m.is_human?(m.from===identity()?'我':'人'):row.dataset.kind==='gemini'?'G':'C';avatar.title=m.from;row.append(avatar);`,
);
swap(
  "return m.is_human ? m.from : m.model;",
  `return m.is_human ? (m.from===identity()?'我':m.from.replace(/^human-/,'').replace(/-\\d+$/,'')) : m.from.startsWith('Gemini-')?'Gemini':'Codex';`,
);
swap(
  'card.className = "room-card";',
  `card.className = 'room-card';const groupAvatar=document.createElement('div');groupAvatar.className='group-avatar';for(const letter of ['C','G','我','A']){const tile=document.createElement('span');tile.textContent=letter;groupAvatar.append(tile);}card.append(groupAvatar);`,
);
swap(
  "<script>",
  () =>
    "<script>" +
    compiled.outputFiles[0].text.replace(/<\/script/gi, "<\\/script") +
    "</script>\n<script>",
);
mkdirSync("dist", { recursive: true });
writeFileSync("dist/view.html", html);
function icon(name) {
  const shapes = {
    chat: '<path d="M5 5h14v11H9l-4 3V5Z"/><path d="M9 9h6m-6 3h4"/>',
    task: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="m8 10 2 2 5-5M8 16h8"/>',
    info: '<circle cx="12" cy="12" r="8"/><path d="M12 11v6m0-10v1"/>',
    people:
      '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2m0-15a3 3 0 0 1 0 6m3 9v-2a6 6 0 0 0-2-4"/>',
    spark:
      '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/>',
  };
  return (
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    shapes[name] +
    "</svg>"
  );
}
