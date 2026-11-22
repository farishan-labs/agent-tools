#!/usr/bin/env node
// BrowserOS neo (Chromium) CDP helper.
// CDP port is dynamic; discovered from ~/.config/browser-claw/.browseros/config.json
// (or probed over a small range). Auto-starts BrowserOS if not reachable.
// Usage: node scripts/browser.mjs <cmd> [args]
// Env: BROWSEROS_CDP_PORT overrides port discovery.
import CDP from 'chrome-remote-interface';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CONFIG_PATH = path.join(os.homedir(), '.config', 'browser-claw', '.browseros', 'config.json');
const START_TIMEOUT_MS = 25000;
const POLL_MS = 500;
const PORT_RANGE = Array.from({ length: 12 }, (_, i) => 9110 + i);

let PORT = null;

function readConfigPort() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const cfg = JSON.parse(raw);
    const p = cfg?.ports?.cdp;
    if (typeof p === 'number') return p;
  } catch {}
  return null;
}

function candidatePorts() {
  const set = new Set();
  if (process.env.BROWSEROS_CDP_PORT) set.add(Number(process.env.BROWSEROS_CDP_PORT));
  const cp = readConfigPort();
  if (cp) set.add(cp);
  for (const p of PORT_RANGE) set.add(p);
  return [...set].filter((n) => Number.isInteger(n) && n > 0);
}

function cdpAlive(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
      const ok = res.statusCode === 200;
      res.resume();
      resolve(ok);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
  });
}

async function findAlivePort() {
  for (const p of candidatePorts()) {
    if (await cdpAlive(p)) return p;
  }
  return null;
}

async function ensureBrowser() {
  let p = await findAlivePort();
  if (p) { PORT = p; return; }

  // Start BrowserOS detached.
  try {
    const child = spawn('browserclaw', [], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {}

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    p = await findAlivePort();
    if (p) { PORT = p; return; }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(`BrowserOS CDP not reachable (tried ${candidatePorts().join(',')}) after ${START_TIMEOUT_MS}ms`);
}

function needPort() {
  if (!PORT) throw new Error('BrowserOS port not initialized; call ensureBrowser first');
  return PORT;
}

async function targets() {
  await ensureBrowser();
  const c = await CDP({ port: needPort() });
  const t = await c.Target.getTargets();
  await c.close();
  return t.targetInfos;
}

async function attach(targetId) {
  await ensureBrowser();
  return CDP({ port: needPort(), target: targetId });
}

async function cdp() {
  await ensureBrowser();
  return CDP({ port: needPort() });
}

const [cmd, ...args] = process.argv.slice(2);

async function main() {
  switch (cmd) {
    case 'list': {
      const ts = await targets();
      console.log(JSON.stringify(ts.map(t=>({id:t.targetId,type:t.type,title:t.title,url:t.url})), null, 2));
      break;
    }
    case 'open': {
      const url = args[0] || 'about:blank';
      const c = await cdp();
      const { targetId } = await c.Target.createTarget({ url });
      await c.close();
      console.log(targetId);
      break;
    }
    case 'close': {
      const c = await cdp();
      await c.Target.closeTarget({ targetId: args[0] });
      await c.close();
      console.log('closed', args[0]);
      break;
    }
    case 'nav': {
      const [tid, url] = args;
      const c = await attach(tid);
      const { Page } = c;
      await Page.enable();
      await Page.navigate({ url });
      await new Promise(res => Page.loadEventFired(res));
      console.log('navigated', tid, url);
      await c.close();
      break;
    }
    case 'text': {
      const [tid] = args;
      const c = await attach(tid);
      const { Runtime } = c;
      const r = await Runtime.evaluate({ expression: 'document.body ? document.body.innerText : ""' });
      console.log(r.result.value);
      await c.close();
      break;
    }
    case 'eval': {
      const [tid, expr] = args;
      const c = await attach(tid);
      const { Runtime } = c;
      const r = await Runtime.evaluate({ expression: expr, returnByValue: true });
      console.log(JSON.stringify(r.result.value));
      await c.close();
      break;
    }
    case 'shot': {
      const [tid, file] = args;
      const c = await attach(tid);
      const { Page } = c;
      await Page.enable();
      const { data } = await Page.captureScreenshot({ format: 'png' });
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      console.log('saved', file);
      await c.close();
      break;
    }
    default:
      console.log('commands: list | open <url> | close <id> | nav <id> <url> | text <id> | eval <id> <expr> | shot <id> <file>');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
