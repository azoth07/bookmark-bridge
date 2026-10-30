const BRIDGE = 'http://127.0.0.1:38473';
const PERIODIC = 'bookmark-bridge-periodic';
const CHANGED = 'bookmark-bridge-changed';
const PENDING = 'bookmark-bridge-pending';
const COMPLETION_NOTIFICATION = 'bookmark-bridge-complete-';
const DEFAULTS = { schemaVersion: 2, token: '', autoSync: true, mappings: [] };
const CLIENT_NAME = /Edg\//.test(navigator.userAgent) ? 'Edge' : 'Chrome';
let syncTask = null;
let saving = false;
let settingsTask = null;
let identityTask = null;
let operationVersion = 0;
let notificationTask = Promise.resolve();

function settings() {
  if (!settingsTask) settingsTask = (async () => {
    const stored = (await chrome.storage.local.get('settings')).settings;
    if (!stored) return structuredClone(DEFAULTS);
    if (stored.schemaVersion === 2) return stored;
    const migrated = {
      schemaVersion: 2, token: stored.token || '', autoSync: stored.autoSync !== false,
      mappings: (stored.mappings || []).map((mapping, index) => ({
        id: mapping.id, slot: index + 1, folderId: mapping.folderId, enabled: mapping.enabled
      }))
    };
    await chrome.storage.local.set({ settings: migrated });
    return migrated;
  })().catch(error => { settingsTask = null; throw error; });
  return settingsTask;
}

function clientId() {
  if (!identityTask) identityTask = (async () => {
    const stored = (await chrome.storage.local.get('clientId')).clientId;
    if (typeof stored === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(stored)) return stored;
    const id = crypto.randomUUID();
    await chrome.storage.local.set({ clientId: id });
    return id;
  })().catch(error => { identityTask = null; throw error; });
  return identityTask;
}

function sessionKey(config) {
  return JSON.stringify([config.token, config.mappings.filter(item => item.enabled)
    .map(item => [item.slot, item.folderId]).sort((a, b) => a[0] - b[0])]);
}

async function folderIndex() {
  const folders = [];
  const nodes = new Map();
  function visit(node, parents, managed) {
    const locked = managed || Boolean(node.unmodifiable);
    const names = node.title ? [...parents, node.title] : parents;
    if (!node.url && node.id !== '0' && !locked) {
      const folder = { id: node.id, path: names.join(' / ') };
      folders.push(folder);
      nodes.set(node.id, node);
    }
    for (const child of node.children || []) visit(child, names, locked);
  }
  for (const root of await chrome.bookmarks.getTree()) visit(root, [], false);
  return { folders, nodes };
}

async function validateSettings(value, requireFolders = true) {
  if (!value || value.schemaVersion !== 2 || typeof value.token !== 'string' || typeof value.autoSync !== 'boolean' || !Array.isArray(value.mappings)) {
    throw new Error('设置格式无效，请刷新页面后重试。');
  }
  const token = value.token.trim();
  if (token && !/^[a-f0-9]{64}$/i.test(token)) throw new Error('配对密钥应为连接服务显示的 64 位字符。');
  if (value.mappings.length > 50) throw new Error('最多可配置 50 个配对。');
  const { nodes } = await folderIndex();
  const ids = new Set();
  const slots = new Set();
  const selected = new Set();
  const mappings = value.mappings.map((mapping) => {
    if (!mapping || typeof mapping.id !== 'string' || !mapping.id || ids.has(mapping.id) ||
        Object.hasOwn(mapping, 'group') || !Number.isInteger(mapping.slot) || mapping.slot < 1 || mapping.slot > 50 ||
        typeof mapping.folderId !== 'string' || !mapping.folderId || typeof mapping.enabled !== 'boolean') {
      throw new Error('配对设置无效，请刷新页面后重试。');
    }
    if (requireFolders && mapping.enabled && !nodes.has(mapping.folderId)) throw new Error(`「配对 ${mapping.slot}」的文件夹不存在或无法写入，请重新选择。`);
    if (slots.has(mapping.slot)) throw new Error('同一浏览器内每个配对只能选择一个文件夹。');
    if (selected.has(mapping.folderId)) throw new Error('同一文件夹不能重复配置。');
    ids.add(mapping.id);
    slots.add(mapping.slot);
    selected.add(mapping.folderId);
    return { id: mapping.id, slot: mapping.slot, folderId: mapping.folderId, enabled: mapping.enabled };
  }).sort((a, b) => a.slot - b.slot);
  for (const mapping of mappings) {
    let node = nodes.get(mapping.folderId);
    while (node && node.parentId) {
      if (selected.has(node.parentId)) throw new Error('不能同时选择一个文件夹及其子文件夹，否则会重复同步。');
      node = nodes.get(node.parentId);
    }
  }
  return { schemaVersion: 2, token, autoSync: value.autoSync, mappings };
}

async function configureAlarms(config) {
  await chrome.alarms.clear(PERIODIC);
  await chrome.alarms.clear(CHANGED);
  if (config.autoSync && config.token && config.mappings.some((item) => item.enabled)) {
    await chrome.alarms.create(PERIODIC, { periodInMinutes: 1 });
  }
  if ((await chrome.storage.local.get('pendingSync')).pendingSync) {
    await chrome.alarms.create(PENDING, { periodInMinutes: 1 });
  }
}

function snapshot(node) {
  return { children: (node.children || []).map((child) => child.url !== undefined
    ? { title: child.title, url: child.url }
    : { title: child.title, ...snapshot(child) }) };
}

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(`${BRIDGE}${path}`, { ...options, signal: AbortSignal.timeout(20000), cache: 'no-store' });
  } catch {
    throw new Error('无法连接本机服务，请先双击 start-bridge.cmd，并保持服务窗口打开。');
  }
  if (response.status === 401 || response.status === 403) {
    const error = new Error('配对密钥已失效或服务已重新启动，请从 CMD 服务窗口复制当前密钥，在两个浏览器重新配对。');
    error.invalidToken = true;
    throw error;
  }
  let data;
  try { data = await response.json(); } catch { throw new Error('连接服务返回了无法识别的数据。'); }
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : `连接服务错误（${response.status}）。`);
  return data;
}

function validateTree(tree) {
  let count = 0;
  function visit(folder, depth) {
    if (!folder || !Array.isArray(folder.children) || depth > 64) throw new Error('同步数据的文件夹结构无效。');
    for (const child of folder.children) {
      if (++count > 100000 || !child || typeof child.title !== 'string') throw new Error('同步数据无效或数量超出限制。');
      if (typeof child.url === 'string') {
        if (!child.url || child.children !== undefined) throw new Error('同步书签数据无效。');
      } else {
        if (child.url !== undefined) throw new Error('同步书签网址无效。');
        visit(child, depth + 1);
      }
    }
  }
  visit(tree, 0);
}

async function appendMissing(parentIds, incoming, progress) {
  const parentId = parentIds[0];
  const urls = new Set();
  const folders = new Map();
  // Existing same-name folders represent one logical path; preserve their layout.
  for (const id of parentIds) {
    for (const child of await chrome.bookmarks.getChildren(id)) {
      if (child.url !== undefined) urls.add(child.url);
      else if (!child.unmodifiable) {
        if (!folders.has(child.title)) folders.set(child.title, []);
        folders.get(child.title).push(child.id);
      }
    }
  }
  for (const child of incoming.children) {
    if (child.url !== undefined) {
      if (!urls.has(child.url)) {
        await chrome.bookmarks.create({ parentId, title: child.title, url: child.url });
        urls.add(child.url);
        progress.added++;
      }
    } else {
      let folderIds = folders.get(child.title);
      if (!folderIds) {
        const created = await chrome.bookmarks.create({ parentId, title: child.title });
        folderIds = [created.id];
        folders.set(child.title, folderIds);
        progress.added++;
      }
      await appendMissing(folderIds, child, progress);
    }
  }
}

async function setPending(pending) {
  await chrome.storage.local.set({ pendingSync: pending });
  if (pending) await chrome.alarms.create(PENDING, { periodInMinutes: 1 });
  else await chrome.alarms.clear(PENDING);
}

function completedFor(config, session, bridgeStatus) {
  const slots = config.mappings.filter(item => item.enabled).map(item => item.slot);
  return Boolean(slots.length && session?.key === sessionKey(config) && session.epoch &&
    bridgeStatus?.phase === 'complete' && bridgeStatus.cleaned === true && bridgeStatus.epoch === session.epoch &&
    Array.isArray(bridgeStatus.slots) && slots.every(slot => {
      const current = bridgeStatus.slots.find(item => item.slot === slot);
      return current && session.acks[slot] === current.revision &&
        Array.isArray(current.acknowledged) && current.acknowledged.includes(CLIENT_NAME);
    }));
}

// Serialize persistent receipts, including callers that overlap while reading status.
// Notification failures must never replace a real synchronization result/error.
function withNotifications(action) {
  notificationTask = notificationTask.then(action).catch(() => {});
  return notificationTask;
}

async function notificationState(config) {
  const key = JSON.stringify(config.mappings.filter(item => item.enabled)
    .map(item => [item.slot, item.folderId]).sort((a, b) => a[0] - b[0]));
  const stored = (await chrome.storage.local.get('completionNotifications')).completionNotifications;
  return stored?.key === key ? stored : { key, manual: [], delivered: null, automatic: null };
}

function armManualNotification(config) {
  return withNotifications(async () => {
    const state = await notificationState(config);
    state.manual.push(COMPLETION_NOTIFICATION + crypto.randomUUID());
    await chrome.storage.local.set({ completionNotifications: state });
  });
}

function notifyCompleted(config, session, bridgeStatus) {
  if (!completedFor(config, session, bridgeStatus)) return Promise.resolve();
  return withNotifications(async () => {
    const state = await notificationState(config);
    const version = JSON.stringify([session.epoch, config.mappings.filter(item => item.enabled)
      .map(item => [item.slot, item.folderId, session.acks[item.slot]]).sort((a, b) => a[0] - b[0])]);
    if (!state.manual.length && state.delivered === version) return;
    if (!chrome.notifications?.create) return;
    if (chrome.notifications.getPermissionLevel && await chrome.notifications.getPermissionLevel() !== 'granted') return;
    if (!state.manual.length && state.automatic?.version !== version) {
      state.automatic = { version, id: COMPLETION_NOTIFICATION + crypto.randomUUID() };
      await chrome.storage.local.set({ completionNotifications: state });
    }
    do {
      // Reuse the persisted ID on retry; a restarted worker replaces the same notification.
      const id = state.manual[0] || state.automatic.id;
      await chrome.notifications.create(id, {
        type: 'basic', iconUrl: 'notification.png',
        title: '书签同步已完成',
        message: 'Chrome 和 Edge 均已完成书签同步并确认，本机同步数据目录已成功删除。'
      });
      if (state.manual.length) state.manual.shift();
      state.delivered = version;
      state.automatic = null;
      await chrome.storage.local.set({ completionNotifications: state });
    } while (state.manual.length);
  });
}

async function performSync(manual) {
  const progress = { running: true, lastSync: null, added: 0, error: '', phase: 'syncing', cleaned: false };
  const prior = (await chrome.storage.local.get('status')).status;
  progress.lastSync = prior?.lastSync || null;
  await chrome.storage.local.set({ status: progress });
  try {
    const config = await validateSettings(await settings(), false);
    if (!config.token) throw new Error('请先填写连接服务的配对密钥并保存。');
    const mappings = config.mappings.filter(item => item.enabled);
    if (!mappings.length) throw new Error('请至少配置并启用一个配对。');
    const slots = mappings.map(item => item.slot);
    const id = await clientId();
    const session = { key: sessionKey(config), epoch: null, acks: {} };
    // Discard old receipts before applying anything; an interrupted create must never reuse an old ACK.
    await chrome.storage.local.set({ syncSession: session });
    if (manual) await armManualNotification(config);
    await setPending(true);
    const failures = [];
    const writable = (await folderIndex()).nodes;
    for (const mapping of mappings) {
      try {
        if (!writable.has(mapping.folderId)) throw new Error('文件夹不存在或无法写入，请重新选择。');
        const [root] = await chrome.bookmarks.getSubTree(mapping.folderId);
        const result = await request('/v2/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
          body: JSON.stringify({ clientId: id, clientName: CLIENT_NAME, slots, slot: mapping.slot, tree: snapshot(root) })
        });
        validateTree(result.tree);
        if (typeof result.epoch !== 'string' || !result.epoch || !Number.isSafeInteger(result.revision) || result.revision < 0) {
          throw new Error('连接服务返回了无效的同步版本，请更新并重新启动服务。');
        }
        if (session.epoch !== result.epoch) {
          session.epoch = result.epoch;
          session.acks = {};
        }
        await appendMissing([mapping.folderId], result.tree, progress);
        // Only acknowledge after every real bookmark/folder creation has succeeded.
        await request('/v2/ack', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
          body: JSON.stringify({ clientId: id, slot: mapping.slot, revision: result.revision, epoch: result.epoch })
        });
        session.acks[mapping.slot] = result.revision;
        await chrome.storage.local.set({ syncSession: session });
      } catch (error) {
        if (error.invalidToken) {
          await setPending(false);
          throw error;
        }
        failures.push(`「配对 ${mapping.slot}」：${error.message}`);
      }
    }
    if (failures.length) throw new Error(failures.join('\n'));
    const bridgeStatus = await request('/v2/status').catch(() => null);
    progress.cleaned = completedFor(config, session, bridgeStatus);
    progress.phase = progress.cleaned ? 'complete' : 'waiting';
    if (progress.cleaned) await setPending(false);
    progress.lastSync = Date.now();
    await chrome.action.setBadgeText({ text: '' });
    if (progress.cleaned) await notifyCompleted(config, session, bridgeStatus);
    return { ok: true, added: progress.added, phase: progress.phase, cleaned: progress.cleaned };
  } catch (error) {
    progress.error = error.message || String(error);
    progress.phase = 'error';
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#b45309' });
    return { ok: false, error: progress.error, added: progress.added, phase: progress.phase, cleaned: false };
  } finally {
    progress.running = false;
    await chrome.storage.local.set({ status: progress });
  }
}

function syncNow(manual = false) {
  if (saving) return Promise.resolve({ ok: false, error: '正在保存设置，请稍后同步。' });
  if (!syncTask) {
    operationVersion++;
    syncTask = performSync(manual).finally(() => { syncTask = null; });
  }
  return syncTask;
}

async function getState() {
  const version = operationVersion;
  const activeAtStart = Boolean(syncTask || saving);
  const [config, index, stored, connected, bridgeStatus] = await Promise.all([
    settings(), folderIndex(), chrome.storage.local.get(['status', 'syncSession']),
    request('/health').then(value => value.ok === true && value.app === 'bookmark-bridge' && value.version === 2).catch(() => false),
    request('/v2/status').catch(() => null)
  ]);
  const status = { lastSync: null, added: 0, error: '', phase: 'waiting', cleaned: false, ...stored.status, running: Boolean(syncTask) };
  if (!activeAtStart && !syncTask && !saving && version === operationVersion && connected && bridgeStatus) {
    // Match the current epoch and every successful local ACK; peer completion alone proves nothing locally.
    status.cleaned = !status.error && completedFor(config, stored.syncSession, bridgeStatus);
    status.phase = status.error ? 'error' : status.cleaned ? 'complete' : 'waiting';
    if (status.cleaned) {
      saving = true;
      try {
        await setPending(false);
        await chrome.storage.local.set({ status });
        await notifyCompleted(config, stored.syncSession, bridgeStatus);
      } finally { saving = false; }
    }
  } else if (activeAtStart || syncTask || version !== operationVersion) {
    status.cleaned = false;
    status.phase = 'syncing';
  }
  if (!connected || !bridgeStatus) {
    status.cleaned = false;
    if (status.phase === 'complete') status.phase = 'waiting';
  }
  return { ok: true, settings: config, folders: index.folders, connected, status, bridgeStatus };
}

async function handleMessage(message) {
  if (message?.type === 'getState') return getState();
  if (message?.type === 'syncNow') return syncNow(true);
  if (message?.type === 'saveSettings') {
    if (syncTask || saving) throw new Error('当前操作尚未完成，请稍后保存。');
    saving = true;
    operationVersion++;
    try {
      const previous = await settings();
      const config = await validateSettings(message.settings);
      await chrome.storage.local.set({ settings: config });
      settingsTask = Promise.resolve(config);
      if (sessionKey(previous) !== sessionKey(config)) {
        await setPending(false);
        await chrome.storage.local.set({ syncSession: null, completionNotifications: null, status: { running: false, lastSync: null, added: 0, error: '', phase: 'waiting', cleaned: false } });
      }
      await configureAlarms(config);
      return { ok: true, settings: config };
    } finally { saving = false; }
  }
  throw new Error('未知操作。');
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  handleMessage(message).then(respond, (error) => respond({ ok: false, error: error.message }));
  return true;
});
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
chrome.notifications?.onClicked.addListener(id => {
  if (id.startsWith(COMPLETION_NOTIFICATION)) chrome.runtime.openOptionsPage();
});
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await configureAlarms(await settings());
  await chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(async () => {
  const config = await settings();
  await configureAlarms(config);
  if (config.autoSync && config.token && config.mappings.some((item) => item.enabled)) await syncNow();
});
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== PERIODIC && alarm.name !== CHANGED && alarm.name !== PENDING) return;
  const config = await settings();
  if (alarm.name === PENDING) {
    if ((await chrome.storage.local.get('pendingSync')).pendingSync) await syncNow();
  } else if (config.autoSync) await syncNow();
});
async function onBookmarkChanged() {
  if (syncTask) return;
  const config = await settings();
  if (config.autoSync && config.token && config.mappings.some((item) => item.enabled)) {
    await chrome.alarms.create(CHANGED, { delayInMinutes: 0.5 });
  }
}
chrome.bookmarks.onCreated.addListener(onBookmarkChanged);
chrome.bookmarks.onChanged.addListener(onBookmarkChanged);
chrome.bookmarks.onMoved.addListener(onBookmarkChanged);
chrome.bookmarks.onRemoved.addListener(onBookmarkChanged);
