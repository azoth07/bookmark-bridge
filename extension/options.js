const $ = (id) => document.getElementById(id);
const form = $("settingsForm");
const fields = $("settingsFields");
const tokenInput = $("token");
const autoSyncInput = $("autoSync");
const mappingsContainer = $("mappings");
const addButton = $("addMapping");
const saveButton = $("saveSettings");
const syncButton = $("syncNow");
const refreshButton = $("refreshFolders");
const revealButton = $("revealToken");

let initialized = false;
let dirty = false;
let action = null;
let actionPhase = "";
let remoteRunning = false;
let stateRequest = null;
let folders = [];
let rows = [];
let nextRowNumber = 0;
let pendingFeedback = false;
let actionEpoch = 0;
let settingsSnapshot = "";

function errorText(error) {
  return error instanceof Error ? error.message : String(error || "发生未知错误，请重试。");
}

async function send(message) {
  if (!globalThis.chrome?.runtime?.sendMessage) {
    throw new Error("请从浏览器扩展的设置页面打开书签桥。");
  }
  let response;
  try {
    response = await chrome.runtime.sendMessage(message);
  } catch {
    throw new Error("无法联系扩展后台。请重新打开设置页；如果刚更新了扩展，请先重新加载扩展。");
  }
  if (!response?.ok) {
    throw new Error(response?.error || "扩展后台未返回有效结果，请稍后重试。");
  }
  return response;
}

function showNotice(element, text, kind = "") {
  element.textContent = text;
  element.className = `notice${kind ? ` ${kind}` : ""}`;
  element.hidden = !text;
}

function feedback(text, kind = "") {
  showNotice($("feedback"), text, kind);
}

function updateControls() {
  fields.disabled = !initialized || action !== null;
  saveButton.disabled = !initialized || action !== null || remoteRunning;
  syncButton.disabled = !initialized || action !== null || remoteRunning;
  refreshButton.disabled = action !== null || stateRequest !== null;
  addButton.disabled = rows.length >= 50;
  saveButton.textContent = action === "save" ? "正在保存…" : "保存设置";
  syncButton.textContent = action === "sync"
    ? (actionPhase === "saving" ? "正在保存…" : "正在同步…")
    : (remoteRunning ? "同步进行中…" : "立即同步");
  refreshButton.textContent = stateRequest !== null ? "正在读取…" : "刷新文件夹";
  form.setAttribute("aria-busy", String(action !== null));
  $("dirtyIndicator").textContent = !initialized
    ? "等待读取设置"
    : dirty ? "有尚未保存的修改" : "当前设置已保存";
  $("dirtyIndicator").dataset.dirty = String(dirty);
  renderDraftStatus();
}

function renderDraftStatus() {
  $("serviceStatusTitle").textContent = dirty ? "已保存配置的服务进度（不含当前修改）" : "双方同步进度";
  if (!dirty) return;
  $("syncStatus").textContent = "当前修改尚未同步";
  $("syncStatusNote").textContent = "请保存并同步；下方进度、应用时间与新增数量属于已保存配置";
}

function markDirty(event) {
  if (!initialized || action !== null) return;
  if (event?.target instanceof HTMLElement) event.target.removeAttribute("aria-invalid");
  dirty = true;
  pendingFeedback = false;
  feedback("");
  updateControls();
}

function populateFolders(select, selectedId) {
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = folders.length ? "请选择本地书签文件夹" : "没有可用文件夹，请刷新";
  select.replaceChildren(placeholder);
  let found = false;
  for (const folder of folders) {
    const option = document.createElement("option");
    option.value = folder.id;
    option.textContent = folder.path;
    select.append(option);
    if (folder.id === selectedId) found = true;
  }
  if (selectedId && !found) {
    const missing = document.createElement("option");
    missing.value = selectedId;
    missing.textContent = "原文件夹已不可用，请重新选择";
    select.append(missing);
  }
  select.value = selectedId || "";
}

function labeledField(labelText, control) {
  const wrapper = document.createElement("div");
  const label = document.createElement("label");
  label.className = "field-label";
  label.htmlFor = control.id;
  label.textContent = labelText;
  wrapper.append(label, control);
  return wrapper;
}

function updateEmptyState() {
  $("emptyMappings").hidden = rows.length !== 0;
}

function nextSlot() {
  const used = new Set(rows.map((row) => row.slot));
  for (let slot = 1; slot <= 50; slot += 1) {
    if (!used.has(slot)) return slot;
  }
  return null;
}

function appendMapping(mapping = {}) {
  const slot = mapping.slot ?? nextSlot();
  if (slot === null) return null;
  const rowNumber = ++nextRowNumber;
  const element = document.createElement("div");
  element.className = "mapping";
  element.setAttribute("role", "group");
  element.setAttribute("aria-label", `配对 ${slot}`);

  const pair = document.createElement("div");
  pair.className = "mapping-pair";
  const badge = document.createElement("strong");
  badge.className = "pair-badge";
  badge.textContent = `配对 ${slot}`;
  const instruction = document.createElement("span");
  instruction.id = `mapping-help-${rowNumber}`;
  instruction.className = "help";
  instruction.textContent = `另一浏览器也选择配对 ${slot}`;
  pair.append(badge, instruction);

  const folder = document.createElement("select");
  folder.id = `mapping-folder-${rowNumber}`;
  folder.required = true;
  folder.setAttribute("aria-describedby", instruction.id);
  populateFolders(folder, mapping.folderId || "");

  const enabledLabel = document.createElement("label");
  enabledLabel.className = "mapping-enabled";
  const enabled = document.createElement("input");
  enabled.type = "checkbox";
  enabled.checked = mapping.enabled !== false;
  const enabledText = document.createElement("span");
  enabledText.textContent = "启用";
  enabledLabel.append(enabled, enabledText);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "button remove";
  remove.textContent = "移除";
  remove.setAttribute("aria-label", `移除配对 ${slot}`);
  const row = { id: mapping.id || crypto.randomUUID(), slot, element, folder, enabled };
  remove.addEventListener("click", () => {
    if (action !== null) return;
    const index = rows.indexOf(row);
    rows.splice(index, 1);
    element.remove();
    updateEmptyState();
    markDirty();
    (rows[index]?.folder || rows[index - 1]?.folder || addButton).focus();
  });
  element.append(pair, labeledField("当前浏览器的文件夹", folder), enabledLabel, remove);
  rows.push(row);
  mappingsContainer.append(element);
  updateEmptyState();
  return row;
}

function initializeSettings(settings, suggestFirstPair = false) {
  settingsSnapshot = JSON.stringify(settings);
  tokenInput.value = settings.token || "";
  autoSyncInput.checked = settings.autoSync === true;
  mappingsContainer.replaceChildren();
  rows = [];
  for (const mapping of settings.mappings || []) appendMapping(mapping);
  const suggested = suggestFirstPair && rows.length === 0;
  if (suggested) appendMapping();
  updateEmptyState();
  initialized = true;
  dirty = suggested;
}

function renderServiceStatus(bridge) {
  const progress = $("pairProgress");
  progress.replaceChildren();
  if (!bridge) {
    $("serviceSummary").textContent = "服务进度暂不可用，请确认本机服务正在运行。";
    $("cleanupStatus").textContent = "尚无法确认磁盘清理状态。双方应用所有配对后，服务才会删除整个临时数据目录。";
    return;
  }
  const phaseLabels = { waiting: "等待双方配对", syncing: "等待双方应用", complete: "双方已完成", error: "服务需要处理错误" };
  const slots = (bridge.slots || []).filter((item) => Number.isInteger(item.slot) && item.slot >= 1 && item.slot <= 50)
    .sort((a, b) => a.slot - b.slot);
  const clientLabels = ["Chrome", "Edge"].map((name) => {
    const declared = new Set((bridge.clients || []).filter((client) => client.name === name)
      .flatMap((client) => client.slots || []).filter((slot) => Number.isInteger(slot) && slot >= 1 && slot <= 50));
    return declared.size ? `${name}：${[...declared].sort((a, b) => a - b).map((slot) => `配对 ${slot}`).join("、")}` : `${name}：尚未参与`;
  });
  $("serviceSummary").textContent = `${phaseLabels[bridge.phase] || "等待服务状态"} · ${slots.length} 个配对。${clientLabels.join("；")}。`;
  $("cleanupStatus").textContent = bridge.cleaned === true
    ? "整个磁盘数据目录已删除（含令牌）。当前服务在内存中保留合并内容和有效令牌，可继续同步；重启后需用新令牌重新配对。"
    : "整个磁盘数据目录尚未删除。需 Chrome 和 Edge 启用相同的配对编号，并确认应用每个配对的最新内容。";
  for (const item of slots) {
    const entry = document.createElement("li");
    const acknowledged = ["Chrome", "Edge"].filter((name) => item.acknowledged?.includes(name));
    const bookmarkCount = Number.isInteger(item.bookmarkCount) && item.bookmarkCount >= 0 ? item.bookmarkCount : 0;
    const folderCount = Number.isInteger(item.folderCount) && item.folderCount >= 0 ? item.folderCount : 0;
    entry.textContent = `配对 ${item.slot} · ${bookmarkCount} 个书签、${folderCount} 个子文件夹 · ${acknowledged.length ? `${acknowledged.join("、")} 已确认` : "等待应用确认"}`;
    progress.append(entry);
  }
}

function renderStatus(state) {
  const status = state.status || {};
  remoteRunning = status.running === true;
  $("connection").dataset.state = state.connected ? "online" : "offline";
  $("connectionText").textContent = state.connected ? "本机服务已连接" : "本机服务未连接";
  $("connection").title = state.connected
    ? "本机书签桥服务可访问；同步时会校验服务令牌。"
    : "请启动本机书签桥服务，并确认服务地址为 127.0.0.1:38473。";
  const complete = state.connected && status.phase === "complete" && status.cleaned === true;
  const waiting = status.phase === "syncing" || status.phase === "waiting";
  $("syncStatus").textContent = remoteRunning ? "本机正在同步"
    : status.error ? "同步未完成"
    : !state.connected ? "等待服务启动"
    : complete ? "双方完成 · 已清理"
    : waiting && status.lastSync ? "本机已应用 · 等待双方"
    : "等待配对同步";
  $("syncStatusNote").textContent = complete ? "整个磁盘数据目录已删除；内存仍保留合并内容"
    : remoteRunning ? "正在本机应用合并内容，随后确认进度"
    : "以双方确认所有配对为准；仅本机应用不代表完成";
  renderServiceStatus(state.connected ? state.bridgeStatus : null);
  if (pendingFeedback && complete && !dirty) {
    pendingFeedback = false;
    feedback("双方已应用全部配对，整个磁盘数据目录（含令牌）已删除。当前服务在内存中保留合并内容和有效令牌，可继续同步；重启后需在两边填写新令牌。", "success");
  }
  const timestamp = status.lastSync ? new Date(status.lastSync) : null;
  $("lastSync").textContent = timestamp && !Number.isNaN(timestamp.getTime())
    ? timestamp.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    : "尚未同步";
  $("lastSync").title = timestamp && !Number.isNaN(timestamp.getTime()) ? timestamp.toLocaleString("zh-CN") : "尚无成功同步记录";
  $("addedCount").textContent = Number.isFinite(status.added) ? String(status.added) : "—";
  showNotice($("syncError"), status.error ? `最近一次同步未完成：${status.error}` : "", "error");
  renderDraftStatus();
}

async function readState() {
  if (stateRequest !== null) return stateRequest;
  const requestEpoch = actionEpoch;
  stateRequest = (async () => {
    const state = await send({ type: "getState" });
    // A request started before saving must never restore its older configuration.
    if (requestEpoch !== actionEpoch || action !== null) return state;
    if (!state.settings || !Array.isArray(state.folders)) {
      throw new Error("扩展返回的设置不完整，请重新加载扩展后再试。");
    }
    folders = state.folders;
    if (!initialized) {
      initializeSettings(state.settings, true);
    } else if (!dirty && JSON.stringify(state.settings) !== settingsSnapshot) {
      initializeSettings(state.settings);
    } else {
      // Keep unsaved drafts, including the suggested first pair, across polling.
      for (const row of rows) populateFolders(row.folder, row.folder.value);
    }
    renderStatus(state);
    showNotice($("loadError"), "", "error");
    return state;
  })();
  updateControls();
  try {
    return await stateRequest;
  } catch (error) {
    if (requestEpoch !== actionEpoch || action !== null) throw error;
    $("connection").dataset.state = "offline";
    $("connectionText").textContent = "状态暂不可用";
    $("connection").title = "无法读取扩展状态，请点击“刷新文件夹”重试。";
    $("syncStatus").textContent = "状态暂不可用";
    $("syncStatusNote").textContent = "尚无法确认双方进度，请刷新重试";
    renderServiceStatus(null);
    showNotice($("loadError"), `${errorText(error)} 点击“刷新文件夹”可重新读取。当前未保存的修改会保留。`, "error");
    throw error;
  } finally {
    stateRequest = null;
    updateControls();
  }
}

function invalid(control, message) {
  control.setAttribute("aria-invalid", "true");
  control.focus();
  throw new Error(message);
}

function collectSettings(forSync) {
  const token = tokenInput.value.trim();
  if (!/^[a-f\d]{64}$/i.test(token)) {
    invalid(tokenInput, "请粘贴完整的服务令牌：64 位十六进制字符，可从本机服务窗口复制。");
  }
  const mappings = rows.map((row) => {
    const folderId = row.folder.value;
    if (!folderId) invalid(row.folder, `请为配对 ${row.slot} 选择本地文件夹。`);
    if (row.enabled.checked) {
      if (!folders.some((folder) => folder.id === folderId)) {
        invalid(row.folder, `配对 ${row.slot} 的文件夹已不可用，请重新选择，或暂时取消启用。`);
      }
    }
    return { id: row.id, slot: row.slot, folderId, enabled: row.enabled.checked };
  });
  if (forSync && !mappings.some((mapping) => mapping.enabled)) {
    (rows[0]?.enabled || addButton).focus();
    throw new Error("请先添加并启用至少一个文件夹配对，再开始同步。");
  }
  return { schemaVersion: 2, token, autoSync: autoSyncInput.checked, mappings };
}

async function performAction(kind) {
  if (!initialized || action !== null || remoteRunning) return;
  let settings;
  try {
    settings = collectSettings(kind === "sync");
  } catch (error) {
    feedback(errorText(error), "error");
    return;
  }
  action = kind;
  actionEpoch += 1;
  actionPhase = "saving";
  pendingFeedback = false;
  feedback(kind === "sync" ? "正在保存设置，随后开始同步…" : "正在保存设置…");
  updateControls();
  let saved = false;
  try {
    const result = await send({ type: "saveSettings", settings });
    if (result.settings?.schemaVersion !== 2 || !Array.isArray(result.settings.mappings)) {
      throw new Error("后台未返回已保存的配对设置，请重新加载扩展后再试。");
    }
    saved = true;
    initializeSettings(result.settings);
    if (kind === "sync") {
      actionPhase = "syncing";
      updateControls();
      feedback("正在与本机书签桥同步，请保持浏览器和服务运行…");
      const result = await send({ type: "syncNow" });
      const added = Number.isFinite(result.added) ? result.added : 0;
      const complete = result.phase === "complete" && result.cleaned === true;
      pendingFeedback = !complete;
      feedback(complete
        ? `双方已应用全部配对，整个临时数据目录（含磁盘令牌）已删除。本机本次新增 ${added} 个项目。当前服务仍可继续同步。`
        : `当前浏览器已应用，本次新增 ${added} 个项目。仍在等待双方确认所有配对，数据目录尚未删除。请在另一浏览器的相同配对下选择文件夹并同步；本机会每分钟继续检查。`, complete ? "success" : "");
    } else {
      feedback("设置已保存。请在另一浏览器使用相同令牌，并在相同配对编号下选择文件夹。", "success");
    }
  } catch (error) {
    feedback(`${saved ? "设置已保存，但同步失败：" : "保存失败："}${errorText(error)}`, "error");
  } finally {
    action = null;
    actionPhase = "";
    updateControls();
    if (stateRequest !== null) await stateRequest.catch(() => {});
    await readState().catch(() => {});
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void performAction("save");
});
form.addEventListener("input", markDirty);
form.addEventListener("change", markDirty);
syncButton.addEventListener("click", () => { void performAction("sync"); });
addButton.addEventListener("click", () => {
  if (!initialized || action !== null) return;
  const row = appendMapping();
  if (!row) return;
  markDirty();
  row.folder.focus();
});
revealButton.addEventListener("click", () => {
  const visible = tokenInput.type === "password";
  tokenInput.type = visible ? "text" : "password";
  revealButton.textContent = visible ? "隐藏令牌" : "显示令牌";
  revealButton.setAttribute("aria-pressed", String(visible));
});
refreshButton.addEventListener("click", async () => {
  if (action !== null || stateRequest !== null) return;
  try {
    await readState();
    feedback(`文件夹列表已刷新，共 ${folders.length} 个可选文件夹。${dirty ? "未保存的修改已保留。" : ""}`, "success");
  } catch {
    // readState presents the error while preserving all editable fields.
  }
});
window.addEventListener("beforeunload", (event) => {
  if (!dirty) return;
  event.preventDefault();
  event.returnValue = "";
});

// Polling reconciles saved settings across tabs while preserving local drafts.
void readState().catch(() => {});
const pollTimer = window.setInterval(() => {
  if (!document.hidden && action === null) void readState().catch(() => {});
}, 10000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && action === null) void readState().catch(() => {});
});
window.addEventListener("pagehide", () => window.clearInterval(pollTimer), { once: true });
