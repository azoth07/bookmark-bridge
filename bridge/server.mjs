import http from 'node:http';
import net from 'node:net';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, rm, unlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mergeTrees, validateTree } from './tree.mjs';
import { monitorBridge, probeBridge } from './monitor.mjs';

export const MAX_BODY_BYTES = 8 * 1024 * 1024;
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMPTY_TREE = { children: [] };
const OWNED_FILES = new Set(['token.txt', 'state.json', '.bridge-owner']);

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function defaultDataDir() {
  return process.env.BOOKMARK_BRIDGE_DATA_DIR
    || path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'BookmarkBridge');
}

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function validSlot(slot) {
  return Number.isInteger(slot) && slot >= 1 && slot <= 50;
}

function validSlots(slots) {
  return Array.isArray(slots) && slots.length > 0 && slots.length <= 50
    && slots.every((slot, index) => validSlot(slot) && (index === 0 || slot > slots[index - 1]));
}

function sameSlots(left, right) {
  return left.length === right.length && left.every((slot, index) => slot === right[index]);
}

function counts(tree) {
  let bookmarkCount = 0;
  let folderCount = 0;
  const stack = [tree.children];
  while (stack.length) {
    for (const node of stack.pop()) {
      if (Object.hasOwn(node, 'url')) bookmarkCount++;
      else {
        folderCount++;
        stack.push(node.children);
      }
    }
  }
  return { bookmarkCount, folderCount };
}

async function atomicWrite(filename, text) {
  const temporary = `${filename}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filename);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function loadToken(dataDir) {
  const filename = path.join(dataDir, 'token.txt');
  let token;
  try {
    token = (await readFile(filename, 'utf8')).trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    token = randomBytes(32).toString('hex');
    await atomicWrite(filename, `${token}\n`);
  }
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('令牌文件损坏，请恢复 token.txt 备份；服务没有覆盖原文件。');
  return token;
}

async function loadState(filename) {
  let saved;
  try {
    saved = JSON.parse(await readFile(filename, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { slots: new Map(), legacyGroups: [] };
    throw new Error('无法读取书签数据，请检查或恢复 state.json；服务没有覆盖原文件。', { cause: error });
  }
  // Old named groups remain recoverable on disk until the first complete v2
  // exchange. They never become active numbered slots or block completion.
  const legacy = saved?.version === 1;
  if (legacy && (!exactKeys(saved, ['version', 'revision', 'groups'])
    || !Number.isSafeInteger(saved.revision) || saved.revision < 0 || !Array.isArray(saved.groups))) {
    throw new Error('state.json 的格式或版本无效。');
  }
  if (!legacy && (!exactKeys(saved, ['version', 'slots', 'legacyGroups'])
    || saved.version !== 2 || !Array.isArray(saved.slots) || saved.slots.length > 50
    || !Array.isArray(saved.legacyGroups))) throw new Error('state.json 的格式或版本无效。');
  const legacyGroups = legacy ? saved.groups : saved.legacyGroups;
  const names = new Set();
  for (const entry of legacyGroups) {
    if (!exactKeys(entry, ['name', 'tree']) || typeof entry.name !== 'string'
      || entry.name.length < 1 || entry.name.length > 100 || names.has(entry.name)) {
      throw new Error('state.json 中存在无效或重复的旧同步组。');
    }
    validateTree(entry.tree);
    names.add(entry.name);
  }
  const slots = new Map();
  for (const entry of legacy ? [] : saved.slots) {
    if (!exactKeys(entry, ['slot', 'revision', 'tree']) || !validSlot(entry.slot)
      || !Number.isSafeInteger(entry.revision) || entry.revision < 1 || slots.has(entry.slot)) {
      throw new Error('state.json 中存在无效或重复的配对。');
    }
    validateTree(entry.tree);
    slots.set(entry.slot, { revision: entry.revision, tree: mergeTrees(EMPTY_TREE, entry.tree).tree });
  }
  return { slots, legacyGroups };
}

function headerCount(request, name) {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === name) count++;
  }
  return count;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let settled = false;
    let oversized = false;
    function fail(error) {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      reject(error);
    }
    request.on('data', chunk => {
      if (settled || oversized) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Drain oversized chunked bodies before responding, without buffering.
        oversized = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      settled = true;
      if (oversized) {
        reject(new HttpError(413, '请求体不能超过 8 MiB。'));
        return;
      }
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError(400, '请求体必须是有效的 UTF-8 JSON。'));
      }
    });
    request.on('aborted', () => fail(new HttpError(400, '请求已中断。')));
    request.on('error', fail);
    request.setTimeout(15_000, () => {
      fail(new HttpError(408, '读取请求超时。'));
      request.destroy();
    });
  });
}

/** Create an initialized v2 bridge; call start() to listen and close() to stop. */
export async function createBridge(options = {}) {
  const dataDir = path.resolve(options.dataDir ?? defaultDataDir());
  const configuredPort = options.port ?? process.env.BOOKMARK_BRIDGE_PORT ?? 38473;
  const port = typeof configuredPort === 'string' && /^\d+$/.test(configuredPort)
    ? Number(configuredPort) : configuredPort;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口必须是 0 到 65535 之间的整数。');
  if (dataDir === path.parse(dataDir).root) throw new Error('数据目录不能是磁盘根目录。');
  const directoryKey = process.platform === 'win32' ? dataDir.toLowerCase() : dataDir;
  const lockId = createHash('sha256').update(directoryKey).digest('hex');
  // The lock is outside the temporary directory and survives successful cleanup.
  const lockPath = process.platform === 'win32' ? `\\\\.\\pipe\\BookmarkBridge-${lockId}`
    : process.platform === 'linux' ? `\0bookmark-bridge-${lockId}` : path.join(tmpdir(), `bookmark-bridge-${lockId}.sock`);
  const lock = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    const onError = error => {
      lock.off('listening', onListening);
      reject(error.code === 'EADDRINUSE'
        ? new Error(`数据目录已被其他桥接服务占用：${dataDir}。请先关闭该服务。`) : error);
    };
    const onListening = () => {
      lock.off('error', onError);
      resolve();
    };
    lock.once('error', onError);
    lock.once('listening', onListening);
    lock.listen(lockPath);
  });
  async function releaseLock() {
    if (lock.listening) await new Promise((resolve, reject) => lock.close(error => error ? reject(error) : resolve()));
  }
  const owner = randomUUID();
  const ownerPath = path.join(dataDir, '.bridge-owner');
  const statePath = path.join(dataDir, 'state.json');
  let directoryIdentity;
  let directoryPresent = true;
  let ownerPending = false;
  async function inspectDirectory(requireOwner) {
    const info = await lstat(dataDir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('数据目录不是独立的普通目录，拒绝写入或删除。');
    if (requireOwner && (info.dev !== directoryIdentity.dev || info.ino !== directoryIdentity.ino)) {
      throw new Error('数据目录已被替换，拒绝删除。');
    }
    for (const entry of await readdir(dataDir, { withFileTypes: true })) {
      if (!OWNED_FILES.has(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
        throw new Error('数据目录含有非桥接文件，已保留整个目录；请将桥接数据放入独立目录。');
      }
    }
    if (requireOwner && await readFile(ownerPath, 'utf8') !== owner) throw new Error('数据目录所有权标记不匹配，拒绝删除。');
    return info;
  }
  let token;
  let state;
  try {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    directoryIdentity = await inspectDirectory(false);
    state = await loadState(statePath);
    token = await loadToken(dataDir);
    await atomicWrite(ownerPath, owner);
  } catch (error) {
    await releaseLock();
    throw error;
  }
  const expectedAuthorization = Buffer.from(`Bearer ${token}`);
  const epoch = randomUUID();
  const clients = new Map(); // One current registration per browser; replacement must ACK anew.
  const events = [];
  let sequence = 0;
  let phase = 'waiting';
  let cleaned = false;
  let queue = Promise.resolve();
  let closing = false;
  let closePromise;
  let startPromise;

  function event(message) {
    const entry = { seq: ++sequence, time: new Date().toISOString(), message };
    events.push(entry);
    if (events.length > 200) events.shift();
    options.onEvent?.(entry);
  }

  function activeSlots() {
    return [...new Set([...clients.values()].flatMap(client => client.slots))].sort((a, b) => a - b);
  }

  function peersMatch() {
    const chrome = clients.get('Chrome');
    const edge = clients.get('Edge');
    return chrome && edge && chrome.id !== edge.id && sameSlots(chrome.slots, edge.slots);
  }

  function pendingSlots() {
    return activeSlots().filter(slot => !peersMatch() || [...clients.values()].some(client =>
      client.pendingUploads.has(slot) || !state.slots.has(slot) || client.acks.get(slot) !== state.slots.get(slot).revision));
  }

  function summary() {
    return { phase, cleaned, pendingSlots: pendingSlots() };
  }

  function status(after = 0) {
    return {
      phase, cleaned, epoch,
      clients: [...clients.values()].map(client => ({ name: client.name, slots: client.slots, lastSeen: client.lastSeen })),
      slots: activeSlots().map(slot => {
        const entry = state.slots.get(slot);
        return { slot, revision: entry?.revision ?? 0,
          acknowledged: [...clients.values()].filter(client => entry && client.slots.includes(slot)
            && client.acks.get(slot) === entry.revision).map(client => client.name),
          ...counts(entry?.tree ?? EMPTY_TREE) };
      }),
      events: events.filter(entry => entry.seq > after),
    };
  }

  function serial(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }

  async function persist(nextState) {
    if (!directoryPresent) {
      // A completed process keeps its token in RAM. Only a changed tree creates
      // a new temporary directory; an idle poll never writes a snapshot.
      await mkdir(dataDir, { mode: 0o700 });
      directoryPresent = true;
      cleaned = false;
      ownerPending = true;
      directoryIdentity = await lstat(dataDir);
    }
    if (ownerPending) {
      // Remember our successfully created directory even if writing its marker
      // fails, so a retry repairs ownership instead of failing with EEXIST.
      const info = await inspectDirectory(false);
      if (info.dev !== directoryIdentity.dev || info.ino !== directoryIdentity.ino) {
        throw new Error('数据目录已被替换，拒绝写入。');
      }
      await atomicWrite(ownerPath, owner);
      ownerPending = false;
    }
    await inspectDirectory(true);
    await atomicWrite(path.join(dataDir, 'token.txt'), `${token}\n`);
    await atomicWrite(statePath, JSON.stringify({ version: 2,
      slots: [...nextState.slots].map(([slot, entry]) => ({ slot, ...entry })),
      legacyGroups: nextState.legacyGroups }));
  }

  function waiting() {
    if (phase === 'error') return;
    if (!clients.has('Chrome') || !clients.has('Edge')) {
      phase = 'waiting';
      event(`等待 ${clients.has('Chrome') ? 'Edge' : 'Chrome'} 注册并上传所有配对。`);
    } else if (!peersMatch()) {
      phase = 'waiting';
      event('Chrome 与 Edge 的启用配对编号不一致，等待两端选择相同配对。');
    } else {
      const pending = pendingSlots();
      phase = pending.length ? 'syncing' : cleaned ? 'complete' : 'syncing';
      if (pending.length) event(`等待两端应用并确认：${pending.map(slot => `配对 ${slot}`).join('、')}。`);
    }
  }

  async function finishIfAcknowledged() {
    if (!peersMatch() || pendingSlots().length) {
      waiting();
      return;
    }
    if (!directoryPresent && cleaned) {
      phase = 'complete';
      return;
    }
    try {
      await inspectDirectory(true);
      await rm(dataDir, { recursive: true });
      directoryPresent = false;
      cleaned = true;
      phase = 'complete';
      state.legacyGroups = [];
      event('Chrome 与 Edge 已应用并确认全部配对。整个临时数据目录已成功删除（包括令牌）；服务继续在内存中运行。');
      event('本服务重启后将生成新令牌，请重新为两端配对。');
    } catch (error) {
      phase = 'error';
      cleaned = false;
      event('两端已确认，但整个数据目录删除失败；未宣告完成。请检查目录权限及非桥接文件后重试同步。');
      throw new HttpError(500, '清理数据目录失败；请检查目录权限和非桥接文件后重试。', summary());
    }
  }

  function synchronize(body) {
    return serial(async () => {
      const other = clients.get(body.clientName === 'Chrome' ? 'Edge' : 'Chrome');
      if (other?.id === body.clientId) throw new HttpError(409, 'Chrome 和 Edge 必须使用不同的客户端标识。', summary());
      let client = clients.get(body.clientName);
      if (!client || client.id !== body.clientId) {
        client = { id: body.clientId, name: body.clientName, slots: body.slots,
          acks: new Map(), pendingUploads: new Set() };
        clients.set(body.clientName, client);
        event(`${body.clientName} 已注册，启用 ${body.slots.length} 个配对。`);
      } else if (!sameSlots(client.slots, body.slots)) {
        client.slots = body.slots;
        client.acks.clear();
        event(`${body.clientName} 已更新启用配对：${body.slots.join('、')}。`);
      }
      client.lastSeen = new Date().toISOString();
      const previousAck = client.acks.get(body.slot);
      // The declaration and upload attempt are real even if persistence fails.
      // Keep failed uploads pending so delayed ACKs for the old revision cannot
      // authorize cleanup before this browser successfully uploads again.
      client.acks.delete(body.slot);
      client.pendingUploads.add(body.slot);
      phase = 'syncing';
      const previous = state.slots.get(body.slot);
      const { tree, changed } = mergeTrees(previous?.tree ?? EMPTY_TREE, body.tree);
      try {
        validateTree(tree);
      } catch (error) {
        phase = 'error';
        throw new HttpError(400, `合并后的书签超出限制：${error.message}`, summary());
      }
      if (changed || !previous) {
        if (previous?.revision === Number.MAX_SAFE_INTEGER) throw new HttpError(409, '修订号已达到上限。');
        const slots = new Map(state.slots);
        slots.set(body.slot, { tree, revision: (previous?.revision ?? 0) + 1 });
        const nextState = { ...state, slots };
        try {
          await persist(nextState);
        } catch {
          phase = 'error';
          event(`配对 ${body.slot} 保存失败；合并未提交，请检查数据目录权限和磁盘空间。`);
          throw new HttpError(500, '保存书签失败；原有书签状态未提交，请检查数据目录权限和磁盘空间。', summary());
        }
        state = nextState;
        cleaned = false;
        for (const registered of clients.values()) registered.acks.delete(body.slot);
      }
      client.pendingUploads.delete(body.slot);
      const uploaded = counts(body.tree);
      const merged = state.slots.get(body.slot);
      // Retain an idle ACK only when this exact upload already contains the
      // complete union; selecting a new, incomplete target requires a new ACK.
      if (previousAck === merged.revision && !mergeTrees(body.tree, merged.tree).changed) {
        client.acks.set(body.slot, previousAck);
      }
      const total = counts(merged.tree);
      event(`${body.clientName} 上传配对 ${body.slot}：${uploaded.bookmarkCount} 个书签、${uploaded.folderCount} 个文件夹；合并后 ${total.bookmarkCount} 个书签、${total.folderCount} 个文件夹，修订 ${merged.revision}。`);
      waiting();
      return { tree: merged.tree, revision: merged.revision, epoch, phase, cleaned };
    });
  }

  function acknowledge(body) {
    return serial(async () => {
      const client = [...clients.values()].find(value => value.id === body.clientId);
      const entry = state.slots.get(body.slot);
      if (body.epoch !== epoch || !client || !client.slots.includes(body.slot)
        || client.pendingUploads.has(body.slot) || !entry || body.revision !== entry.revision) {
        throw new HttpError(409, '确认已过期或配对尚未上传，请重新同步后确认当前修订。', summary());
      }
      client.lastSeen = new Date().toISOString();
      client.acks.set(body.slot, body.revision);
      event(`${client.name} 已应用并确认配对 ${body.slot}，修订 ${body.revision}。`);
      phase = 'syncing';
      await finishIfAcknowledged();
      return summary();
    });
  }

  const server = http.createServer({ maxHeaderSize: 16 * 1024 }, async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    const send = (code, body) => {
      response.writeHead(code);
      response.end(JSON.stringify(body));
    };
    try {
      const actualPort = server.address()?.port;
      const host = request.headers.host;
      if (headerCount(request, 'host') !== 1
        || (host !== `127.0.0.1:${actualPort}` && host !== `localhost:${actualPort}`)) {
        throw new HttpError(403, '不允许的 Host。');
      }
      const origin = request.headers.origin;
      if (origin !== undefined && (headerCount(request, 'origin') !== 1 || !EXTENSION_ORIGIN.test(origin))) {
        throw new HttpError(403, '只允许浏览器扩展来源。');
      }
      if (origin) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');
      }
      if (request.url === '/health' && request.method === 'GET') {
        send(200, { ok: true, app: 'bookmark-bridge', version: 2 });
        return;
      }
      const statusMatch = /^\/v2\/status(?:\?after=(\d+))?$/.exec(request.url);
      if (statusMatch && request.method === 'GET') {
        const after = Number(statusMatch[1] ?? 0);
        if (!Number.isSafeInteger(after)) throw new HttpError(400, '事件序号无效。');
        send(200, await serial(() => status(after)));
        return;
      }
      if (request.url !== '/v2/sync' && request.url !== '/v2/ack') {
        throw new HttpError(404, '接口不存在；令牌不能放在网址中。');
      }
      if (request.method === 'OPTIONS') {
        const requestedHeaders = (request.headers['access-control-request-headers'] ?? '')
          .split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
        if (!origin || request.headers['access-control-request-method'] !== 'POST'
          || requestedHeaders.some(value => value !== 'authorization' && value !== 'content-type')) {
          throw new HttpError(403, '不允许的跨域预检请求。');
        }
        response.setHeader('Access-Control-Allow-Methods', 'POST');
        response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        response.writeHead(204);
        response.end();
        return;
      }
      const authorization = Buffer.from(request.headers.authorization ?? '');
      if (headerCount(request, 'authorization') !== 1 || authorization.length !== expectedAuthorization.length
        || !timingSafeEqual(authorization, expectedAuthorization)) {
        response.setHeader('WWW-Authenticate', 'Bearer');
        throw new HttpError(401, '令牌无效或缺失。服务重启后请使用启动窗口的新令牌重新配对。');
      }
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST, OPTIONS');
        throw new HttpError(405, '此接口只接受 POST。');
      }
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) {
        throw new HttpError(415, 'Content-Type 必须为 application/json。');
      }
      if (Number(request.headers['content-length'] ?? 0) > MAX_BODY_BYTES) {
        throw new HttpError(413, '请求体不能超过 8 MiB。');
      }
      const body = await readBody(request);
      if (request.url === '/v2/sync') {
        if (!exactKeys(body, ['clientId', 'clientName', 'slots', 'slot', 'tree'])
          || typeof body.clientId !== 'string' || !CLIENT_ID.test(body.clientId)
          || !['Chrome', 'Edge'].includes(body.clientName) || !validSlots(body.slots)
          || !validSlot(body.slot) || !body.slots.includes(body.slot)) {
          throw new HttpError(400, '同步请求须包含客户端 UUID、Chrome/Edge、升序启用配对编号、当前配对与书签树。');
        }
        try { validateTree(body.tree); } catch (error) { throw new HttpError(400, error.message); }
        send(200, await synchronize(body));
      } else {
        if (!exactKeys(body, ['clientId', 'slot', 'revision', 'epoch'])
          || typeof body.clientId !== 'string' || !CLIENT_ID.test(body.clientId)
          || !validSlot(body.slot) || !Number.isSafeInteger(body.revision) || body.revision < 1
          || typeof body.epoch !== 'string' || !CLIENT_ID.test(body.epoch)) {
          throw new HttpError(400, '确认请求须包含客户端 UUID、配对编号、修订号与服务会话 UUID。');
        }
        send(200, await acknowledge(body));
      }
    } catch (error) {
      request.resume();
      if (response.destroyed) return;
      response.setHeader('Connection', 'close');
      send(error instanceof HttpError ? error.status : 500, {
        error: error instanceof HttpError ? error.message : '服务处理失败，请检查数据目录权限和磁盘空间。',
        ...(error instanceof HttpError ? error.details : undefined),
      });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  event('桥接服务就绪，等待 Chrome 与 Edge 上传并确认全部启用配对。');

  return {
    server, token, dataDir, epoch,
    get address() { return server.address(); },
    start() {
      if (closing) return Promise.reject(new Error('服务已经关闭。'));
      if (!startPromise) {
        startPromise = new Promise((resolve, reject) => {
          const onError = error => {
            server.off('listening', onListening);
            reject(error);
          };
          const onListening = () => {
            server.off('error', onError);
            resolve(server.address());
          };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(port, '127.0.0.1');
        });
      }
      return startPromise;
    },
    close() {
      if (!closePromise) {
        closing = true;
        closePromise = (async () => {
          if (startPromise) await startPromise.catch(() => {});
          if (server.listening) await new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
          });
          await queue;
          await releaseLock();
        })();
      }
      return closePromise;
    },
  };
}

async function attach(port) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  console.log('检测到正在运行的 v2 服务，已连接实时状态。按 Ctrl+C 只退出本查看窗口，不会停止原服务。');
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    await monitorBridge({ port, signal: controller.signal, onLine: line => console.log(line) });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

async function main() {
  let bridge;
  const port = Number(process.env.BOOKMARK_BRIDGE_PORT ?? 38473);
  try {
    if (await probeBridge(port)) {
      await attach(port);
      return;
    }
    bridge = await createBridge({ onEvent: entry => console.log(`[${entry.time}] ${entry.message}`) });
    const address = await bridge.start();
    console.log(`书签桥接服务已启动：http://127.0.0.1:${address.port}`);
    console.log(`配对令牌：${bridge.token}`);
    console.log(`临时数据目录：${bridge.dataDir}`);
    console.log('请将令牌复制到 Chrome / Edge 扩展设置。两端确认全部配对后将删除整个目录（包括令牌）。');
    console.log('服务继续运行时令牌保持有效；清理后重启必须使用新令牌重新配对。');
    console.log('关闭此服务窗口会停止同步；按 Ctrl+C 安全退出。');
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      try { await bridge.close(); }
      catch {
        console.error('关闭服务失败，请检查数据目录权限。');
        process.exitCode = 1;
      }
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } catch (error) {
    if (bridge) await bridge.close();
    // A second launcher may have won the port after the initial probe.
    if (await probeBridge(port)) {
      await attach(port);
      return;
    }
    console.error(`启动失败：${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
