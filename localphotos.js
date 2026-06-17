"use strict";

(function () {
  if (!isMotherDayNewTabPage()) return;

  const FOLDER_SOURCE_MODE = "folder";
  const DB_NAME = "MotherDayLocalPhotos";
  const DB_VERSION = 1;
  const HANDLE_STORE_NAME = "handles";
  const ACTIVE_DIRECTORY_HANDLE_KEY = "activeDirectory";
  const SOURCE_STORAGE_KEYS = ["photoReferencePath", "localPhotoSourceMode", "localPhotoSourceSummary"];
  const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"]);
  const IMAGE_EXT_PATTERN = /\.(avif|gif|jpe?g|png|webp)$/i;
  const LOG_PREFIX = "[MotherDayLocalPhotos]";
  const LOGGED_FILE_PATH_LIMIT = 25;

  const state = {
    sources: [],
    mode: FOLDER_SOURCE_MODE,
    referencePath: "",
  };

  const els = {};

  function $(id) {
    return document.getElementById(id);
  }

  function fileLabel(file) {
    return file.webkitRelativePath || file.relativePath || file.name;
  }

  function sourceLabel(source) {
    if (source instanceof File) return fileLabel(source);
    return source?.path || source?.relativePath || source?.name || source?.handle?.name || "";
  }

  function sourceLabelForLog(fallback = "") {
    return state.referencePath || fallback || "(no folder selected)";
  }

  function logDirectoryHandleName(context, name) {
    console.log(`${LOG_PREFIX} ${context} folder handle name:`, name || "(unknown)");
  }

  function logResolvedSourcePaths(context, sources) {
    const paths = sources.map(sourceLabel).filter(Boolean);
    const visiblePaths = paths.slice(0, LOGGED_FILE_PATH_LIMIT);

    for (const path of visiblePaths) {
      console.log(`${LOG_PREFIX} ${context} relative file path:`, path);
    }

    if (paths.length > visiblePaths.length) {
      console.log(
        `${LOG_PREFIX} ${context}: ${paths.length - visiblePaths.length} more file path(s) not logged.`,
        { sourceLabel: sourceLabelForLog(), totalFiles: paths.length },
      );
    }
  }

  function isImageFile(file) {
    if (!file) return false;
    if (IMAGE_TYPES.has(file.type)) return true;
    return IMAGE_EXT_PATTERN.test(file.name || "");
  }

  function isImageName(name) {
    return IMAGE_EXT_PATTERN.test(name || "");
  }

  function sortSources(sources) {
    return [...sources].sort((a, b) => sourceLabel(a).localeCompare(sourceLabel(b), undefined, {
      numeric: true,
      sensitivity: "base",
    }));
  }

  function uniqueImageFiles(files) {
    const seen = new Set();
    const images = [];

    for (const file of sortSources(files)) {
      if (!isImageFile(file)) continue;
      const key = `${fileLabel(file)}:${file.size}:${file.lastModified}`;
      if (seen.has(key)) continue;
      seen.add(key);
      images.push(file);
    }

    return images;
  }

  function commonRootPath(sources) {
    const roots = sources
      .map(sourceLabel)
      .filter(Boolean)
      .map((path) => path.split("/")[0])
      .filter(Boolean);
    const uniqueRoots = Array.from(new Set(roots));
    return uniqueRoots.length === 1 ? uniqueRoots[0] : "";
  }

  function supportsDirectoryHandles() {
    return typeof window.showDirectoryPicker === "function" && "indexedDB" in window;
  }

  function normalizeReferencePath(path) {
    return String(path || "").replace(/[\r\n]+/g, " ").trim();
  }

  function updateSourceUI() {
    if (els.folderButton) {
      els.folderButton.classList.add("active");
      els.folderButton.setAttribute("aria-pressed", "true");
    }
    if (els.pathInput && els.pathInput.value !== state.referencePath) {
      els.pathInput.value = state.referencePath;
    }
  }

  function summaryForSources(sources, sourceLabelText) {
    return {
      count: sources.length,
      mode: state.mode,
      sourceLabel: sourceLabelText || "",
      updatedAt: Date.now(),
      sampleNames: sources.slice(0, 8).map(sourceLabel),
    };
  }

  function saveSummary(sourceLabel) {
    const summary = summaryForSources(state.sources, sourceLabel);
    console.log(`${LOG_PREFIX} saving source summary:`, {
      mode: state.mode,
      rootLabel: state.referencePath,
      summaryLabel: summary.sourceLabel,
      fileCount: summary.count,
      sampleNames: summary.sampleNames,
    });
    chrome.storage.local.set({
      photoReferencePath: state.referencePath,
      localPhotoSourceMode: state.mode,
      localPhotoSourceSummary: summary,
    });
  }

  function renderSavedSummary() {
    updateSourceUI();
  }

  function renderList() {
    updateSourceUI();
  }

  function sendSourcesToPhotoPlane() {
    if (window.MotherDayPhotoPlane?.setSources) {
      window.MotherDayPhotoPlane.setSources(state.sources);
    } else if (window.MotherDayPhotoPlane?.setFiles) {
      window.MotherDayPhotoPlane.setFiles(state.sources.filter((source) => source instanceof File));
    } else {
      window.MotherDayPendingPhotoSources = state.sources;
    }
  }

  function applySources(sources, sourceLabelText, referencePath = "") {
    if (!sources.length) {
      return false;
    }

    state.mode = FOLDER_SOURCE_MODE;
    state.sources = sources;
    const detectedPath = referencePath || commonRootPath(sources) || sourceLabelText;
    if (detectedPath) {
      state.referencePath = normalizeReferencePath(detectedPath);
    }

    sendSourcesToPhotoPlane();
    console.log(`${LOG_PREFIX} applied ${state.mode} source:`, {
      sourceLabel: sourceLabelForLog(sourceLabelText),
      fileCount: sources.length,
    });
    logResolvedSourcePaths("applied source", sources);
    saveSummary(sourceLabelText || state.referencePath);
    renderList();
    return true;
  }

  function applyFiles(files, sourceLabelText, referencePath = "") {
    return applySources(uniqueImageFiles(files), sourceLabelText, referencePath);
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) {
        reject(new Error("IndexedDB is not available."));
        return;
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(HANDLE_STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Unable to open local photo storage."));
    });
  }

  async function withHandleStore(mode, callback) {
    const db = await openDatabase();

    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction(HANDLE_STORE_NAME, mode);
        const store = transaction.objectStore(HANDLE_STORE_NAME);
        let callbackResult;

        transaction.oncomplete = () => resolve(callbackResult);
        transaction.onerror = () => reject(transaction.error || new Error("Unable to update local photo storage."));
        transaction.onabort = () => reject(transaction.error || new Error("Local photo storage update was cancelled."));

        callbackResult = callback(store);
      });
    } finally {
      db.close();
    }
  }

  function getStoredDirectoryHandle() {
    return withHandleStore("readonly", (store) => new Promise((resolve, reject) => {
      const request = store.get(ACTIVE_DIRECTORY_HANDLE_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("Unable to read the saved folder access."));
    }));
  }

  function storeDirectoryHandle(handle) {
    if (!handle) return Promise.resolve();
    console.log(`${LOG_PREFIX} storing folder access handle, not photo copies:`, handle.name);
    return withHandleStore("readwrite", (store) => {
      store.put(handle, ACTIVE_DIRECTORY_HANDLE_KEY);
    }).catch((err) => {
      console.error(`${LOG_PREFIX} unable to store directory handle for folder name:`, handle.name, err);
    });
  }

  function deleteStoredDirectoryHandle() {
    if (!("indexedDB" in window)) return;
    withHandleStore("readwrite", (store) => {
      store.delete(ACTIVE_DIRECTORY_HANDLE_KEY);
    }).catch(() => {});
  }

  async function ensureDirectoryPermission(handle, requestAccess = false) {
    const options = { mode: "read" };
    const currentPermission = await handle.queryPermission(options);
    console.log(`${LOG_PREFIX} folder permission for handle name:`, handle.name, currentPermission);
    if (currentPermission === "granted") return true;
    if (!requestAccess) return false;

    const requestedPermission = await handle.requestPermission(options);
    console.log(`${LOG_PREFIX} requested folder permission for handle name:`, handle.name, requestedPermission);
    return requestedPermission === "granted";
  }

  async function sourcesFromDirectoryHandle(handle, basePath = handle.name) {
    const sources = [];

    for await (const [name, child] of handle.entries()) {
      const nextPath = `${basePath}/${name}`;
      if (child.kind === "file") {
        if (isImageName(name)) {
          sources.push({
            kind: "fileHandle",
            handle: child,
            name,
            path: nextPath,
          });
        }
      } else if (child.kind === "directory") {
        sources.push(...await sourcesFromDirectoryHandle(child, nextPath));
      }
    }

    return sortSources(sources);
  }

  async function applyDirectoryHandle(handle) {
    const sources = await sourcesFromDirectoryHandle(handle);
    return applySources(sources, handle.name, handle.name);
  }

  async function chooseDirectory() {
    if (!supportsDirectoryHandles()) {
      console.log(`${LOG_PREFIX} directory handles unavailable; using webkitdirectory input.`);
      els.folderInput.click();
      return;
    }

    try {
      const handle = await window.showDirectoryPicker({ mode: "read" });
      logDirectoryHandleName("selected", handle.name);
      if (!(await ensureDirectoryPermission(handle, true))) {
        console.warn(`${LOG_PREFIX} folder permission was not granted for handle name:`, handle.name);
        return;
      }

      if (await applyDirectoryHandle(handle)) {
        await storeDirectoryHandle(handle);
      }
    } catch (err) {
      if (err?.name !== "AbortError") console.error(err);
    }
  }

  async function restoreSavedDirectory(summary) {
    if (!supportsDirectoryHandles()) return false;

    try {
      console.log(`${LOG_PREFIX} restoring saved source:`, {
        savedRootLabel: state.referencePath,
        savedSummaryLabel: summary?.sourceLabel,
        savedFileCount: summary?.count,
        savedSampleNames: summary?.sampleNames,
      });
      const handle = await getStoredDirectoryHandle();
      if (!handle) {
        console.warn(`${LOG_PREFIX} saved folder metadata exists, but no stored directory handle was found.`, {
          savedRootLabel: state.referencePath,
          savedSummaryLabel: summary?.sourceLabel,
        });
        return false;
      }

      logDirectoryHandleName("restored handle", handle.name);

      if (!(await ensureDirectoryPermission(handle))) {
        console.warn(`${LOG_PREFIX} saved folder needs fresh permission for handle name:`, handle.name);
        renderSavedSummary(summary, "Select the folder again so Chrome can refresh access.");
        return true;
      }

      if (!(await applyDirectoryHandle(handle))) {
        renderSavedSummary(summary);
      }
      return true;
    } catch (err) {
      console.error(`${LOG_PREFIX} unable to restore saved folder:`, sourceLabelForLog(summary?.sourceLabel), err);
      return false;
    }
  }

  function loadSavedState() {
    chrome.storage.local.get(SOURCE_STORAGE_KEYS, (result) => {
      state.referencePath = normalizeReferencePath(result.photoReferencePath);
      const summary = result.localPhotoSourceSummary;
      state.mode = FOLDER_SOURCE_MODE;
      console.log(`${LOG_PREFIX} loaded saved source state:`, {
        mode: state.mode,
        savedRootLabel: state.referencePath,
        savedCount: summary?.count || 0,
        savedSummaryLabel: summary?.sourceLabel || "",
        savedSampleNames: summary?.sampleNames || [],
      });
      renderList();

      if (summary?.count) {
        restoreSavedDirectory(summary).then((didRestore) => {
          if (didRestore) return;
          renderSavedSummary(summary);
        });
      } else {
        renderList();
      }
    });
  }

  function wireLocalPhotos() {
    els.folderInput = $("photo-source-folder-input");
    els.folderButton = $("photo-source-folder");
    els.pathInput = $("photo-source-path");

    if (
      !els.folderInput ||
      !els.folderButton ||
      !els.pathInput
    ) {
      console.error("Local photo settings controls are missing required DOM elements.");
      return;
    }

    els.folderButton.addEventListener("click", chooseDirectory);
    els.pathInput.addEventListener("change", () => {
      state.referencePath = normalizeReferencePath(els.pathInput.value);
      saveSummary(state.referencePath);
      renderList();
    });
    els.pathInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey) return;
      event.preventDefault();
      els.pathInput.blur();
    });

    els.folderInput.addEventListener("change", () => {
      const files = Array.from(els.folderInput.files || []);
      if (files.length) {
        deleteStoredDirectoryHandle();
        applyFiles(files, "Selected folder");
      }
      els.folderInput.value = "";
    });

    loadSavedState();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wireLocalPhotos, { once: true });
  } else {
    wireLocalPhotos();
  }

  function isMotherDayNewTabPage() {
    if (window.top !== window) return false;
    const newTabUrl = globalThis.chrome?.runtime?.getURL?.("newpage.html");
    if (!newTabUrl) return false;

    try {
      const expected = new URL(newTabUrl);
      const current = new URL(window.location.href);
      expected.hash = "";
      current.hash = "";
      return current.href === expected.href;
    } catch {
      return false;
    }
  }
})();
