import { idbGet, idbSet } from "./lib/idb.js";

const modeSwitch = document.getElementById("modeSwitch");
const urlGroup = document.getElementById("urlGroup");
const targetUrlInput = document.getElementById("targetUrl");
const imageDirInput = document.getElementById("imageDir");
const authorizeBtn = document.getElementById("authorizeBtn");
const runBtn = document.getElementById("runBtn");
const progressText = document.getElementById("progressText");
const progressValue = document.getElementById("progressValue");
const progressBar = document.getElementById("progressBar");
const errorText = document.getElementById("errorText");
const resultCard = document.getElementById("resultCard");
const resultFile = document.getElementById("resultFile");
const resultWords = document.getElementById("resultWords");
const resultImages = document.getElementById("resultImages");
const resultStatus = document.getElementById("resultStatus");
const vaultStatus = document.getElementById("vaultStatus");
const folderListContainer = document.getElementById("folderList");

let currentMode = "current";
let currentRunId = null;
let currentFolder = ""; // empty string implies "根目录"
const DEFAULT_FOLDERS = ["小龙虾", "微信公众号", "X", "重点文档", "GitHub 工具"];
const RUN_TIMEOUT_MS = 60000;

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function setError(message) {
  if (!message) {
    errorText.classList.add("hidden");
    errorText.textContent = "";
    return;
  }
  errorText.textContent = message;
  errorText.classList.remove("hidden");
}

function setVaultBadge(hasPermission) {
  vaultStatus.textContent = hasPermission ? "Vault 已授权" : "未授权";
  vaultStatus.classList.toggle("badge-ok", hasPermission);
  vaultStatus.classList.toggle("badge-warn", !hasPermission);
}

function setProgress(percent, text) {
  progressBar.style.width = `${Math.max(0, Math.min(percent, 100))}%`;
  progressValue.textContent = `${Math.round(percent)}%`;
  progressText.textContent = text;
}

function setRunning(running) {
  runBtn.disabled = running;
  runBtn.textContent = running ? "处理中..." : "提取并一键入库";
}

function updateMode(mode) {
  currentMode = mode;
  const buttons = modeSwitch.querySelectorAll(".seg");
  buttons.forEach((btn) => {
    const selected = btn.dataset.mode === mode;
    btn.classList.toggle("active", selected);
  });
  urlGroup.classList.toggle("hidden", mode !== "url");
}

function renderResult(result) {
  resultFile.textContent = `/${result.fileName}`;
  resultWords.textContent = `${result.wordCount}`;
  resultImages.textContent = `${result.imagesSaved} 成功 / ${result.imagesFailed} 失败`;
  resultStatus.textContent = result.imagesFailed > 0 ? "已入库（部分图片失败）" : "已入库";
  resultCard.classList.remove("hidden");
}

function withTimeout(promise, timeoutMs, message) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}
async function ensureVaultPermission(interactive) {
  const handle = await idbGet("vaultHandle");
  if (!handle) {
    throw new Error("未授权 Vault 目录，请先点击“授权 Vault 目录”");
  }
  if (typeof handle.queryPermission !== "function") {
    return true;
  }

  let state = await handle.queryPermission({ mode: "readwrite" });
  if (state === "granted") return true;
  if (state === "denied") {
    throw new Error("Vault 权限已被拒绝，请重新授权目录");
  }

  if (interactive && typeof handle.requestPermission === "function") {
    state = await handle.requestPermission({ mode: "readwrite" });
    if (state === "granted") {
      await idbSet("vaultHandle", handle);
      return true;
    }
  }

  throw new Error("Vault 目录未授权，请点击“授权 Vault 目录”");
}

async function initialize() {
  setError("");
  setProgress(0, "等待执行");
  updateMode("current");
  try {
    const bootstrap = await sendMessage({ action: "getBootstrapData" });
    imageDirInput.value = bootstrap.imageDir || "_assets/webclip-images";
    setVaultBadge(Boolean(bootstrap.hasVaultAccess));
    await loadAndPredictFolders();
  } catch (err) {
    console.error("Initialization error:", err);
  }
}

async function loadAndPredictFolders() {
  const folders = new Set(DEFAULT_FOLDERS);

  // 1. Try to read existing folders from vault
  try {
    const handle = await idbGet("vaultHandle");
    if (handle && typeof handle.queryPermission === "function") {
      const state = await handle.queryPermission({ mode: "readwrite" });
      if (state === "granted") {
        await scanFoldersDeep(handle, folders);
      } else {
        console.warn("Vault handle exists but needs re-authorization for deep scan.");
      }
    }
  } catch (err) {
    console.warn("Could not read vault folders array:", err);
  }

  // 2. Predict default folder base on active tab
  let predicted = "";
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (tab && tab.url) {
      const url = new URL(tab.url);
      const titleLower = (tab.title || "").toLowerCase();

      if (titleLower.includes("小龙虾") || titleLower.includes("openclaw")) {
        predicted = "小龙虾";
      } else if (url.hostname === "github.com") {
        predicted = "GitHub 工具";
      } else if (url.hostname === "mp.weixin.qq.com") {
        predicted = "微信公众号";
      } else if (url.hostname === "x.com" || url.hostname === "twitter.com") {
        predicted = "X";
      }
    }
  } catch (err) {
    console.warn("Prediction failed:", err);
  }

  // If predicted folder wasn't in our list (e.g. manually created edge case), add it
  if (predicted && !folders.has(predicted)) {
    folders.add(predicted);
  }

  currentFolder = predicted;
  renderFolderList(Array.from(folders));
}

function renderFolderList(folderNames) {
  folderListContainer.innerHTML = "";

  const allOptions = ["根目录", ...folderNames];

  allOptions.forEach(name => {
    const btn = document.createElement("button");
    btn.className = "seg";
    btn.textContent = name;

    // "" is internally treated as "根目录"
    const isActive = (currentFolder === "" && name === "根目录") || (currentFolder === name);
    if (isActive) btn.classList.add("active");

    btn.addEventListener("click", () => {
      // Update state
      currentFolder = name === "根目录" ? "" : name;

      // Update UI
      folderListContainer.querySelectorAll(".seg").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
    });

    folderListContainer.appendChild(btn);
  });
}

modeSwitch.addEventListener("click", (event) => {
  const target = event.target.closest(".seg");
  if (!target) return;
  updateMode(target.dataset.mode);
});

authorizeBtn.addEventListener("click", async () => {
  try {
    setError("");
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    const permission = await handle.requestPermission({ mode: "readwrite" });
    if (permission !== "granted") {
      throw new Error("没有获得目录写入权限");
    }
    await idbSet("vaultHandle", handle);
    const refreshed = await sendMessage({ action: "getBootstrapData" });
    setVaultBadge(Boolean(refreshed.hasVaultAccess));
  } catch (error) {
    setError(`授权失败：${error.message}`);
  }
});

runBtn.addEventListener("click", async () => {
  try {
    resultCard.classList.add("hidden");
    setError("");
    await ensureVaultPermission(true);
    if (currentMode === "url") {
      const url = targetUrlInput.value.trim();
      if (!url) {
        throw new Error("请输入目标 URL");
      }
      try {
        new URL(url);
      } catch {
        throw new Error("URL 格式无效");
      }
    }

    const payload = {
      mode: currentMode,
      url: targetUrlInput.value.trim(),
      imageDir: imageDirInput.value.trim(),
      explicitFolder: currentFolder
    };

    currentRunId = crypto.randomUUID();
    setRunning(true);
    setProgress(1, "准备执行");
    await sendMessage({ action: "savePrefs", payload });
    const response = await withTimeout(
      sendMessage({
        action: "runExtraction",
        runId: currentRunId,
        payload
      }),
      RUN_TIMEOUT_MS,
      "处理超时（超过210秒），请重试。若持续发生请切换到“输入URL”模式重试"
    );
    if (!response?.ok) {
      throw new Error(response?.error || "执行失败");
    }
    renderResult(response.result);
  } catch (error) {
    setError(error.message);
  } finally {
    setRunning(false);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "pipeline-progress") return;
  if (!currentRunId || message.runId !== currentRunId) return;
  setProgress(message.percent ?? 0, message.text || "处理中");
});

async function scanFoldersDeep(dirHandle, foldersSet, prefix = "", currentDepth = 0, maxDepth = 3) {
  if (currentDepth >= maxDepth) return;

  try {
    for await (const [name, entry] of dirHandle.entries()) {
      if (entry.kind === "directory" && !name.startsWith(".") && !name.startsWith("_")) {
        const fullPath = prefix ? `${prefix}/${name}` : name;
        foldersSet.add(fullPath);
        // Recursive call (also wrapped by try-catch natively in its own execution)
        await scanFoldersDeep(entry, foldersSet, fullPath, currentDepth + 1, maxDepth);
      }
    }
  } catch (error) {
    // Ignore DOMExceptions for forbidden/restricted subfolders to allow siblings to process
    console.warn(`Could not read items in ${prefix || "root"}:`, error);
  }
}

initialize().catch((error) => {
  setError(`初始化失败：${error.message}`);
});
