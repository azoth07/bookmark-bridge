import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';

const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
const TOKEN = 'a'.repeat(64);
const PENDING = 'bookmark-bridge-pending';
const tree = (...children) => ({ children });
const link = (name) => ({ title: name, url: `https://example.test/${name}` });
const mapping = (slot, folderId = String(slot)) => ({ id: `mapping-${slot}`, slot, folderId, enabled: true });
const config = (...mappings) => ({ schemaVersion: 2, token: TOKEN, autoSync: false, mappings });
const plain = value => JSON.parse(JSON.stringify(value));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function harness(options = {}) {
  const data = structuredClone(options.storage || { settings: config(mapping(1)) });
  const nodes = new Map();
  const alarms = new Map();
  const requests = [];
  const creates = [];
  const writes = [];
  const notifications = [];
  const notificationAttempts = [];
  const listeners = {};
  let nextId = 100;
  const event = name => ({ addListener: callback => { listeners[name] = callback; } });
  function add(node, parentId) {
    const copy = { ...node, parentId };
    if (copy.url === undefined) copy.children = [];
    nodes.set(copy.id, copy);
    for (const child of node.children || []) copy.children.push(add(child, copy.id));
    return copy;
  }
  const root = add({ id: '0', title: '', children: options.folders || [{ id: '1', title: '目标', children: [] }] });
  const f = {
    data, nodes, alarms, requests, creates, writes, notifications, notificationAttempts,
    status: { phase: 'waiting', cleaned: false, epoch: 'epoch-1', clients: [], slots: [], events: [] },
    remote: new Map(), beforeCreate: null, beforeRequest: null,
    notificationPermission: 'granted', beforeNotification: null, optionsOpened: 0,
  };
  const chrome = {
    storage: { local: {
      async get(keys) {
        const selected = typeof keys === 'string' ? [keys] : keys;
        return structuredClone(Object.fromEntries(selected.filter(key => key in data).map(key => [key, data[key]])));
      },
      async set(values) {
        writes.push(structuredClone(values));
        Object.assign(data, structuredClone(values));
      },
      async setAccessLevel() {},
    } },
    bookmarks: {
      async getTree() { return [structuredClone(root)]; },
      async getSubTree(id) {
        if (!nodes.has(id)) throw new Error('missing folder');
        return [structuredClone(nodes.get(id))];
      },
      async getChildren(id) {
        if (!nodes.has(id)) throw new Error('missing folder');
        return structuredClone(nodes.get(id).children);
      },
      async create(value) {
        creates.push(plain(value));
        if (f.beforeCreate) await f.beforeCreate(value);
        const parent = nodes.get(value.parentId);
        if (!parent?.children) throw new Error('missing folder');
        const node = add({ id: String(nextId++), ...plain(value) }, value.parentId);
        parent.children.push(node);
        return structuredClone(node);
      },
      onCreated: event('created'), onChanged: event('changed'), onMoved: event('moved'), onRemoved: event('removed'),
    },
    alarms: {
      async create(name, value) { alarms.set(name, plain(value)); },
      async clear(name) { return alarms.delete(name); },
      onAlarm: event('alarm'),
    },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {}, onClicked: event('clicked') },
    runtime: { id: 'worker-test', onMessage: event('message'), onInstalled: event('installed'), onStartup: event('startup'), async openOptionsPage() { f.optionsOpened++; } },
    notifications: options.notifications === false ? undefined : {
      async getPermissionLevel() { return f.notificationPermission; },
      async create(id, value) {
        notificationAttempts.push({ id, ...plain(value) });
        if (f.beforeNotification) await f.beforeNotification(id, value);
        notifications.push({ id, ...plain(value) });
        return id;
      },
      onClicked: event('notificationClicked'),
    },
  };
  async function fetch(url, request = {}) {
    const path = new URL(url).pathname;
    const body = request.body ? JSON.parse(request.body) : undefined;
    const call = { path, body, headers: request.headers };
    requests.push(call);
    const override = f.beforeRequest ? await f.beforeRequest(call) : undefined;
    const response = override || (path === '/health' ? { body: { ok: true, app: 'bookmark-bridge', version: 2 } }
      : path === '/v2/status' ? { body: f.status }
      : path === '/v2/sync' ? { body: { tree: f.remote.get(body.slot) || body.tree, revision: 1, epoch: 'epoch-1', phase: 'syncing', cleaned: false } }
      : path === '/v2/ack' ? { body: { phase: 'waiting', cleaned: false, pendingSlots: [body.slot] } }
      : { status: 404, body: { error: 'unexpected endpoint' } });
    return { ok: (response.status || 200) < 400, status: response.status || 200, async json() { return structuredClone(response.body); } };
  }
  vm.runInNewContext(source, { chrome, fetch, navigator: { userAgent: options.userAgent || 'Chrome/130.0' }, crypto: { randomUUID }, AbortSignal, structuredClone, console });
  f.message = message => new Promise(resolve => listeners.message(message, { id: chrome.runtime.id }, result => resolve(plain(result))));
  f.sync = () => f.message({ type: 'syncNow' });
  f.state = () => f.message({ type: 'getState' });
  f.save = settings => f.message({ type: 'saveSettings', settings });
  f.alarm = name => listeners.alarm({ name });
  f.changed = () => listeners.changed();
  f.startup = () => listeners.startup();
  f.clickNotification = id => listeners.notificationClicked(id);
  f.acks = () => requests.filter(request => request.path === '/v2/ack').map(request => request.body);
  f.uploads = () => requests.filter(request => request.path === '/v2/sync').map(request => request.body);
  f.complete = (revision = 1, epoch = 'epoch-1') => {
    f.status = { phase: 'complete', cleaned: true, epoch, clients: [{ name: 'Chrome', slots: [1] }, { name: 'Edge', slots: [1] }],
      slots: [{ slot: 1, revision, acknowledged: ['Chrome', 'Edge'], bookmarkCount: 1, folderCount: 0 }], events: [] };
  };
  return f;
}

test('旧组按原顺序迁移，保留目标；删除配对不重排，新增使用空缺槽位', async () => {
  const f = harness({ storage: { settings: { token: TOKEN, autoSync: false, mappings: [
    { id: 'first', group: '手动名称', folderId: '1', enabled: true },
    { id: 'second', group: '另一名称', folderId: '2', enabled: true },
  ] } }, folders: [{ id: '1', title: '一', children: [] }, { id: '2', title: '二', children: [] }] });
  const states = await Promise.all([f.state(), f.state()]);
  assert.deepEqual(states[0].settings, { schemaVersion: 2, token: TOKEN, autoSync: false, mappings: [
    { id: 'first', slot: 1, folderId: '1', enabled: true }, { id: 'second', slot: 2, folderId: '2', enabled: true },
  ] });
  assert.equal(f.writes.filter(write => write.settings).length, 1);
  const remaining = { ...states[0].settings, mappings: [states[0].settings.mappings[1]] };
  assert.deepEqual((await f.save(remaining)).settings.mappings, remaining.mappings);
  const added = { ...remaining, mappings: [...remaining.mappings, { id: 'new', slot: 1, folderId: '1', enabled: true }] };
  const saved = await f.save(added);
  assert.deepEqual(saved.settings.mappings.map(item => [item.id, item.slot, item.folderId]), [['new', 1, '1'], ['second', 2, '2']]);
  assert.equal(f.data.settings.schemaVersion, 2);
});

test('拒绝旧手动组字段、重复槽位和父子重叠目标', async () => {
  const f = harness({ folders: [{ id: '1', title: '一', children: [{ id: '2', title: '子', children: [] }] }] });
  assert.equal((await f.save(config({ ...mapping(1), group: '不能输入' }))).ok, false);
  assert.equal((await f.save(config(mapping(1), { ...mapping(2), slot: 1 }))).ok, false);
  assert.equal((await f.save(config(mapping(1), mapping(2)))).ok, false);
  assert.deepEqual(f.data.settings, config(mapping(1)));
});

test('任何创建失败均不ACK该槽位；已新增书签保留，下一次补齐后才ACK', async () => {
  const f = harness();
  f.remote.set(1, tree(link('成功'), link('失败')));
  f.beforeCreate = value => { if (value.title === '失败') throw new Error('写入失败'); };
  const first = await f.sync();
  assert.equal(first.ok, false);
  assert.equal(first.added, 1);
  assert.match(first.error, /写入失败/);
  assert.equal(f.acks().length, 0);
  assert.equal(f.data.pendingSync, true);
  assert.equal(f.alarms.has(PENDING), true);
  assert.deepEqual(f.nodes.get('1').children.map(node => node.title), ['成功']);
  f.beforeCreate = null;
  const second = await f.sync();
  assert.equal(second.ok, true);
  assert.equal(second.added, 1);
  assert.deepEqual(f.acks().map(({ slot, revision, epoch }) => ({ slot, revision, epoch })), [{ slot: 1, revision: 1, epoch: 'epoch-1' }]);
  assert.deepEqual(f.nodes.get('1').children.map(node => node.title), ['成功', '失败']);
});

test('缺失目标隔离错误，其余槽位仍上传应用并ACK；每次声明完整槽位列表', async () => {
  const f = harness({ storage: { settings: config(mapping(3, 'missing'), mapping(1)) } });
  f.remote.set(1, tree(link('可写')));
  const result = await f.sync();
  assert.equal(result.ok, false);
  assert.match(result.error, /配对 3/);
  assert.deepEqual(f.uploads().map(({ slot, slots }) => ({ slot, slots })), [{ slot: 1, slots: [1, 3] }]);
  assert.deepEqual(f.acks().map(ack => ack.slot), [1]);
  assert.equal(f.nodes.get('1').children[0].url, link('可写').url);
  assert.equal(f.data.pendingSync, true);
});

test('同名重复文件夹按逻辑路径共同去重，保留物理布局并只添加缺失项', async () => {
  const f = harness({ folders: [{ id: '1', title: '目标', children: [
    { id: '10', title: '同名', children: [{ id: '11', title: '内层', children: [{ id: '12', ...link('一') }] }] },
    { id: '20', title: '同名', children: [{ id: '21', title: '内层', children: [{ id: '22', ...link('二') }] }] },
  ] }] });
  f.remote.set(1, tree({ title: '同名', children: [{ title: '内层', children: [link('一'), link('二'), link('三')] }] }));
  const result = await f.sync();
  assert.equal(result.ok, true);
  assert.equal(result.added, 1);
  assert.deepEqual(f.creates, [{ parentId: '11', ...link('三') }]);
  assert.deepEqual(f.nodes.get('1').children.map(node => node.id), ['10', '20']);
  assert.deepEqual(f.nodes.get('21').children.map(node => node.id), ['22']);
  assert.equal(f.acks().length, 1);
});

test('完成状态必须匹配本地ACK修订号和epoch，getState不写书签', async () => {
  const f = harness();
  f.remote.set(1, tree(link('已应用')));
  const result = await f.sync();
  assert.equal(result.phase, 'waiting');
  assert.equal(result.cleaned, false);
  f.complete(2);
  assert.equal((await f.state()).status.cleaned, false);
  assert.equal(f.alarms.has(PENDING), true);
  f.complete(1, '重启后的服务');
  assert.equal((await f.state()).status.cleaned, false);
  f.complete();
  const requestsBefore = f.uploads().length;
  const createsBefore = f.creates.length;
  const complete = await f.state();
  assert.equal(complete.status.phase, 'complete');
  assert.equal(complete.status.cleaned, true);
  assert.equal(f.data.pendingSync, false);
  assert.equal(f.alarms.has(PENDING), false);
  assert.equal(f.uploads().length, requestsBefore);
  assert.equal(f.creates.length, createsBefore);
  f.status.phase = 'syncing';
  f.status.cleaned = false;
  assert.equal((await f.state()).status.cleaned, false);
});

test('对方已完成但当前浏览器从未应用时不能显示全局完成', async () => {
  const f = harness();
  f.complete();
  const state = await f.state();
  assert.equal(state.status.cleaned, false);
  assert.equal(state.status.phase, 'waiting');
  assert.equal(f.creates.length, 0);
  assert.equal(f.acks().length, 0);
});

test('手动发起后auto关闭仍继续pending；双方确认后清除pending', async () => {
  const f = harness();
  assert.equal((await f.sync()).phase, 'waiting');
  f.remote.set(1, tree(link('对方后来上传')));
  f.complete();
  await f.alarm(PENDING);
  assert.equal(f.nodes.get('1').children[0].url, link('对方后来上传').url);
  assert.equal(f.acks().length, 2);
  assert.equal(f.data.status.phase, 'complete');
  assert.equal(f.data.pendingSync, false);
  assert.equal(f.alarms.has(PENDING), false);
  await f.alarm(PENDING);
  assert.equal(f.acks().length, 2);
});

test('pending遇到服务离线仍保留，重启401停止轮询并提示两个浏览器重新配对', async () => {
  const f = harness();
  await f.sync();
  f.beforeRequest = ({ path }) => { if (path === '/v2/sync') throw new Error('offline'); };
  await f.alarm(PENDING);
  assert.equal(f.data.pendingSync, true);
  assert.equal(f.alarms.has(PENDING), true);
  f.beforeRequest = ({ path }) => path === '/v2/sync' ? { status: 401, body: { error: 'invalid token' } } : undefined;
  await f.alarm(PENDING);
  assert.equal(f.data.pendingSync, false);
  assert.equal(f.alarms.has(PENDING), false);
  assert.match(f.data.status.error, /两个浏览器重新配对/);
  assert.equal(f.acks().length, 1);
});

test('创建未完成时不ACK，不允许保存修改目标，并发同步共用同一UUID', async () => {
  const f = harness();
  const entered = deferred();
  const release = deferred();
  f.remote.set(1, tree(link('等待创建')));
  f.beforeCreate = async () => { entered.resolve(); await release.promise; };
  const first = f.sync();
  await entered.promise;
  const second = f.sync();
  const saved = await f.save(config({ ...mapping(1), enabled: false }));
  assert.equal(saved.ok, false);
  assert.equal(f.acks().length, 0);
  assert.equal(f.uploads().length, 1);
  release.resolve();
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
  assert.equal(f.acks()[0].clientId, f.uploads()[0].clientId);
  assert.equal(f.data.clientId, f.acks()[0].clientId);
  assert.match(f.data.clientId, /^[0-9a-f-]{36}$/);
  assert.equal(f.writes.filter(write => write.clientId).length, 1);
  const restarted = harness({ storage: f.data, userAgent: 'Chrome/130.0 Edg/130.0' });
  await restarted.sync();
  assert.equal(restarted.uploads()[0].clientId, f.data.clientId);
  assert.equal(restarted.uploads()[0].clientName, 'Edge');
});

test('旧ACK的状态请求与新同步交错时不能清掉新pending或显示完成', async () => {
  const f = harness();
  await f.sync();
  f.complete();
  const entered = deferred();
  const release = deferred();
  let delay = true;
  f.beforeRequest = async ({ path }) => {
    if (path === '/v2/status' && delay) {
      delay = false;
      entered.resolve();
      await release.promise;
    }
  };
  const oldState = f.state();
  await entered.promise;
  f.status = { ...f.status, phase: 'syncing', cleaned: false };
  await f.sync();
  // Simulate a delayed response containing completion from the prior request.
  f.complete();
  release.resolve();
  const state = await oldState;
  assert.equal(state.status.cleaned, false);
  assert.equal(f.data.pendingSync, true);
  assert.equal(f.alarms.has(PENDING), true);
  assert.equal(f.notifications.length, 0);
});

test('自动模式保留周期与书签变更触发，关闭自动模式不启动这些同步', async () => {
  const f = harness();
  await f.save({ ...config(mapping(1)), autoSync: true });
  assert.deepEqual(f.alarms.get('bookmark-bridge-periodic'), { periodInMinutes: 1 });
  await f.changed();
  assert.equal(f.alarms.has('bookmark-bridge-changed'), true);
  await f.alarm('bookmark-bridge-periodic');
  assert.equal(f.acks().length, 1);
  await f.save(config(mapping(1)));
  assert.equal(f.alarms.has('bookmark-bridge-periodic'), false);
  assert.equal(f.alarms.has('bookmark-bridge-changed'), false);
  await f.alarm('bookmark-bridge-periodic');
  assert.equal(f.acks().length, 1);
  assert.equal(f.data.pendingSync, true);
});

test('服务离线不把上次目录已清理展示为当前完成', async () => {
  const f = harness();
  await f.sync();
  f.complete();
  assert.equal((await f.state()).status.cleaned, true);
  assert.equal(f.data.status.cleaned, true);
  f.beforeRequest = () => { throw new Error('offline'); };
  const offline = await f.state();
  assert.equal(offline.connected, false);
  assert.equal(offline.status.cleaned, false);
  assert.equal(offline.status.phase, 'waiting');
});

test('切换配对目标后清除旧会话完成凭据和pending，不能借用原目标ACK', async () => {
  const f = harness({ folders: [{ id: '1', title: '旧目标', children: [] }, { id: '2', title: '新目标', children: [] }] });
  await f.sync();
  const saved = await f.save(config(mapping(1, '2')));
  assert.equal(saved.ok, true);
  assert.equal(f.data.syncSession, null);
  assert.equal(f.data.pendingSync, false);
  assert.equal(f.data.completionNotifications, null);
  assert.equal(f.alarms.has(PENDING), false);
  f.complete();
  assert.equal((await f.state()).status.cleaned, false);
});

test('仅本地ACK、对端未确认或目录未删除均不通知；全部完成后只通知一次', async () => {
  const f = harness();
  f.complete();
  await f.state();
  assert.equal(f.notifications.length, 0);
  f.status.phase = 'waiting';
  f.status.cleaned = false;
  assert.equal((await f.sync()).phase, 'waiting');
  await f.state();
  assert.equal(f.notifications.length, 0);
  f.complete();
  f.status.cleaned = false;
  await f.state();
  assert.equal(f.notifications.length, 0);
  f.status.cleaned = true;
  const states = await Promise.all([f.state(), f.state(), f.state()]);
  assert.ok(states.some(state => state.status.cleaned));
  await f.state();
  assert.equal(f.notifications.length, 1);
  assert.equal(f.notifications[0].type, 'basic');
  assert.equal(f.notifications[0].iconUrl, 'notification.png');
  assert.match(f.notifications[0].title, /同步已完成/);
  assert.match(f.notifications[0].message, /Chrome 和 Edge.*目录已成功删除/);
  await f.clickNotification(f.notifications[0].id);
  assert.equal(f.optionsOpened, 1);
});

test('同一版本的每次独立手动同步均通知；并发按钮共用一次执行和通知', async () => {
  const f = harness();
  f.complete();
  const first = await Promise.all([f.sync(), f.sync()]);
  assert.ok(first.every(result => result.ok && result.cleaned));
  assert.equal(f.notifications.length, 1);
  assert.equal(f.uploads().length, 1);
  assert.equal((await f.sync()).cleaned, true);
  assert.equal(f.notifications.length, 2);
  assert.notEqual(f.notifications[0].id, f.notifications[1].id);
  await f.state();
  assert.equal(f.notifications.length, 2);
});

test('手动等待意图跨worker重启保留；每次独立等待执行完成均通知且不重复', async () => {
  const f = harness();
  await f.sync();
  await f.sync();
  assert.equal(f.notifications.length, 0);
  const restarted = harness({ storage: f.data });
  await restarted.startup();
  assert.equal(restarted.alarms.has(PENDING), true);
  restarted.complete();
  await restarted.alarm(PENDING);
  assert.equal(restarted.notifications.length, 2);
  assert.equal(new Set(restarted.notifications.map(item => item.id)).size, 2);
  const again = harness({ storage: restarted.data });
  again.complete();
  await again.state();
  assert.equal(again.notifications.length, 0);
  await again.sync();
  assert.equal(again.notifications.length, 1);
});

test('周期同步只为新epoch或修订版本通知，重启后仍抑制相同版本', async () => {
  const f = harness({ storage: { settings: { ...config(mapping(1)), autoSync: true } } });
  f.beforeRequest = ({ path, body }) => path === '/v2/sync' ? { body: {
    tree: body.tree, revision: f.status.slots[0].revision, epoch: f.status.epoch
  } } : undefined;
  f.complete();
  await f.alarm('bookmark-bridge-periodic');
  await f.alarm('bookmark-bridge-periodic');
  await f.state();
  assert.equal(f.notifications.length, 1);
  f.complete(2);
  await f.state();
  assert.equal(f.notifications.length, 1);
  await f.alarm('bookmark-bridge-periodic');
  assert.equal(f.notifications.length, 2);
  f.complete(2, 'epoch-2');
  await f.alarm('bookmark-bridge-periodic');
  await f.alarm('bookmark-bridge-periodic');
  assert.equal(f.notifications.length, 3);
  const restarted = harness({ storage: f.data });
  restarted.complete(2, 'epoch-2');
  await restarted.state();
  assert.equal(restarted.notifications.length, 0);
});

test('同步写入失败不通知或覆盖真实错误，pending自动补齐后再通知', async () => {
  const f = harness();
  f.complete();
  f.remote.set(1, tree(link('写入失败')));
  f.beforeCreate = () => { throw new Error('真实写入错误'); };
  const failed = await f.sync();
  assert.equal(failed.ok, false);
  assert.match(failed.error, /真实写入错误/);
  assert.equal(f.notifications.length, 0);
  assert.equal((await f.state()).status.phase, 'error');
  assert.equal(f.notifications.length, 0);
  f.beforeCreate = null;
  await f.alarm(PENDING);
  assert.equal(f.data.status.error, '');
  assert.equal(f.notifications.length, 1);
});

test('系统通知失败不影响同步成功，不记为已送达；重启后沿用ID重试', async () => {
  const f = harness();
  f.complete();
  f.beforeNotification = () => { throw new Error('notification unavailable'); };
  const result = await f.sync();
  assert.equal(result.ok, true);
  assert.equal(result.cleaned, true);
  assert.equal(f.data.status.error, '');
  assert.equal(f.notifications.length, 0);
  assert.equal(f.data.completionNotifications.delivered, null);
  const restarted = harness({ storage: f.data });
  restarted.complete();
  await restarted.state();
  assert.equal(restarted.notifications.length, 1);
  assert.equal(restarted.notifications[0].id, f.notificationAttempts[0].id);
  await restarted.state();
  assert.equal(restarted.notifications.length, 1);
});

test('自动通知创建失败同样允许重试，不因版本去重丢失通知', async () => {
  const f = harness({ storage: { settings: { ...config(mapping(1)), autoSync: true } } });
  f.complete();
  f.beforeNotification = () => { throw new Error('temporarily unavailable'); };
  await f.alarm('bookmark-bridge-periodic');
  assert.equal(f.data.status.phase, 'complete');
  assert.equal(f.data.completionNotifications.delivered, null);
  f.beforeNotification = null;
  await f.alarm('bookmark-bridge-periodic');
  assert.equal(f.notifications.length, 1);
  assert.equal(f.notifications[0].id, f.notificationAttempts[0].id);
  await f.alarm('bookmark-bridge-periodic');
  assert.equal(f.notifications.length, 1);
});

test('通知权限拒绝或API不可用不会破坏同步，恢复权限后等待通知可送达', async () => {
  const f = harness();
  f.complete();
  f.notificationPermission = 'denied';
  assert.equal((await f.sync()).ok, true);
  assert.equal(f.notifications.length, 0);
  assert.equal(f.data.completionNotifications.delivered, null);
  f.notificationPermission = 'granted';
  await f.state();
  assert.equal(f.notifications.length, 1);
  const unavailable = harness({ notifications: false });
  unavailable.complete();
  assert.equal((await unavailable.sync()).cleaned, true);
  assert.equal(unavailable.data.completionNotifications.delivered, null);
});

test('通知创建与并发状态读取重叠时保持同步单飞，不重复发送通知', async () => {
  const f = harness();
  f.complete();
  const entered = deferred();
  const release = deferred();
  f.beforeNotification = async () => { entered.resolve(); await release.promise; };
  const first = f.sync();
  await entered.promise;
  const second = f.sync();
  const states = await Promise.all([f.state(), f.state()]);
  assert.ok(states.every(state => state.status.phase === 'syncing'));
  assert.equal(f.uploads().length, 1);
  release.resolve();
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
  await Promise.all([f.state(), f.state()]);
  assert.equal(f.notifications.length, 1);
});

test('Chrome和Edge分别通知一次，通知去重记录不保存配对密钥', async () => {
  for (const userAgent of ['Chrome/130.0', 'Chrome/130.0 Edg/130.0']) {
    const f = harness({ userAgent });
    await f.sync();
    f.complete();
    await f.state();
    await f.state();
    assert.equal(f.notifications.length, 1);
    assert.equal(JSON.stringify(f.data.completionNotifications).includes(TOKEN), false);
  }
});
