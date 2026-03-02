const DB_NAME = "web2obsidian-db";
const STORE_NAME = "kv";
const DB_VERSION = 1;

let dbPromise;

function getDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
    });
  }
  return dbPromise;
}

async function idbGet(key) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(key);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
  });
}

async function idbSet(key, value) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(value, key);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

const DEFAULT_IMAGE_DIR = "_assets/webclip-images";

chrome.runtime.onInstalled.addListener(async () => {
  const imageDir = await idbGet("imageDir");
  if (!imageDir) {
    await idbSet("imageDir", DEFAULT_IMAGE_DIR);
  }
  await enableSidePanelOnActionClick();
});

chrome.runtime.onStartup.addListener(async () => {
  await enableSidePanelOnActionClick();
});
void enableSidePanelOnActionClick();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message?.action) return;

  (async () => {
    if (message.action === "getBootstrapData") {
      const imageDir = (await idbGet("imageDir")) || DEFAULT_IMAGE_DIR;
      const hasVaultAccess = await hasVaultAccessPermission();
      sendResponse({
        imageDir,
        hasVaultAccess
      });
      return;
    }

    if (message.action === "savePrefs") {
      const imageDir = sanitizeRelativePath(message.payload?.imageDir || DEFAULT_IMAGE_DIR);
      await idbSet("imageDir", imageDir || DEFAULT_IMAGE_DIR);
      sendResponse({ ok: true });
      return;
    }

    if (message.action === "runExtraction") {
      try {
        const result = await runPipeline(message.runId, message.payload || {});
        sendResponse({ ok: true, result });
      } catch (error) {
        sendResponse({ ok: false, error: error.message || "未知错误" });
      }
      return;
    }

    sendResponse({ ok: false, error: "Unknown action" });
  })().catch((error) => {
    sendResponse({ ok: false, error: error.message || "执行失败" });
  });

  return true;
});

async function runPipeline(runId, payload) {
  const imageDir =
    sanitizeRelativePath(payload.imageDir || (await idbGet("imageDir")) || DEFAULT_IMAGE_DIR) ||
    DEFAULT_IMAGE_DIR;

  await idbSet("imageDir", imageDir);

  notifyProgress(runId, 5, "校验 Vault 权限");
  const vaultHandle = await requireVaultHandle();

  let targetUrl = payload.url;
  if (!targetUrl && payload.mode !== "url") {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.url) {
      targetUrl = tabs[0].url;
    }
  }

  let targetFolder = "";
  const hostname = targetUrl ? new URL(targetUrl).hostname : "";
  const isGithub = hostname === "github.com";
  const isWechat = hostname === "mp.weixin.qq.com";

  if (isGithub) {
    targetFolder = "GitHub 工具";
  } else if (isWechat) {
    targetFolder = "微信公众号";
  }

  notifyProgress(runId, 18, "提取网页正文");
  const article =
    payload.mode === "url" ? await extractFromUrl(payload.url) : await extractFromCurrentTab();

  notifyProgress(runId, 46, "本地整理正文");
  let contentMarkdown = buildLocalContentMarkdown(article);

  notifyProgress(runId, 70, "下载图片与整理文件");
  const imageReport = await downloadImages(vaultHandle, imageDir, article.images || []);
  contentMarkdown = applyImagePlaceholders(contentMarkdown, imageReport);

  notifyProgress(runId, 88, "生成 Markdown");
  const fileName = buildMarkdownFileName(article.title, article.author, article.url);
  const markdown = generateMarkdown({
    article,
    contentMarkdown,
    imageReport
  });

  notifyProgress(runId, 96, "写入 Obsidian Vault");
  let targetHandle = vaultHandle;
  if (targetFolder) {
    targetHandle = await ensureDirectory(vaultHandle, targetFolder);
  }
  await writeTextFile(targetHandle, fileName, markdown);

  notifyProgress(runId, 100, "完成");
  return {
    fileName: targetFolder ? `${targetFolder}/${fileName}` : fileName,
    wordCount: article.wordCount,
    imagesSaved: imageReport.success.length,
    imagesFailed: imageReport.failed.length
  };
}

function buildLocalContentMarkdown(article) {
  const text = String(article?.text || "");
  if (!text) return "";
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(赞|点赞|评论|转发|分享|收藏|举报|关注|在看|阅读原文)$/i.test(line))
    .join("\n\n");
}

function notifyProgress(runId, percent, text) {
  chrome.runtime.sendMessage({
    type: "pipeline-progress",
    runId,
    percent,
    text
  });
}

async function enableSidePanelOnActionClick() {
  if (!chrome.sidePanel?.setPanelBehavior) return;
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch {
    // ignore on unsupported Chrome versions
  }
}

async function hasVaultAccessPermission() {
  try {
    const handle = await idbGet("vaultHandle");
    if (!handle) return false;

    if (typeof handle.queryPermission !== "function") return true;

    const state = await handle.queryPermission({ mode: "readwrite" });
    if (state === "denied") return false;

    // Test if the handle is still accessible
    const _ = handle.name;

    return true;
  } catch (error) {
    // If there's any error, consider the permission as not available
    // and clear the invalid handle
    try {
      await idbSet("vaultHandle", null);
    } catch {
      // Ignore storage errors
    }
    return false;
  }
}

async function requireVaultHandle() {
  const handle = await idbGet("vaultHandle");
  if (!handle) {
    throw new Error("未授权 Vault 目录，请先点击授权 Vault 目录");
  }

  // Try to verify the handle is still valid
  try {
    if (typeof handle.queryPermission === "function") {
      const state = await handle.queryPermission({ mode: "readwrite" });
      if (state === "denied") {
        throw new Error("Vault 权限已被拒绝，请重新授权目录");
      }
      if (state === "prompt") {
        // Try to request permission again
        const newState = await handle.requestPermission({ mode: "readwrite" });
        if (newState !== "granted") {
          throw new Error("Vault 权限未获得，请重新授权目录");
        }
        // Update the handle in storage
        await idbSet("vaultHandle", handle);
      }
    }

    // Test if the handle is still accessible by trying to access its name
    const _ = handle.name;

  } catch (error) {
    // If the handle is invalid, clear it from storage
    await idbSet("vaultHandle", null);
    throw new Error("Vault 目录访问失效，请重新授权目录");
  }

  return handle;
}

async function extractFromCurrentTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) {
    throw new Error("未找到当前标签页");
  }
  return executeExtractionWithRetry(tab.id);
}

async function extractFromUrl(url) {
  if (!url) throw new Error("URL 不能为空");
  let tmpTab = null;
  try {
    tmpTab = await chrome.tabs.create({ url, active: false });
    await waitForTabComplete(tmpTab.id, 18000);
    await delay(1200);
    return await executeExtractionWithRetry(tmpTab.id);
  } finally {
    if (tmpTab?.id) {
      try {
        await chrome.tabs.remove(tmpTab.id);
      } catch {
        // ignore close errors
      }
    }
  }
}

async function waitForTabComplete(tabId, timeoutMs) {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("页面加载超时"));
    }, timeoutMs);

    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function executeExtractionWithRetry(tabId) {
  let lastError;
  for (let i = 0; i < 3; i += 1) {
    try {
      return await executeExtraction(tabId);
    } catch (error) {
      lastError = error;
      if (i < 2) {
        await delay(700);
      }
    }
  }
  throw lastError || new Error("正文提取失败");
}

async function executeExtraction(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractReadablePayload
  });
  const payload = results?.[0]?.result;
  if (!payload || typeof payload !== "object") {
    throw new Error("正文提取失败：脚本未返回数据，可能页面限制脚本注入，请刷新页面后重试");
  }
  if (!payload?.text || payload.text.length < 30) {
    const debug = payload?.debug || {};
    const hint = [
      debug.containerHint ? `容器=${debug.containerHint}` : "",
      Number.isFinite(debug.structuredLength) ? `结构化=${debug.structuredLength}` : "",
      Number.isFinite(debug.fallbackLength) ? `回退=${debug.fallbackLength}` : ""
    ]
      .filter(Boolean)
      .join("，");
    const suffix = hint ? `（${hint}）` : "";
    throw new Error(`正文提取失败，请在正文页面重试${suffix}`);
  }
  payload.wordCount = estimateWordCount(payload.text);
  return payload;
}

function extractReadablePayload() {
  const blockedSelectors = [
    "script",
    "style",
    "noscript",
    "footer",
    "header",
    "nav",
    "aside",
    ".comment",
    "#comment",
    ".comments",
    ".like",
    ".likes",
    ".recommend",
    ".related",
    ".share",
    ".toolbar",
    ".ad",
    ".advertisement"
  ];

  const preferredSelectors = [
    "#js_content",
    ".rich_media_content",
    ".rich_media_area_primary_inner",
    "[itemprop='articleBody']",
    "article",
    "main",
    ".article-content",
    ".entry-content",
    ".post-content",
    ".content"
  ];

  const isBlockedNode = (el) => {
    for (const selector of blockedSelectors) {
      if (el.closest(selector)) return true;
    }
    return false;
  };

  const isNoiseImageElement = (el) => {
    const signature = `${el.className || ""} ${el.id || ""} ${el.getAttribute("data-role") || ""}`.toLowerCase();
    if (/(avatar|icon|logo|emoji|qrcode|qr|thumb|like|comment|share)/.test(signature)) return true;

    const width = Number(el.getAttribute("width") || 0);
    const height = Number(el.getAttribute("height") || 0);
    if (width > 0 && height > 0 && width < 80 && height < 80) return true;
    return false;
  };

  const resolveImageUrl = (el) => {
    const srcset = (el.getAttribute("srcset") || "").split(",")[0]?.trim().split(/\s+/)[0] || "";
    const candidates = [
      el.getAttribute("data-src"),
      el.getAttribute("data-original"),
      el.getAttribute("data-actualsrc"),
      el.getAttribute("data-lazy-src"),
      el.getAttribute("src"),
      el.currentSrc,
      srcset
    ]
      .map((v) => String(v || "").trim())
      .filter(Boolean);

    for (const value of candidates) {
      const lower = value.toLowerCase();
      if (lower.startsWith("data:")) continue;
      if (lower.startsWith("blob:")) continue;
      if (lower === "about:blank") continue;
      return value;
    }
    return "";
  };

  const doc = document;
  let best = null;
  let containerHint = "body";
  for (const selector of preferredSelectors) {
    const node = doc.querySelector(selector);
    if (!node) continue;
    const length = (node.innerText || node.textContent || "").trim().length;
    if (length >= 80) {
      best = node;
      containerHint = selector;
      break;
    }
  }

  const candidates = Array.from(doc.querySelectorAll("article, main, section, div"));
  let bestScore = 0;
  if (!best) {
    for (const node of candidates) {
      const text = node.textContent?.trim() || "";
      if (text.length < 120) continue;
      const pCount = node.querySelectorAll("p").length;
      const score = text.length + pCount * 80;
      if (score > bestScore) {
        best = node;
        bestScore = score;
      }
    }
  }

  const container = best || doc.body;
  if (best && containerHint === "body") {
    containerHint = String(best.tagName || "node").toLowerCase();
  }
  const lines = [];
  const images = [];
  let imageIndex = 1;
  const blocks = container.querySelectorAll("h1,h2,h3,h4,p,li,blockquote,pre,figcaption,img");
  blocks.forEach((el) => {
    if (isBlockedNode(el)) return;
    const tag = String(el.tagName || "").toLowerCase();
    if (tag === "img") {
      if (isNoiseImageElement(el)) return;
      const src = resolveImageUrl(el);
      if (!src) return;
      try {
        const absolute = new URL(src, location.href).href;
        if (absolute.startsWith("data:")) return;
        const token = `[[IMG_${String(imageIndex).padStart(3, "0")}]]`;
        const alt = (el.getAttribute("alt") || "").trim();
        images.push({ token, url: absolute, alt });
        lines.push(token);
        imageIndex += 1;
      } catch {
        // ignore broken image url
      }
      return;
    }

    const text = el.textContent?.replace(/\s+/g, " ").trim();
    if (!text || text.length < 2) return;
    lines.push(text);
  });

  const structuredText = lines.join("\n\n").trim();
  const fallbackText = ((container.innerText || doc.body?.innerText || doc.documentElement?.innerText || "") + "")
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length >= 2)
    .filter((line) => !/^(赞|点赞|评论|转发|分享|收藏|举报|关注|在看|阅读原文)$/i.test(line))
    .join("\n\n");
  const finalText = images.length > 0
    ? structuredText || fallbackText
    : fallbackText.length > structuredText.length + 40
      ? fallbackText
      : structuredText || fallbackText;

  const title =
    doc.querySelector("meta[property='og:title']")?.getAttribute("content")?.trim() ||
    document.title ||
    "untitled";
  const inlineAuthor =
    doc.querySelector("#js_author_name")?.textContent?.trim() ||
    doc.querySelector("#js_name")?.textContent?.trim() ||
    doc.querySelector(".rich_media_meta_nickname")?.textContent?.trim() ||
    Array.from(doc.querySelectorAll(".rich_media_meta_text"))
      .map((node) => node.textContent?.trim() || "")
      .find((text) => {
        if (!text || text.length > 24) return false;
        if (/\d{4}年|\d{1,2}:\d{2}|原创|美国|中国|北京|上海/.test(text)) return false;
        return true;
      }) ||
    "";
  const author =
    doc.querySelector("meta[name='author']")?.getAttribute("content")?.trim() ||
    doc.querySelector("meta[property='article:author']")?.getAttribute("content")?.trim() ||
    inlineAuthor ||
    "unknown";
  const publishedAt =
    doc.querySelector("meta[property='article:published_time']")?.getAttribute("content")?.trim() ||
    doc.querySelector("time[datetime]")?.getAttribute("datetime")?.trim() ||
    "unknown";
  const siteName =
    doc.querySelector("meta[property='og:site_name']")?.getAttribute("content")?.trim() ||
    location.hostname;

  return {
    url: location.href,
    title,
    author,
    publishedAt,
    siteName,
    text: finalText,
    images,
    debug: {
      containerHint,
      structuredLength: structuredText.length,
      fallbackLength: fallbackText.length,
      imageCount: images.length
    }
  };
}

function estimateWordCount(text) {
  const normalized = String(text || "").replace(/\[\[IMG_\d{3}\]\]/g, " ");
  const cjkCount = (normalized.match(/[\u4e00-\u9fff]/g) || []).length;
  const latinWords = (normalized.match(/[A-Za-z0-9_]+/g) || []).length;
  return cjkCount + latinWords;
}

function guessExtension(url, headerContentType, blobContentType) {
  const contentType = (headerContentType || blobContentType || "").toLowerCase();
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("gif")) return "gif";
  if (contentType.includes("bmp")) return "bmp";
  if (contentType.includes("svg")) return "svg";
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";

  const byUrl = url.match(/\.([a-zA-Z0-9]{2,5})(?:$|\?)/);
  if (byUrl) {
    const ext = byUrl[1].toLowerCase();
    if (["jpg", "jpeg", "png", "webp", "gif", "bmp", "svg"].includes(ext)) {
      return ext === "jpeg" ? "jpg" : ext;
    }
  }
  return "jpg";
}

async function ensureDirectory(rootHandle, relativePath) {
  const safePath = sanitizeRelativePath(relativePath);
  if (!safePath) return rootHandle;
  const parts = safePath.split("/").filter(Boolean);
  let current = rootHandle;
  for (const part of parts) {
    current = await current.getDirectoryHandle(part, { create: true });
  }
  return current;
}

async function writeTextFile(rootHandle, fileName, content) {
  const fileHandle = await rootHandle.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

async function writeBlobFile(dirHandle, fileName, blob) {
  const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}

function generateMarkdown({ article, contentMarkdown, imageReport }) {
  const extractedAt = new Date().toISOString();
  const lines = [
    "---",
    `title: ${yamlQuote(article.title)}`,
    `source_url: ${yamlQuote(article.url)}`,
    `author: ${yamlQuote(article.author || "unknown")}`,
    `published_at: ${yamlQuote(article.publishedAt || "unknown")}`,
    `extracted_at: ${yamlQuote(extractedAt)}`,
    `word_count: ${article.wordCount}`,
    `site_name: ${yamlQuote(article.siteName || "unknown")}`,
    "---",
    "",
    "## 正文",
    contentMarkdown?.trim() || "无",
    ""
  ];

  if (imageReport.failed.length > 0) {
    lines.push("## 图片下载失败列表");
    for (const item of imageReport.failed) {
      lines.push(`- ${item.sourceUrl}`);
    }
    lines.push("");
  }

  lines.push("## 来源");
  lines.push(`- 原文链接：${article.url}`);
  lines.push("");

  return lines.join("\n");
}

function yamlQuote(value) {
  const text = String(value ?? "").replace(/\r?\n/g, " ").trim();
  return `'${text.replace(/'/g, "''")}'`;
}

function buildMarkdownFileName(title, author, url) {
  const datePrefix = formatDateYYMMDD(new Date());

  // Check if it's a GitHub URL
  if (url && url.includes('github.com')) {
    try {
      const urlObj = new URL(url);
      const pathParts = urlObj.pathname.split('/').filter(Boolean);

      // For GitHub URLs like github.com/owner/repo or github.com/owner/repo/...
      if (pathParts.length >= 2) {
        const owner = pathParts[0];
        const repo = pathParts[1];
        const projectName = `${owner}-${repo}`;
        const safeProjectName = slugify(projectName).slice(0, 60) || "github-project";
        return sanitizeFileName(`${datePrefix}-${safeProjectName}.md`);
      }
    } catch (error) {
      // If URL parsing fails, fall back to default naming
    }
  }

  // Default naming for non-GitHub URLs
  const safeAuthor = slugify(author || "unknown").slice(0, 20) || "unknown";
  const safeTitle = slugify(title || "untitled").slice(0, 80) || "untitled";
  return sanitizeFileName(`${datePrefix}-${safeAuthor}-${safeTitle}.md`);
}

function formatDateCompact(date, withMsTail) {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  if (withMsTail) {
    const ms = String(date.getMilliseconds()).padStart(3, "0");
    return `${yyyy}${mm}${dd}-${hh}${mi}${ss}${ms}`;
  }
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

function formatDateYYMMDD(date) {
  const yy = String(date.getFullYear()).slice(-2);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

function sanitizeRelativePath(value) {
  const raw = String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (!raw) return "";
  const parts = raw.split("/").filter(Boolean);
  const safeParts = parts
    .map((part) => part.replace(/[<>:"|?*\x00-\x1F]/g, "").trim())
    .filter((part) => part && part !== "." && part !== "..");
  return safeParts.join("/");
}

function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9\u4e00-\u9fff-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function sanitizeFileName(name) {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadImages(vaultHandle, imageDir, images) {
  const report = { success: [], failed: [] };

  if (!images || images.length === 0) {
    return report;
  }

  try {
    const imagesDirHandle = await ensureDirectory(vaultHandle, imageDir);

    for (const image of images) {
      try {
        const response = await fetch(image.url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const blob = await response.blob();
        const contentType = response.headers.get('content-type') || blob.type;
        const extension = guessExtension(image.url, contentType, blob.type);

        // Generate unique filename with better collision avoidance
        const timestamp = formatDateCompact(new Date(), true);
        const randomSuffix = Math.random().toString(36).substring(2, 8);
        const fileName = `img-${timestamp}-${randomSuffix}.${extension}`;

        await writeBlobFile(imagesDirHandle, fileName, blob);

        report.success.push({
          token: image.token,
          sourceUrl: image.url,
          fileName: fileName,
          relativePath: `${imageDir}/${fileName}`,
          alt: image.alt || ''
        });
      } catch (error) {
        report.failed.push({
          token: image.token,
          sourceUrl: image.url,
          error: error.message
        });
      }
    }
  } catch (error) {
    // If we can't create the images directory, mark all images as failed
    for (const image of images) {
      report.failed.push({
        token: image.token,
        sourceUrl: image.url,
        error: `目录创建失败: ${error.message}`
      });
    }
  }

  return report;
}

function applyImagePlaceholders(contentMarkdown, imageReport) {
  let result = contentMarkdown;

  // Replace successful images with markdown image syntax
  for (const image of imageReport.success) {
    const markdownImage = `![${image.alt}](${image.relativePath})`;
    result = result.replace(image.token, markdownImage);
  }

  // Replace failed images with placeholder text
  for (const image of imageReport.failed) {
    const placeholder = `[图片加载失败: ${image.sourceUrl}]`;
    result = result.replace(image.token, placeholder);
  }

  return result;
}