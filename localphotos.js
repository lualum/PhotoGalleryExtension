"use strict";

(function () {
	if (!isMotherDayNewTabPage()) return;

	const FOLDER_SOURCE_MODE = "folder";
	const REFERENCE_SOURCE_MODE = "referencePath";
	const DB_NAME = "MotherDayLocalPhotos";
	const DB_VERSION = 1;
	const HANDLE_STORE_NAME = "handles";
	const ACTIVE_DIRECTORY_HANDLE_KEY = "activeDirectory";
	const SOURCE_STORAGE_KEYS = ["photoReferencePath", "localPhotoSourceMode", "localPhotoSourceSummary"];
	const DIRECTORY_PICKER_ID = "motherday-photos";
	const FILE_URL_ORIGIN = "file:///*";
	const IMAGE_EXT_PATTERN = /\.(avif|gif|jpe?g|png|webp)$/i;
	const LOG_PREFIX = "[MotherDayLocalPhotos]";
	const LOGGED_FILE_PATH_LIMIT = 25;

	const state = {
		sources: [],
		mode: FOLDER_SOURCE_MODE,
		referencePath: "",
	};

	const els = {};
	let savedPermissionHandle = null;
	let savedPermissionSummary = null;
	let needsFolderReselect = false;

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

	function isImageName(name) {
		return IMAGE_EXT_PATTERN.test(name || "");
	}

	function sortSources(sources) {
		return [...sources].sort((a, b) => sourceLabel(a).localeCompare(sourceLabel(b), undefined, {
			numeric: true,
			sensitivity: "base",
		}));
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
		const normalizedPath = String(path || "").replace(/[\r\n]+/g, " ").trim();
		if (normalizedPath === "/" || /^[A-Za-z]:[\\/]?$/.test(normalizedPath)) return normalizedPath;
		return normalizedPath.replace(/[\\/]+$/g, "");
	}

	function pathBasename(path) {
		return normalizeReferencePath(path).split(/[\\/]/).filter(Boolean).pop() || "";
	}

	function referencePathMatchesName(path, name) {
		return !name || pathBasename(path) === name;
	}

	function pathRootThroughName(path, name) {
		if (!name) return "";

		const normalizedPath = normalizeReferencePath(path).replace(/\\/g, "/");
		if (!isAbsoluteReferencePath(normalizedPath)) return "";

		const parts = normalizedPath.split("/");
		const index = parts.lastIndexOf(name);
		if (index < 0) return "";

		const rootPath = parts.slice(0, index + 1).join("/");
		return normalizeReferencePath(rootPath || "/");
	}

	function referencePathCandidatesFromSummary(summary, name) {
		const samplePaths = Array.isArray(summary?.sampleNames) ? summary.sampleNames : [];
		return [
			summary?.sourceLabel,
			...samplePaths.map((path) => pathRootThroughName(path, name)),
		];
	}

	function isAbsoluteReferencePath(path) {
		const normalizedPath = normalizeReferencePath(path);
		return normalizedPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(normalizedPath);
	}

	function joinReferencePath(rootPath, fileName) {
		return `${normalizeReferencePath(rootPath).replace(/[\\/]+$/g, "")}/${fileName}`;
	}

	function encodePathSegments(path) {
		return path.split("/").map((part) => encodeURIComponent(part)).join("/");
	}

	function fileUrlForPath(path) {
		const normalizedPath = normalizeReferencePath(path).replace(/\\/g, "/");
		const windowsPathMatch = normalizedPath.match(/^([A-Za-z]:)\/(.*)$/);

		if (windowsPathMatch) {
			return `file:///${windowsPathMatch[1]}/${encodePathSegments(windowsPathMatch[2])}`;
		}

		if (normalizedPath.startsWith("/")) {
			return `file://${encodePathSegments(normalizedPath)}`;
		}

		return "";
	}

	function currentReferencePath() {
		return normalizeReferencePath(els.pathInput?.value || state.referencePath);
	}

	function referencePathForName(name, ...fallbacks) {
		const candidates = [
			currentReferencePath(),
			state.referencePath,
			...fallbacks,
			name,
		].flat().map(normalizeReferencePath).filter(Boolean);
		const absolutePath = candidates.find((path) => isAbsoluteReferencePath(path) && referencePathMatchesName(path, name));
		if (absolutePath) return absolutePath;

		const matchingPath = candidates.find((path) => referencePathMatchesName(path, name));
		if (matchingPath) return matchingPath;

		return candidates[0] || "";
	}

	function setSavedPermissionHandle(handle, summary = null) {
		savedPermissionHandle = handle || null;
		savedPermissionSummary = summary || null;
		if (handle) needsFolderReselect = false;
		updateSourceUI();
	}

	function setNeedsFolderReselect(needsReselect) {
		needsFolderReselect = Boolean(needsReselect);
		if (needsFolderReselect) {
			savedPermissionHandle = null;
			savedPermissionSummary = null;
		}
		updateSourceUI();
	}

	function updateSourceUI() {
		if (els.folderButton) {
			els.folderButton.classList.add("active");
			els.folderButton.setAttribute("aria-pressed", "true");
			const buttonLabel = savedPermissionHandle
				? "Grant access to saved folder"
				: needsFolderReselect
					? "Select saved folder again"
					: "Read folder";
			els.folderButton.setAttribute("aria-label", buttonLabel);
			els.folderButton.title = buttonLabel;
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

	function storageGet(area, keys) {
		return new Promise((resolve) => {
			if (!area) {
				resolve({});
				return;
			}

			area.get(keys, (result) => resolve(result || {}));
		});
	}

	function storageSet(area, payload, areaLabel) {
		if (!area) return;
		area.set(payload, () => {
			const err = chrome.runtime?.lastError;
			if (err) console.warn(`${LOG_PREFIX} unable to save ${areaLabel} source state:`, err.message);
		});
	}

	function hasSavedSourceState(result) {
		return Boolean(normalizeReferencePath(result?.photoReferencePath) || result?.localPhotoSourceSummary?.count);
	}

	function chooseSavedState(localResult, syncResult) {
		if (localResult?.localPhotoSourceSummary?.count) return { result: localResult, source: "local" };
		if (syncResult?.localPhotoSourceSummary?.count) return { result: syncResult, source: "sync" };
		if (hasSavedSourceState(localResult)) return { result: localResult, source: "local" };
		if (hasSavedSourceState(syncResult)) return { result: syncResult, source: "sync" };
		return { result: localResult || {}, source: "local" };
	}

	function pathPatternForSources(sources) {
		const entries = [];

		for (const source of sources) {
			const name = pathBasename(sourceLabel(source));
			const match = name.match(/^(\d+)(\.[a-z0-9]+)$/i);
			if (!match) return null;

			entries.push({
				index: Number(match[1]),
				extension: match[2].toLowerCase(),
			});
		}

		if (!entries.length) return null;

		const extension = entries[0].extension;
		if (!entries.every((entry) => entry.extension === extension && Number.isSafeInteger(entry.index))) {
			return null;
		}

		const indexes = entries.map((entry) => entry.index).sort((a, b) => a - b);
		return {
			start: indexes[0],
			end: indexes[indexes.length - 1],
			count: indexes.length,
			extension,
		};
	}

	function referencePatternFromSummary(summary) {
		const pattern = summary?.filePathPattern;
		const count = Number(pattern?.count);
		const explicitStart = Number(pattern?.start);
		const explicitEnd = Number(pattern?.end);
		const extension = typeof pattern?.extension === "string" ? pattern.extension : "";
		if (!Number.isSafeInteger(count) || count <= 0 || !extension) return null;

		const start = Number.isSafeInteger(explicitStart)
			? explicitStart
			: Number.isSafeInteger(explicitEnd)
				? explicitEnd - count + 1
				: null;
		if (!Number.isSafeInteger(start)) return null;

		const end = Number.isSafeInteger(explicitEnd) ? explicitEnd : start + count - 1;
		if (!Number.isSafeInteger(end) || end < start) return null;

		return {
			start,
			end,
			count: end - start + 1,
			extension,
		};
	}

	function buildReferencePathSources(referencePath, pattern) {
		const sources = [];
		if (!pattern) return sources;

		for (let index = pattern.start; index <= pattern.end; index++) {
			const path = joinReferencePath(referencePath, `${index}${pattern.extension}`);
			const url = fileUrlForPath(path);
			if (!url) continue;

			sources.push({
				kind: "fileUrl",
				path,
				url,
			});
		}

		return sources;
	}

	function saveSummary(sourceLabel, sourceCount = state.sources.length) {
		const summary = summaryForSources(state.sources, sourceLabel);
		summary.count = sourceCount;
		const filePathPattern = pathPatternForSources(state.sources);
		if (filePathPattern) summary.filePathPattern = filePathPattern;
		console.log(`${LOG_PREFIX} saving source summary:`, {
			mode: state.mode,
			rootLabel: state.referencePath,
			summaryLabel: summary.sourceLabel,
			fileCount: summary.count,
			filePathPattern: summary.filePathPattern,
			sampleNames: summary.sampleNames,
		});
		const payload = {
			photoReferencePath: state.referencePath,
			localPhotoSourceMode: state.mode,
			localPhotoSourceSummary: summary,
		};
		storageSet(chrome.storage.local, payload, "local");
		storageSet(chrome.storage.sync, payload, "sync backup");
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

	function applySources(sources, sourceLabelText, referencePath = "", sourceMode = FOLDER_SOURCE_MODE) {
		if (!sources.length) {
			return false;
		}

		state.mode = sourceMode;
		state.sources = sources;
		if (sourceMode === REFERENCE_SOURCE_MODE) {
			setSavedPermissionHandle(null);
		}
		setNeedsFolderReselect(false);
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

	async function ensureDirectoryPermission(handle, requestAccess = false) {
		const options = { mode: "read" };
		try {
			const currentPermission = await handle.queryPermission(options);
			console.log(`${LOG_PREFIX} folder permission for handle name:`, handle.name, currentPermission);
			if (currentPermission === "granted") return true;
			if (!requestAccess) return false;

			const requestedPermission = await handle.requestPermission(options);
			console.log(`${LOG_PREFIX} requested folder permission for handle name:`, handle.name, requestedPermission);
			return requestedPermission === "granted";
		} catch (err) {
			console.warn(`${LOG_PREFIX} unable to verify folder permission for handle name:`, handle.name, err);
			return false;
		}
	}

	function chromeCallback(method, ...args) {
		return new Promise((resolve) => {
			if (typeof method !== "function") {
				resolve(false);
				return;
			}

			method(...args, (result) => {
				const err = chrome.runtime?.lastError;
				if (err) {
					console.warn(`${LOG_PREFIX} Chrome permission API warning:`, err.message);
					resolve(false);
					return;
				}

				resolve(Boolean(result));
			});
		});
	}

	async function isFileSchemeAccessAllowed() {
		const method = chrome.extension?.isAllowedFileSchemeAccess;
		if (typeof method !== "function") return true;

		try {
			return Boolean(await method.call(chrome.extension));
		} catch (err) {
			console.warn(`${LOG_PREFIX} unable to check file URL access:`, err);
			return false;
		}
	}

	async function ensureFileUrlAccess(requestAccess = false) {
		const permission = { origins: [FILE_URL_ORIGIN] };
		const permissionsApi = chrome.permissions;

		if (await isFileSchemeAccessAllowed()) return true;
		if (!permissionsApi?.contains) return false;

		if (requestAccess) {
			const grantedPermission = await chromeCallback(permissionsApi.request?.bind(permissionsApi), permission);
			const allowedFileScheme = await isFileSchemeAccessAllowed();
			console.log(`${LOG_PREFIX} requested file URL access:`, {
				grantedPermission,
				allowedFileScheme,
			});
			return grantedPermission && allowedFileScheme;
		}

		const hasPermission = await chromeCallback(permissionsApi.contains.bind(permissionsApi), permission);
		if (hasPermission && await isFileSchemeAccessAllowed()) {
			return true;
		}

		console.warn(`${LOG_PREFIX} file URL access is not enabled for referenced photos.`, {
			extensionId: chrome.runtime?.id,
		});
		return false;
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

	async function applyDirectoryHandle(handle, referencePath = "") {
		const rootPath = referencePathForName(handle.name, referencePath || handle.name);
		const sources = await sourcesFromDirectoryHandle(handle, rootPath || handle.name);
		return applySources(sources, rootPath || handle.name, rootPath || handle.name, FOLDER_SOURCE_MODE);
	}

	async function applyReferencePathSources(summary = null, requestFileAccess = false) {
		const referencePath = currentReferencePath();
		if (!isAbsoluteReferencePath(referencePath)) return false;

		const pattern = referencePatternFromSummary(summary);
		if (!pattern) return false;

		const hasFileUrlAccess = await ensureFileUrlAccess(requestFileAccess);
		if (requestFileAccess && !hasFileUrlAccess) return false;

		const sources = buildReferencePathSources(referencePath, pattern);
		if (!sources.length) return false;

		console.log(`${LOG_PREFIX} applying referenced file path source:`, {
			referencePath,
			fileCount: sources.length,
			pattern,
		});
		return applySources(sources, referencePath, referencePath, REFERENCE_SOURCE_MODE);
	}

	async function requestSavedDirectoryPermission({ clearOnFailure = false } = {}) {
		const handle = savedPermissionHandle;
		const summary = savedPermissionSummary;
		if (!handle) return false;

		if (!(await ensureDirectoryPermission(handle, true))) {
			console.warn(`${LOG_PREFIX} saved folder permission was not granted for handle name:`, handle.name);
			if (clearOnFailure) setSavedPermissionHandle(null);
			return false;
		}

		setSavedPermissionHandle(null);
		const rootPath = referencePathForName(
			handle.name,
			state.referencePath,
			summary?.sourceLabel,
			referencePathCandidatesFromSummary(summary, handle.name),
			handle.name,
		);
		if (await applyDirectoryHandle(handle, rootPath)) {
			await storeDirectoryHandle(handle);
			return true;
		}

		renderSavedSummary(summary);
		return false;
	}

	async function showPhotoDirectoryPicker() {
		try {
			return await window.showDirectoryPicker({ id: DIRECTORY_PICKER_ID, mode: "read" });
		} catch (err) {
			if (err?.name !== "TypeError") throw err;
			return window.showDirectoryPicker({ mode: "read" });
		}
	}

	async function chooseDirectory() {
		if (supportsDirectoryHandles()) {
			try {
				if (savedPermissionHandle) {
					await requestSavedDirectoryPermission({ clearOnFailure: true });
					return;
				}

				const handle = await showPhotoDirectoryPicker();
				const rootPath = referencePathForName(handle.name, state.referencePath || handle.name);
				logDirectoryHandleName("selected", handle.name);
				if (!(await ensureDirectoryPermission(handle, true))) {
					console.warn(`${LOG_PREFIX} folder permission was not granted for handle name:`, handle.name);
					return;
				}

				if (await applyDirectoryHandle(handle, rootPath)) {
					await storeDirectoryHandle(handle);
				}
			} catch (err) {
				if (err?.name !== "AbortError") console.error(err);
			}
			return;
		}

		if (isAbsoluteReferencePath(currentReferencePath())) {
			const filePathPattern = pathPatternForSources(state.sources) || savedPermissionSummary?.filePathPattern;
			if (!filePathPattern) {
				console.warn(`${LOG_PREFIX} directory handles unavailable; saved file pattern is required before reading a reference path.`);
				return;
			}

			const summary = {
				...(savedPermissionSummary || {}),
				count: savedPermissionSummary?.count || state.sources.length,
				filePathPattern,
			};

			await applyReferencePathSources(summary, true);
			return;
		}

		console.warn(`${LOG_PREFIX} directory handles unavailable; enter an absolute folder path to read referenced files.`);
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
				if (await applyReferencePathSources(summary, false)) {
					return true;
				}

				setNeedsFolderReselect(true);
				return false;
			}

			logDirectoryHandleName("restored handle", handle.name);

			const rootPath = referencePathForName(
				handle.name,
				state.referencePath,
				summary?.sourceLabel,
				referencePathCandidatesFromSummary(summary, handle.name),
				handle.name,
			);
			if (rootPath && state.referencePath !== rootPath) {
				state.referencePath = rootPath;
				updateSourceUI();
			}

			if (!(await ensureDirectoryPermission(handle))) {
				console.warn(`${LOG_PREFIX} saved folder needs fresh permission for handle name:`, handle.name);
				setSavedPermissionHandle(handle, summary);
				renderSavedSummary(summary, "Select the folder again so Chrome can refresh access.");
				return true;
			}

			setSavedPermissionHandle(null);
			if (!(await applyDirectoryHandle(handle, rootPath))) {
				renderSavedSummary(summary);
			}
			return true;
		} catch (err) {
			console.error(`${LOG_PREFIX} unable to restore saved folder:`, sourceLabelForLog(summary?.sourceLabel), err);
			return false;
		}
	}

	async function loadSavedState() {
		const [localResult, syncResult] = await Promise.all([
			storageGet(chrome.storage.local, SOURCE_STORAGE_KEYS),
			storageGet(chrome.storage.sync, SOURCE_STORAGE_KEYS),
		]);
		const { result, source } = chooseSavedState(localResult, syncResult);
		if (source === "sync") {
			storageSet(chrome.storage.local, result, "local source state from sync backup");
		}

		state.referencePath = normalizeReferencePath(result.photoReferencePath);
		const summary = result.localPhotoSourceSummary;
		state.mode = result.localPhotoSourceMode || FOLDER_SOURCE_MODE;
		console.log(`${LOG_PREFIX} loaded saved source state:`, {
			source,
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
		} else if (state.referencePath) {
			applyReferencePathSources(null, false).then((didApply) => {
				if (!didApply) renderList();
			});
		} else {
			renderList();
		}
	}

	function wireLocalPhotos() {
		els.folderButton = $("photo-source-folder");
		els.pathInput = $("photo-source-path");

		if (
			!els.folderButton ||
			!els.pathInput
		) {
			console.error("Local photo settings controls are missing required DOM elements.");
			return;
		}

		els.folderButton.addEventListener("click", chooseDirectory);
		els.pathInput.addEventListener("input", () => {
			state.referencePath = normalizeReferencePath(els.pathInput.value);
		});
		els.pathInput.addEventListener("change", () => {
			state.referencePath = normalizeReferencePath(els.pathInput.value);
			if (isAbsoluteReferencePath(state.referencePath)) {
				const filePathPattern = pathPatternForSources(state.sources) || savedPermissionSummary?.filePathPattern;
				if (filePathPattern) {
					applyReferencePathSources({
						count: state.sources.length || savedPermissionSummary?.count || 0,
						filePathPattern,
					}, false).then((didApply) => {
						if (!didApply) {
							saveSummary(state.referencePath, state.sources.length || savedPermissionSummary?.count || 0);
							renderList();
						}
					});
				} else {
					saveSummary(state.referencePath, 0);
					renderList();
				}
			} else {
				saveSummary(state.referencePath, state.sources.length || savedPermissionSummary?.count || 0);
				renderList();
			}
		});
		els.pathInput.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" || event.shiftKey) return;
			event.preventDefault();
			els.pathInput.blur();
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
