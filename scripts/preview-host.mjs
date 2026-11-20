// QA only: serves a real MCP Apps host around the production resource. This is
// never installed as a service and is not the product's user entry point.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const client = new Client({ name: "qa-preview-host", version: "1.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: ["src/server.mjs"],
    env: process.env,
  }),
);
const js = await build({
  stdin: {
    contents: `
import {AppBridge,PostMessageTransport} from '@modelcontextprotocol/ext-apps/app-bridge';
const frame=document.createElement('iframe');frame.style='width:100%;height:100vh;border:0';
frame.sandbox='allow-scripts allow-same-origin';document.body.append(frame);
const bridge=new AppBridge(null,{name:'QA MCP Apps Host',version:'1.0'},{serverTools:{},message:{text:{}},logging:{}},{hostContext:{theme:'dark',displayMode:'fullscreen',availableDisplayModes:['inline','fullscreen']}});
bridge.oncalltool=async params=>{const r=await fetch('/call',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(params)});return r.json();};
window.hostMessages=[];bridge.onmessage=async params=>{window.hostMessages.push(params);return {};};
await bridge.connect(new PostMessageTransport(frame.contentWindow,frame.contentWindow));frame.src='/view';
`,
    resolveDir: process.cwd(),
    sourcefile: "qa-host.mjs",
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  write: false,
});
const server = createServer(async (req, res) => {
  try {
    if (req.url === "/call" && req.method === "POST") {
      let body = "";
      for await (const part of req) body += part;
      const result = await client.callTool(JSON.parse(body));
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(result));
    } else if (req.url === "/host.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(js.outputFiles[0].text);
    } else if (req.url === "/view") {
      res.setHeader("Content-Type", "text/html");
      res.end(readFileSync("dist/view.html"));
    } else {
      res.setHeader("Content-Type", "text/html");
      res.end(
        '<!doctype html><html><body style="margin:0"><script type="module" src="/host.js"></script></body></html>',
      );
    }
  } catch (error) {
    res.statusCode = 500;
    res.end(error.message);
  }
});
server.listen(8788, "127.0.0.1", () =>
  console.log("QA host http://127.0.0.1:8788"),
);
process.on("SIGTERM", async () => {
  server.close();
  await client.close();
  process.exit();
});
process.on("SIGINT", async () => {
  server.close();
  await client.close();
  process.exit();
});
