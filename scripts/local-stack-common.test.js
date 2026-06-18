import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const currentFilePath = fileURLToPath(import.meta.url);
const scriptsDir = path.dirname(currentFilePath);
const helperPath = path.join(scriptsDir, "local-stack-common.ps1");

function runPowerShell(command) {
  return execFileSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    { encoding: "utf8" },
  ).trim();
}

function escapePowerShell(value) {
  return String(value).replace(/'/g, "''");
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForCondition(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("condition wait timed out");
}

async function isPortListening(port) {
  return await new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function killProcessTree(pid) {
  try {
    execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
  }
}

async function stopPortOwner(port) {
  const command = [
    `$connections = @(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue)`,
    "foreach ($connection in $connections) {",
    "  try { Stop-Process -Id $connection.OwningProcess -Force -ErrorAction Stop } catch {}",
    "}",
  ].join(" ");

  runPowerShell(command);
  await waitForCondition(async () => !(await isPortListening(port)), 5000).catch(() => {});
}

test("Get-LocalStackRuntimeState detects occupied ports from state urls", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "local-stack-common-"));
  const stateFile = path.join(tempDir, "state.json");
  const port = await getFreePort();
  const server = http.createServer((_request, response) => response.end("ok"));

  try {
    await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
    writeFileSync(
      stateFile,
      JSON.stringify({
        urls: { api: `http://127.0.0.1:${port}` },
        processes: [{ name: "api-server", pid: 999999 }],
      }),
    );

    const output = runPowerShell(
      [
        `. '${escapePowerShell(helperPath)}'`,
        `$state = Get-Content '${escapePowerShell(stateFile)}' -Raw | ConvertFrom-Json`,
        "$runtime = Get-LocalStackRuntimeState -State $state",
        "$runtime | ConvertTo-Json -Depth 5 -Compress",
      ].join("; "),
    );

    const runtime = JSON.parse(output);
    assert.deepEqual(runtime.occupiedPorts, [port]);
    assert.equal(runtime.runningProcesses.length, 0);
    assert.equal(runtime.portOwnerPids.length, 1);
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Stop-LocalStackProcesses kills wrapper process trees and releases ports", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "local-stack-common-"));
  const stateFile = path.join(tempDir, "state.json");
  const listenerScriptPath = path.join(tempDir, "listener.js");
  const port = await getFreePort();

  writeFileSync(
    listenerScriptPath,
    [
      'const http = require("node:http");',
      "const port = Number(process.argv[2]);",
      'const server = http.createServer((_request, response) => response.end("ok"));',
      'server.listen(port, "127.0.0.1");',
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );

  const wrapper = spawn(
    "powershell",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `& { node '${listenerScriptPath.replace(/'/g, "''")}' ${port} }`,
    ],
    {
      windowsHide: true,
      stdio: "ignore",
    },
  );

  try {
    await waitForCondition(async () => await isPortListening(port), 8000);
    writeFileSync(
      stateFile,
      JSON.stringify({
        urls: { api: `http://127.0.0.1:${port}` },
        processes: [{ name: "api-server", pid: wrapper.pid }],
      }),
    );

    const result = runPowerShell(
      [
        `. '${escapePowerShell(helperPath)}'`,
        `$state = Get-Content '${escapePowerShell(stateFile)}' -Raw | ConvertFrom-Json`,
        "$stopped = Stop-LocalStackProcesses -State $state -TimeoutSec 10",
        "$stopped | ConvertTo-Json -Compress",
      ].join("; "),
    );

    assert.equal(JSON.parse(result), true);
    await waitForCondition(async () => !(await isPortListening(port)), 8000);
  } finally {
    if (!wrapper.killed) {
      killProcessTree(wrapper.pid);
    }
    if (await isPortListening(port)) {
      await stopPortOwner(port);
    }
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});

test("Select-OrphanLocalStackProcesses matches repo-owned api studio and orchestrator commands", () => {
  const output = runPowerShell(
    [
      `. '${escapePowerShell(helperPath)}'`,
      "$processes = @(",
      "  [pscustomobject]@{ ProcessId = 101; Name = 'node.exe'; CommandLine = 'node F:\\Python_code\\content_create\\apps\\api-server\\src/server.js' }",
      "  [pscustomobject]@{ ProcessId = 102; Name = 'node.exe'; CommandLine = 'node F:\\Python_code\\content_create\\node_modules\\vite\\bin\\vite.js --host 127.0.0.1 --port 5183 --config F:\\Python_code\\content_create\\apps\\studio-web\\vite.config.js' }",
      "  [pscustomobject]@{ ProcessId = 103; Name = 'python.exe'; CommandLine = 'python -m uvicorn app.main:app --host 127.0.0.1 --port 8120 --app-dir F:\\Python_code\\content_create\\apps\\ai-orchestrator' }",
      "  [pscustomobject]@{ ProcessId = 104; Name = 'node.exe'; CommandLine = 'node C:\\other\\repo\\src/server.js' }",
      ")",
      "$matched = Select-OrphanLocalStackProcesses -Processes $processes -RootDir 'F:\\Python_code\\content_create' -LocalPorts @()",
      "$matched | Select-Object -ExpandProperty ProcessId | ConvertTo-Json -Compress",
    ].join("; "),
  );

  assert.deepEqual(JSON.parse(output), [101, 102, 103]);
});
