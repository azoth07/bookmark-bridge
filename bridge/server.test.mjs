import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import fsPromises, { mkdtemp, readFile, writeFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBridge, MAX_BODY_BYTES } from './server.mjs';
import { monitorBridge, probeBridge } from './monitor.mjs';

const ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
const CHROME = '11111111-1111-4111-8111-111111111111';
const EDGE = '22222222-2222-4222-8222-222222222222';
const tree = (...children) => ({ children });
const bookmark = index => ({ title: `私密标题 ${index}`, url: `https://private.example.test/${index}` });
const idFor = name => name === 'Chrome' ? CHROME : EDGE;
const payload = (name, value, slot = 1, slots = [1]) => ({
  clientId: idFor(name), clientName: name, slots, slot, tree: value,
});

async function fixture(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'bookmark-bridge-测试 '));
  const f = { dataDir, bridge: null, port: null, events: [] };
  t.after(async () => {
    if (f.bridge) await f.bridge.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  f.bridge = await createBridge({ dataDir, port: 0, onEvent: event => f.events.push(event) });
  f.port = (await f.bridge.start()).port;
  return f;
}

function request(f, options = {}) {
  const headers = {
    host: `127.0.0.1:${f.port}`, authorization: `Bearer ${f.bridge.token}`, origin: ORIGIN,
    'content-type': 'application/json', ...options.headers,
  };
  for (const key of Object.keys(headers)) if (headers[key] === null) delete headers[key];
  const body = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: f.port,
      path: options.path ?? '/v2/sync', method: options.method ?? 'POST', headers,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode, headers: response.headers, body: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    if (options.chunks) for (const chunk of options.chunks) req.write(chunk);
    req.end(body);
  });
}

const sync = (f, name, value, slot = 1, slots = [1]) => request(f, { body: payload(name, value, slot, slots) });
const ack = (f, name, revision, slot = 1, epoch = f.bridge.epoch) => request(f, {
  path: '/v2/ack', body: { clientId: idFor(name), slot, revision, epoch },
});
const status = (f, after) => request(f, { method: 'GET',
  path: after === undefined ? '/v2/status' : `/v2/status?after=${after}`,
  headers: { authorization: null, origin: null },
});
const exists = async filename => {
  try { await stat(filename); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};

async function restart(f) {
  await f.bridge.close();
  f.bridge = await createBridge({ dataDir: f.dataDir, port: 0 });
  f.port = (await f.bridge.start()).port;
}

async function complete(f, value = tree(bookmark(1))) {
  const chrome = await sync(f, 'Chrome', value);
  const edge = await sync(f, 'Edge', value);
  assert.equal(chrome.status, 200);
  assert.equal(edge.status, 200);
  assert.equal((await ack(f, 'Chrome', edge.body.revision)).body.cleaned, false);
  const result = await ack(f, 'Edge', edge.body.revision);
  assert.equal(result.status, 200);
  assert.equal(result.body.phase, 'complete');
  assert.equal(result.body.cleaned, true);
  return edge.body.revision;
}

test('只上传或单端确认绝不清理；合并使旧确认失效，两端当前确认后删除整个目录', async t => {
  const f = await fixture(t);
  const first = await sync(f, 'Chrome', tree(bookmark(1)));
  assert.equal(first.body.revision, 1);
  assert.equal(first.body.phase, 'waiting');
  assert.equal((await ack(f, 'Chrome', 1)).body.cleaned, false);
  assert.equal(await exists(f.dataDir), true);
  const second = await sync(f, 'Edge', tree(bookmark(2)));
  assert.equal(second.body.revision, 2);
  assert.deepEqual(second.body.tree, tree(bookmark(1), bookmark(2)));
  assert.equal((await ack(f, 'Chrome', 1)).status, 409);
  assert.equal((await ack(f, 'Edge', 2)).body.cleaned, false);
  assert.equal(await exists(path.join(f.dataDir, 'token.txt')), true);
  const applied = await sync(f, 'Chrome', tree(bookmark(1)));
  assert.equal(applied.body.revision, 2);
  const finished = await ack(f, 'Chrome', 2);
  assert.deepEqual(finished.body, { phase: 'complete', cleaned: true, pendingSlots: [] });
  assert.equal(await exists(f.dataDir), false);
  assert.ok(f.events.some(event => event.message.includes('整个临时数据目录已成功删除')));
});

test('每个启用配对必须由相同声明的两个不同浏览器全部确认', async t => {
  const f = await fixture(t);
  for (const name of ['Chrome', 'Edge']) {
    await sync(f, name, tree(bookmark(1)), 1, [1, 3]);
    await sync(f, name, tree(bookmark(3)), 3, [1, 3]);
  }
  assert.equal((await ack(f, 'Chrome', 1, 1)).body.cleaned, false);
  assert.deepEqual((await ack(f, 'Edge', 1, 1)).body.pendingSlots, [3]);
  assert.equal((await ack(f, 'Chrome', 1, 3)).body.cleaned, false);
  assert.equal(await exists(f.dataDir), true);
  assert.equal((await ack(f, 'Edge', 1, 3)).body.cleaned, true);
  assert.equal(await exists(f.dataDir), false);
});

test('不匹配配对、同一客户端冒充另一端、第二个Chrome都不能完成清理', async t => {
  const f = await fixture(t);
  await sync(f, 'Chrome', tree(bookmark(1)), 1, [1, 2]);
  await sync(f, 'Edge', tree(bookmark(1)), 1, [1]);
  await ack(f, 'Chrome', 1);
  assert.equal((await ack(f, 'Edge', 1)).body.cleaned, false);
  assert.equal((await request(f, { body: { ...payload('Edge', tree()), clientId: CHROME } })).status, 409);
  const replacement = randomUUID();
  await request(f, { body: { ...payload('Chrome', tree(), 1, [1, 2]), clientId: replacement } });
  assert.equal((await ack(f, 'Chrome', 1)).status, 409);
  assert.equal(await exists(f.dataDir), true);
  const current = await status(f);
  assert.equal(current.body.phase, 'waiting');
  assert.deepEqual(current.body.slots.find(slot => slot.slot === 1).acknowledged, ['Edge']);
});

test('配对声明变化清除旧确认，不能利用旧已完成配对提前删除', async t => {
  const f = await fixture(t);
  await sync(f, 'Chrome', tree(), 1, [1, 2]);
  await sync(f, 'Edge', tree(), 1, [1, 2]);
  await ack(f, 'Chrome', 1);
  await ack(f, 'Edge', 1);
  await sync(f, 'Chrome', tree(), 1, [1]);
  await sync(f, 'Edge', tree(), 1, [1]);
  assert.equal((await ack(f, 'Chrome', 1)).body.cleaned, false);
  assert.equal((await ack(f, 'Edge', 1)).body.cleaned, true);
});

test('清理后闲置同步不重建目录，新变化恢复临时状态和原令牌，再次确认后再次清理', async t => {
  const f = await fixture(t);
  const token = f.bridge.token;
  await complete(f);
  for (const name of ['Chrome', 'Edge']) {
    const idle = await sync(f, name, tree(bookmark(1)));
    assert.equal(idle.body.phase, 'complete');
    assert.equal(idle.body.cleaned, true);
    assert.equal((await ack(f, name, 1)).body.phase, 'complete');
  }
  assert.equal(await exists(f.dataDir), false);
  await assert.rejects(createBridge({ dataDir: f.dataDir, port: 0 }), /数据目录已被其他桥接服务占用/);
  assert.equal(await exists(f.dataDir), false);
  const changed = await sync(f, 'Chrome', tree(bookmark(2)));
  assert.equal(changed.body.revision, 2);
  assert.equal(changed.body.cleaned, false);
  assert.deepEqual(changed.body.tree, tree(bookmark(1), bookmark(2)));
  assert.equal((await readFile(path.join(f.dataDir, 'token.txt'), 'utf8')).trim(), token);
  await ack(f, 'Chrome', 2);
  const peer = await sync(f, 'Edge', tree(bookmark(1)));
  assert.equal(peer.body.revision, 2);
  assert.equal((await ack(f, 'Edge', 2)).body.cleaned, true);
  assert.equal(await exists(f.dataDir), false);
  await restart(f);
  assert.notEqual(f.bridge.token, token);
  assert.equal((await request(f, { body: payload('Chrome', tree()), headers: { authorization: `Bearer ${token}` } })).status, 401);
  assert.deepEqual((await sync(f, 'Chrome', tree())).body.tree, tree());
});

test('待完成状态重启保留并集和分配对修订号，但旧epoch确认无效', async t => {
  const f = await fixture(t);
  const token = f.bridge.token;
  const epoch = f.bridge.epoch;
  await sync(f, 'Chrome', tree(bookmark(1)), 1, [1, 2]);
  await sync(f, 'Chrome', tree(bookmark(2)), 2, [1, 2]);
  await sync(f, 'Chrome', tree(bookmark(3)), 1, [1, 2]);
  await restart(f);
  assert.equal(f.bridge.token, token);
  assert.notEqual(f.bridge.epoch, epoch);
  const first = await sync(f, 'Chrome', tree(), 1, [1, 2]);
  assert.deepEqual(first.body.tree, tree(bookmark(1), bookmark(3)));
  assert.equal(first.body.revision, 2);
  assert.equal((await sync(f, 'Chrome', tree(), 2, [1, 2])).body.revision, 1);
  assert.equal((await ack(f, 'Chrome', 2, 1, epoch)).status, 409);
  assert.equal(await exists(f.dataDir), true);
});

test('并发上传串行提交所有新增数据，并发确认与变化不会清理未确认版本', async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 24 }, (_, i) => sync(f, 'Chrome', tree(bookmark(i)))));
  assert.ok(results.every(result => result.status === 200));
  assert.deepEqual(results.map(result => result.body.revision).sort((a, b) => a - b),
    Array.from({ length: 24 }, (_, i) => i + 1));
  const current = await sync(f, 'Edge', tree());
  assert.equal(current.body.tree.children.length, 24);
  await ack(f, 'Chrome', 24);
  const [lastAck, changed] = await Promise.all([
    ack(f, 'Edge', 24), sync(f, 'Chrome', tree(bookmark(24))),
  ]);
  assert.ok([200, 409].includes(lastAck.status));
  assert.equal(changed.status, 200);
  assert.equal(changed.body.revision, 25);
  assert.equal(await exists(f.dataDir), true);
  assert.equal((await status(f)).body.cleaned, false);
  await restart(f);
  const restored = await sync(f, 'Chrome', tree());
  assert.equal(restored.body.revision, 25);
  assert.equal(restored.body.tree.children.length, 25);
});

test('新增上传保存失败会撤销旧ACK，延迟确认不能触发清理，重传成功后恢复', async t => {
  const f = await fixture(t);
  await sync(f, 'Chrome', tree(bookmark(1)));
  await sync(f, 'Edge', tree(bookmark(1)));
  await ack(f, 'Chrome', 1);
  const filename = path.join(f.dataDir, 'state.json');
  const saved = await readFile(filename, 'utf8');
  const blocker = path.join(f.dataDir, 'keep.txt');
  await writeFile(blocker, 'keep');
  assert.equal((await sync(f, 'Chrome', tree(bookmark(1), bookmark(2)))).status, 500);
  assert.equal((await ack(f, 'Chrome', 1)).status, 409);
  await rm(blocker);
  assert.equal((await ack(f, 'Edge', 1)).body.cleaned, false);
  assert.equal(await readFile(filename, 'utf8'), saved);
  const retry = await sync(f, 'Chrome', tree(bookmark(1), bookmark(2)));
  assert.equal(retry.body.revision, 2);
  await ack(f, 'Chrome', 2);
  await sync(f, 'Edge', tree(bookmark(1), bookmark(2)));
  assert.equal((await ack(f, 'Edge', 2)).body.cleaned, true);
});

test('新增启用配对首次上传失败仍保留声明，不能用旧配对ACK遗漏失败的配对', async t => {
  const f = await fixture(t);
  await sync(f, 'Chrome', tree(bookmark(1)));
  await sync(f, 'Edge', tree(bookmark(1)));
  await ack(f, 'Chrome', 1);
  const blocker = path.join(f.dataDir, 'keep.txt');
  await writeFile(blocker, 'keep');
  assert.equal((await sync(f, 'Chrome', tree(bookmark(2)), 2, [1, 2])).status, 500);
  await rm(blocker);
  assert.equal((await ack(f, 'Edge', 1)).body.cleaned, false);
  const current = await status(f);
  assert.deepEqual(current.body.clients.find(client => client.name === 'Chrome').slots, [1, 2]);
  assert.deepEqual(current.body.slots.map(slot => slot.slot), [1, 2]);
  await sync(f, 'Edge', tree(bookmark(1)), 1, [1, 2]);
  await ack(f, 'Chrome', 1);
  assert.equal((await ack(f, 'Edge', 1)).body.cleaned, false);
  assert.equal(await exists(f.dataDir), true);
  await sync(f, 'Chrome', tree(bookmark(2)), 2, [1, 2]);
  await sync(f, 'Edge', tree(bookmark(2)), 2, [1, 2]);
  await ack(f, 'Chrome', 1, 2);
  assert.equal((await ack(f, 'Edge', 1, 2)).body.cleaned, true);
});

test('保存失败不提交内存状态，修复后继续；清理失败保留整个目录并报告失败', async t => {
  const f = await fixture(t);
  await sync(f, 'Chrome', tree(bookmark(1)));
  const filename = path.join(f.dataDir, 'state.json');
  const saved = await readFile(filename, 'utf8');
  const backup = `${f.dataDir}.previous`;
  t.after(() => rm(backup, { force: true }));
  await rename(filename, backup);
  await mkdir(filename);
  assert.equal((await sync(f, 'Chrome', tree(bookmark(2)))).status, 500);
  await rm(filename, { recursive: true });
  await rename(backup, filename);
  assert.equal(await readFile(filename, 'utf8'), saved);
  assert.deepEqual((await sync(f, 'Chrome', tree())).body.tree, tree(bookmark(1)));
  await sync(f, 'Edge', tree());
  await ack(f, 'Chrome', 1);
  const unrelated = path.join(f.dataDir, '用户文件.txt');
  await writeFile(unrelated, '保留');
  const failed = await ack(f, 'Edge', 1);
  assert.equal(failed.status, 500);
  assert.equal(failed.body.phase, 'error');
  assert.equal(failed.body.cleaned, false);
  assert.equal(await readFile(filename, 'utf8'), saved);
  assert.equal(await readFile(unrelated, 'utf8'), '保留');
  assert.equal((await readFile(path.join(f.dataDir, 'token.txt'), 'utf8')).trim(), f.bridge.token);
  await rm(unrelated);
  assert.equal((await ack(f, 'Edge', 1)).body.cleaned, true);
  assert.equal(await exists(f.dataDir), false);
});

test('自定义目录的无关文件在启动前被保护，旧命名组不混入编号配对也不阻止清理', async t => {
  const f = await fixture(t);
  await f.bridge.close();
  const unrelated = path.join(f.dataDir, 'keep.txt');
  await writeFile(unrelated, 'keep');
  await assert.rejects(createBridge({ dataDir: f.dataDir, port: 0 }), /非桥接文件/);
  assert.equal(await readFile(unrelated, 'utf8'), 'keep');
  await rm(unrelated);
  const old = { version: 1, revision: 9, groups: [
    { name: '旧手填组', tree: tree(bookmark('old')) },
    { name: '__proto__', tree: tree(bookmark('obsolete')) },
  ] };
  await writeFile(path.join(f.dataDir, 'state.json'), JSON.stringify(old));
  f.bridge = await createBridge({ dataDir: f.dataDir, port: 0 });
  f.port = (await f.bridge.start()).port;
  assert.deepEqual((await sync(f, 'Chrome', tree(bookmark(1)))).body.tree, tree(bookmark(1)));
  const saved = JSON.parse(await readFile(path.join(f.dataDir, 'state.json'), 'utf8'));
  assert.equal(saved.version, 2);
  assert.deepEqual(saved.legacyGroups, old.groups);
  await complete(f);
  assert.equal(await exists(f.dataDir), false);
});

test('状态接口仅含汇总且事件有界，after增量读取；Host和Origin保护包括无令牌接口', async t => {
  const f = await fixture(t);
  const health = await request(f, { method: 'GET', path: '/health', headers: { authorization: null, origin: null } });
  assert.deepEqual(health.body, { ok: true, app: 'bookmark-bridge', version: 2 });
  await sync(f, 'Chrome', tree({ title: '私密文件夹', children: [bookmark('secret')] }));
  const first = await status(f);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.slots[0], { slot: 1, revision: 1, acknowledged: [], bookmarkCount: 1, folderCount: 1 });
  const serialized = JSON.stringify(first.body);
  for (const secret of [f.bridge.token, '私密文件夹', bookmark('secret').url, bookmark('secret').title, CHROME]) {
    assert.equal(serialized.includes(secret), false);
  }
  const cursor = first.body.events.at(-1).seq;
  assert.deepEqual((await status(f, cursor)).body.events, []);
  for (let index = 0; index < 105; index++) await sync(f, 'Chrome', tree());
  const later = await status(f, cursor);
  assert.equal(later.body.events.length, 200);
  assert.ok(later.body.events.every(event => event.seq > cursor));
  for (const pathname of ['/health', '/v2/status', '/v2/status?after=1']) {
    for (const headers of [{ origin: 'https://evil.test' }, { host: `evil.test:${f.port}` }]) {
      assert.equal((await request(f, { path: pathname, method: 'GET', headers: { authorization: null, ...headers } })).status, 403);
    }
  }
  assert.equal((await request(f, { path: '/v2/status?token=secret', method: 'GET' })).status, 404);
  assert.equal((await request(f, { path: '/v1/sync', body: { group: 'old', tree: tree() } })).status, 404);
});

test('认证、严格来源和本机Host、预检和Content-Type保持安全限制', async t => {
  const f = await fixture(t);
  const body = payload('Chrome', tree());
  for (const authorization of [null, 'Bearer wrong', f.bridge.token, `bearer ${f.bridge.token}`]) {
    assert.equal((await request(f, { body, headers: { authorization } })).status, 401);
  }
  assert.equal((await request(f, { body, path: `/v2/sync?token=${f.bridge.token}` })).status, 404);
  for (const origin of ['https://evil.test', 'http://localhost', 'null', 'chrome-extension://bad',
    `chrome-extension://${'z'.repeat(32)}`, `${ORIGIN}/`, `${ORIGIN}.evil.test`]) {
    const rejected = await request(f, { body, headers: { origin } });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.headers['access-control-allow-origin'], undefined);
  }
  for (const host of ['evil.test', `evil.test:${f.port}`, `127.0.0.1:${f.port + 1}`, `127.0.0.1:${f.port}.evil.test`]) {
    assert.equal((await request(f, { body, headers: { host } })).status, 403);
  }
  assert.equal((await request(f, { body, headers: { host: `localhost:${f.port}`, origin: null } })).status, 200);
  for (const pathname of ['/v2/sync', '/v2/ack']) {
    const preflight = await request(f, { path: pathname, method: 'OPTIONS', headers: { authorization: null,
      'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type' } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], ORIGIN);
    assert.equal(preflight.headers['access-control-allow-headers'], 'Authorization, Content-Type');
  }
  assert.equal((await request(f, { method: 'OPTIONS', headers: { 'access-control-request-method': 'DELETE' } })).status, 403);
  assert.equal((await request(f, { method: 'OPTIONS', headers: {
    'access-control-request-method': 'POST', 'access-control-request-headers': 'x-secret' } })).status, 403);
  assert.equal((await request(f, { method: 'GET' })).status, 405);
  assert.equal((await request(f, { body, headers: { 'content-type': 'text/plain' } })).status, 415);
});

test('同客户端改选缺少并集的新目标时撤销旧ACK，应用失败不能被另一端ACK提前清理', async t => {
  const f = await fixture(t);
  await sync(f, 'Chrome', tree(bookmark(1)));
  await sync(f, 'Edge', tree(bookmark(1)));
  await ack(f, 'Chrome', 1);
  const newTarget = await sync(f, 'Chrome', tree());
  assert.equal(newTarget.body.revision, 1);
  assert.deepEqual(newTarget.body.tree, tree(bookmark(1)));
  assert.equal((await ack(f, 'Edge', 1)).body.cleaned, false);
  assert.equal(await exists(f.dataDir), true);
  assert.deepEqual((await status(f)).body.slots[0].acknowledged, ['Edge']);
  assert.equal((await ack(f, 'Chrome', 1)).body.cleaned, true);
  const afterCleanup = await sync(f, 'Chrome', tree());
  assert.equal(afterCleanup.body.cleaned, true);
  assert.equal(afterCleanup.body.phase, 'syncing');
  assert.equal(await exists(f.dataDir), false);
  assert.equal((await ack(f, 'Chrome', 1)).body.phase, 'complete');
});

test('严格JSON、配对编号、节点、UTF-8和请求体限制不改变存储', async t => {
  const f = await fixture(t);
  const valid = payload('Chrome', tree(bookmark(1)));
  assert.equal((await request(f, { body: valid })).status, 200);
  for (const body of [null, [], { ...valid, extra: true }, { ...valid, clientId: '' },
    { ...valid, clientName: 'Firefox' }, { ...valid, slots: [] }, { ...valid, slots: [1, 1] },
    { ...valid, slots: [2, 1] }, { ...valid, slots: [0] }, { ...valid, slots: [51] },
    { ...valid, slot: 2 }, { ...valid, slot: 1.5 },
    { ...valid, tree: { children: [{ title: '错误', url: '', children: [] }] } }]) {
    assert.equal((await request(f, { body })).status, 400);
  }
  assert.equal((await request(f, { rawBody: '{broken' })).status, 400);
  assert.equal((await request(f, { rawBody: Buffer.from([0xff]) })).status, 400);
  const json = JSON.stringify(valid);
  const exactLimit = json + ' '.repeat(MAX_BODY_BYTES - Buffer.byteLength(json));
  assert.equal((await request(f, { rawBody: exactLimit, headers: { 'content-length': String(MAX_BODY_BYTES) } })).status, 200);
  assert.equal((await request(f, { headers: { 'content-length': String(MAX_BODY_BYTES + 1) } })).status, 413);
  const chunk = Buffer.alloc(1024 * 1024, 32);
  assert.equal((await request(f, { chunks: Array(9).fill(chunk) })).status, 413);
  assert.deepEqual((await sync(f, 'Chrome', tree())).body.tree, valid.tree);
  for (const body of [{}, { clientId: CHROME, slot: 1, revision: 0, epoch: f.bridge.epoch },
    { clientId: CHROME, slot: 51, revision: 1, epoch: f.bridge.epoch }]) {
    assert.equal((await request(f, { path: '/v2/ack', body })).status, 400);
  }
});

test('损坏状态与令牌不覆盖，失败释放目录锁，安全关闭等待当前上传', async t => {
  const f = await fixture(t);
  const accepted = new Promise(resolve => f.bridge.server.once('request', resolve));
  const pending = sync(f, 'Chrome', tree(bookmark(1)));
  await accepted;
  const closing = f.bridge.close();
  assert.equal((await pending).status, 200);
  await closing;
  const statePath = path.join(f.dataDir, 'state.json');
  const savedState = await readFile(statePath, 'utf8');
  await writeFile(statePath, '{broken', 'utf8');
  await assert.rejects(createBridge({ dataDir: f.dataDir, port: 0 }), /无法读取书签数据/);
  assert.equal(await readFile(statePath, 'utf8'), '{broken');
  await writeFile(statePath, savedState, 'utf8');
  const tokenPath = path.join(f.dataDir, 'token.txt');
  await writeFile(tokenPath, 'bad token', 'utf8');
  await assert.rejects(createBridge({ dataDir: f.dataDir, port: 0 }), /令牌文件损坏/);
  assert.equal(await readFile(tokenPath, 'utf8'), 'bad token');
  await writeFile(tokenPath, `${f.bridge.token}\n`, 'utf8');
  await restart(f);
  assert.deepEqual((await sync(f, 'Chrome', tree())).body.tree, tree(bookmark(1)));
  await f.bridge.close();
  await assert.rejects(f.bridge.start(), /服务已经关闭/);
});

test('只读监视器识别v2服务，展示汇总和事件，退出不停止服务', async t => {
  const f = await fixture(t);
  assert.equal(await probeBridge(f.port), true);
  await sync(f, 'Chrome', tree(bookmark('monitor-secret')));
  const lines = [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    await monitorBridge({ port: f.port, signal: controller.signal, interval: 5,
      onLine: line => {
        lines.push(line);
        if (line.includes('上传配对')) controller.abort();
      },
    });
  } finally { clearTimeout(timeout); }
  assert.ok(lines.some(line => line.includes('Chrome 已注册')));
  assert.ok(lines.some(line => line.includes('上传配对')));
  assert.equal(lines.join('\n').includes(bookmark('monitor-secret').url), false);
  assert.equal(lines.join('\n').includes(f.bridge.token), false);
  assert.equal(await probeBridge(f.port), true);
  const foreign = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise(resolve => foreign.listen(0, '127.0.0.1', resolve));
  try { assert.equal(await probeBridge(foreign.address().port), false); }
  finally { await new Promise(resolve => foreign.close(resolve)); }
});

test('清理后重建目录的所有权标记写入失败可直接重试，不会永久EEXIST', async t => {
  const f = await fixture(t);
  await complete(f);
  const originalOpen = fsPromises.open;
  let failedOwnerWrite = false;
  const replacement = t.mock.method(fsPromises, 'open', async function(filename, ...args) {
    if (String(filename).startsWith(path.join(f.dataDir, '.bridge-owner.'))) {
      failedOwnerWrite = true;
      throw Object.assign(new Error('模拟磁盘暂时写入失败'), { code: 'ENOSPC' });
    }
    return originalOpen.call(this, filename, ...args);
  });
  syncBuiltinESMExports();
  try {
    const failed = await sync(f, 'Chrome', tree(bookmark(2)));
    assert.equal(failedOwnerWrite, true);
    assert.equal(failed.status, 500);
    assert.equal(failed.body.cleaned, false);
    assert.equal(await exists(f.dataDir), true);
  } finally {
    replacement.mock.restore();
    syncBuiltinESMExports();
  }
  const recovered = await sync(f, 'Chrome', tree(bookmark(2)));
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.revision, 2);
  assert.deepEqual(recovered.body.tree, tree(bookmark(1), bookmark(2)));
  assert.equal((await readFile(path.join(f.dataDir, 'token.txt'), 'utf8')).trim(), f.bridge.token);
  await ack(f, 'Chrome', 2);
  await sync(f, 'Edge', tree(bookmark(1), bookmark(2)));
  assert.equal((await ack(f, 'Edge', 2)).body.cleaned, true);
});

test('监视器检测到新epoch后从零读取，旧游标过滤的响应不会吞掉新会话首个事件', async () => {
  const cursors = [];
  const lines = [];
  const controller = new AbortController();
  const server = http.createServer((req, res) => {
    const after = Number(new URL(req.url, 'http://localhost').searchParams.get('after'));
    cursors.push(after);
    const first = cursors.length === 1;
    const events = (first ? [1] : [1, 2, 3, 4]).filter(seq => seq > after).map(seq => ({
      seq, time: '2026-10-30T00:00:00.000Z', message: `${first ? '旧' : '新'}会话事件${seq}`,
    }));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ phase: 'waiting', cleaned: false,
      epoch: first ? CHROME : EDGE, clients: [], slots: [], events }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    await monitorBridge({ port: server.address().port, signal: controller.signal, interval: 1,
      onLine: line => {
        lines.push(line);
        if (line.includes('新会话事件4')) controller.abort();
      },
    });
    assert.deepEqual(cursors.slice(0, 3), [0, 1, 0]);
    for (const seq of [1, 2, 3, 4]) {
      assert.equal(lines.filter(line => line.includes(`新会话事件${seq}`)).length, 1);
    }
  } finally {
    clearTimeout(timeout);
    await new Promise(resolve => server.close(resolve));
  }
});
