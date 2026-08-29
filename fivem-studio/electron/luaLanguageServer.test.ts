import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { encodeLspMessage, LspFrameParser, LuaLanguageServerProcess, type JsonRpcMessage } from "./luaLanguageServer";

test("LuaLS framing handles split and combined JSON-RPC messages", () => {
  const parser = new LspFrameParser();
  const first = encodeLspMessage({ jsonrpc: "2.0", id: 1, method: "initialize" });
  const second = encodeLspMessage({ jsonrpc: "2.0", method: "initialized", params: {} });
  assert.deepEqual(parser.push(first.subarray(0, 7)), []);
  assert.deepEqual(parser.push(Buffer.concat([first.subarray(7), second])), [
    { jsonrpc: "2.0", id: 1, method: "initialize" },
    { jsonrpc: "2.0", method: "initialized", params: {} },
  ]);
});

test("LuaLS framing rejects invalid and oversized headers", () => {
  const parser = new LspFrameParser();
  assert.throws(() => parser.push(Buffer.from("No-Length: 2\r\n\r\n{}")), /invalid message header/);
  assert.throws(
    () => new LspFrameParser().push(Buffer.from("Content-Length: 9000000\r\n\r\n")),
    /oversized message/,
  );
});

const bundledLuaLs = path.resolve(__dirname, "..", "..", "vendor", "lua-language-server", "bin", "lua-language-server.exe");
const bundledLibrary = path.resolve(__dirname, "..", "resources", "lua-library");

test("verified LuaLS bundle initializes and completes Cfx vector fields", {
  skip: process.platform !== "win32" || !fs.existsSync(bundledLuaLs),
  timeout: 20_000,
}, async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "qb-studio-luals-test-"));
  const logPath = path.join(workspace, "logs");
  fs.mkdirSync(logPath);
  const documentPath = path.join(workspace, "client.lua");
  const documentText = "local coords = vector3(1, 2, 3)\ncoords.";
  fs.writeFileSync(documentPath, documentText, "utf8");
  const workspaceUri = pathToFileURL(workspace).href;
  const documentUri = pathToFileURL(documentPath).href;
  const server = new LuaLanguageServerProcess();
  let requestId = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  const sendRequest = (method: string, params: unknown) => {
    const id = ++requestId;
    server.send({ jsonrpc: "2.0", id, method, params });
    return new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  const settings = {
    runtime: { version: "Lua 5.4", nonstandardSymbol: ["`"] },
    diagnostics: { enable: false },
    workspace: { checkThirdParty: "Disable", library: [bundledLibrary], maxPreload: 100, preloadFileSize: 500 },
  };
  const receive = (message: JsonRpcMessage) => {
    if (typeof message.id === "number" && typeof message.method !== "string") {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error && typeof message.error === "object") waiter.reject(new Error(String((message.error as { message?: unknown }).message)));
      else waiter.resolve(message.result);
      return;
    }
    if ((typeof message.id === "number" || typeof message.id === "string") && typeof message.method === "string") {
      const result = message.method === "workspace/configuration"
        ? Array.isArray((message.params as { items?: unknown[] } | undefined)?.items)
          ? (message.params as { items: unknown[] }).items.map(() => settings)
          : []
        : message.method === "workspace/workspaceFolders"
          ? [{ uri: workspaceUri, name: "test" }]
          : null;
      server.send({ jsonrpc: "2.0", id: message.id, result });
    }
  };

  try {
    server.start(bundledLuaLs, workspace, logPath, receive, (status) => {
      if (status.state === "error") {
        for (const waiter of pending.values()) waiter.reject(new Error(status.message ?? "LuaLS failed."));
        pending.clear();
      }
    });
    const initialized = await sendRequest("initialize", {
      processId: null,
      rootUri: workspaceUri,
      workspaceFolders: [{ uri: workspaceUri, name: "test" }],
      initializationOptions: { changeConfiguration: true },
      capabilities: {
        workspace: { configuration: true, workspaceFolders: true },
        textDocument: { synchronization: {}, completion: { completionItem: { snippetSupport: true } } },
      },
    });
    assert.ok(initialized && typeof initialized === "object" && "capabilities" in initialized);
    server.send({ jsonrpc: "2.0", method: "initialized", params: {} });
    server.send({ jsonrpc: "2.0", method: "workspace/didChangeConfiguration", params: { settings: { Lua: settings } } });
    server.send({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { textDocument: { uri: documentUri, languageId: "lua", version: 1, text: documentText } },
    });
    let labels: string[] = [];
    for (let attempt = 0; attempt < 50 && !(labels.includes("x") && labels.includes("z")); attempt += 1) {
      const completion = await sendRequest("textDocument/completion", {
        textDocument: { uri: documentUri },
        position: { line: 1, character: 7 },
        context: { triggerKind: 1 },
      });
      const items = Array.isArray(completion)
        ? completion
        : completion && typeof completion === "object" && Array.isArray((completion as { items?: unknown }).items)
          ? (completion as { items: unknown[] }).items
          : [];
      labels = items.flatMap((item) => item && typeof item === "object" && typeof (item as { label?: unknown }).label === "string"
        ? [(item as { label: string }).label]
        : []);
      if (!(labels.includes("x") && labels.includes("z"))) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(labels.includes("x") && labels.includes("z"), `Expected vector fields in completions, received: ${labels.slice(0, 20).join(", ")}`);
  } finally {
    await server.stop();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
