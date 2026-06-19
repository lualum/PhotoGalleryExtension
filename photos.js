(function () {
	if (!isMotherDayNewTabPage()) return;

	const CACHE_MAX = 80;
	const STREAM_EDGE_MARGIN = 10;
	const STREAM_X_PHASE = 0.61803398875;
	const STREAM_SLOT_JITTER = 0.34;
	const OFFSCREEN_MOUSE = -9999;

	const canvas = document.getElementById("photo-canvas");
	const ctx = canvas.getContext("2d");

	let activeSources = [];
	let pool = [];
	let poolPos = 0;
	let sourceVersion = 0;
	let respawnVersion = 0;

	const cache = new Map();
	let tiles = [];
	let speedVal = 1,
		densityVal = 14,
		sizeVar = 3,
		angleDeg = 0,
		raf;

	let mouseX = OFFSCREEN_MOUSE,
		mouseY = OFFSCREEN_MOUSE;
	let mouseIsOnPage = false;
	let hoveredTile = null;

	function shuffle(items) {
		for (let i = items.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[items[i], items[j]] = [items[j], items[i]];
		}
		return items;
	}

	function buildPhotoSources(sources) {
		const usableSources = [];

		for (const source of Array.from(sources || [])) {
			const index = usableSources.length;
			if (source instanceof File) {
				usableSources.push({
					kind: "file",
					file: source,
					index,
					key: `file:${index}:${source.name}:${source.size}:${source.lastModified}`,
				});
			} else if (source?.kind === "file" && source.file instanceof File) {
				const file = source.file;
				usableSources.push({
					kind: "file",
					file,
					index,
					key: `file:${index}:${file.name}:${file.size}:${file.lastModified}`,
				});
			} else if (source?.kind === "fileHandle" && typeof source.handle?.getFile === "function") {
				const path = source.path || source.name || source.handle.name || `Photo ${index + 1}`;
				usableSources.push({
					kind: "fileHandle",
					handle: source.handle,
					path,
					index,
					key: `file-handle:${index}:${path}`,
				});
			} else if (source?.kind === "fileUrl" && source.url) {
				const url = String(source.url);
				const path = source.path || url;
				usableSources.push({
					kind: "fileUrl",
					url,
					path,
					index,
					key: `file-url:${index}:${url}`,
				});
			}
		}

		return usableSources;
	}

	function resetPool() {
		pool = shuffle([...activeSources]);
		poolPos = 0;
	}

	function nextSource() {
		if (!pool.length) return null;
		const source = pool[poolPos % pool.length];
		poolPos++;
		if (poolPos % pool.length === 0) shuffle(pool);
		return source;
	}

	function closeBitmap(bitmap) {
		if (bitmap && typeof bitmap.close === "function") bitmap.close();
	}

	function bitmapCanDraw(bitmap) {
		try {
			return Boolean(bitmap && bitmap.width > 0 && bitmap.height > 0);
		} catch {
			return false;
		}
	}

	function bitmapIsVisible(bitmap) {
		return tiles.some((tile) => tile.bmp === bitmap);
	}

	function cacheHasBitmap(bitmap) {
		for (const cachedBitmap of cache.values()) {
			if (cachedBitmap === bitmap) return true;
		}
		return false;
	}

	function removeCachedBitmap(bitmap) {
		for (const [key, cachedBitmap] of cache) {
			if (cachedBitmap === bitmap) cache.delete(key);
		}
	}

	function discardBitmap(bitmap) {
		if (!bitmap) return;
		removeCachedBitmap(bitmap);
		closeBitmap(bitmap);
	}

	function releaseBitmapIfUnused(bitmap) {
		if (!bitmap || bitmapIsVisible(bitmap) || cacheHasBitmap(bitmap)) return;
		closeBitmap(bitmap);
	}

	function clearTiles() {
		const tileBitmaps = new Set();
		for (const tile of tiles) {
			if (tile.bmp) tileBitmaps.add(tile.bmp);
			tile.bmp = null;
		}
		tiles = [];
		for (const bitmap of tileBitmaps) releaseBitmapIfUnused(bitmap);
	}

	function clearCache() {
		for (const bitmap of cache.values()) closeBitmap(bitmap);
		cache.clear();
	}

	function evictOldestBitmap() {
		const oldestKey = cache.keys().next().value;
		// The bitmap may still be held by an active tile or prewarm batch.
		if (oldestKey !== undefined) cache.delete(oldestKey);
	}

	function rememberBitmap(cacheKey, bitmap) {
		if (cache.size >= CACHE_MAX) {
			evictOldestBitmap();
		}

		cache.set(cacheKey, bitmap);
		return bitmap;
	}

	function getCachedBitmap(cacheKey) {
		const bitmap = cache.get(cacheKey);
		if (!bitmap) return null;
		if (bitmapCanDraw(bitmap)) return bitmap;
		discardBitmap(bitmap);
		return null;
	}

	async function getBitmap(source) {
		if (!source) throw new Error("No photo source available.");

		if (source.kind === "file") {
			const cachedBitmap = getCachedBitmap(source.key);
			if (cachedBitmap) return cachedBitmap;
			return rememberBitmap(source.key, await createImageBitmap(source.file));
		}

		if (source.kind === "fileHandle") {
			const file = await source.handle.getFile();
			const cacheKey = `${source.key}:${file.size}:${file.lastModified}`;
			const cachedBitmap = getCachedBitmap(cacheKey);
			if (cachedBitmap) return cachedBitmap;
			return rememberBitmap(cacheKey, await createImageBitmap(file));
		}

		if (source.kind === "fileUrl") {
			const cachedBitmap = getCachedBitmap(source.key);
			if (cachedBitmap) return cachedBitmap;
			const response = await fetch(source.url);
			if (!response.ok) throw new Error(`Missing referenced photo ${source.path || source.url}.`);
			const blob = await response.blob();
			return rememberBitmap(source.key, await createImageBitmap(blob));
		}

		throw new Error("Unsupported photo source.");
	}

	async function nextBitmap(maxAttempts = 30) {
		const attempts = Math.min(Math.max(maxAttempts, densityVal * 2), Math.max(activeSources.length, maxAttempts));

		for (let i = 0; i < attempts; i++) {
			const source = nextSource();
			if (!source) break;
			try {
				const bitmap = await getBitmap(source);
				if (bitmapCanDraw(bitmap)) return bitmap;
				discardBitmap(bitmap);
			} catch {
				// Skip unreadable sources.
			}
		}

		throw new Error("No readable photos found.");
	}

	async function prewarm(count) {
		const bitmaps = [];
		const attempts = Math.max(count * 4, count + 8);

		for (let i = 0; i < attempts && bitmaps.length < count; i++) {
			try {
				bitmaps.push(await nextBitmap());
			} catch {
				break;
			}
		}

		return bitmaps;
	}

	function setPhotoFiles(files) {
		const usableFiles = Array.from(files || []).filter((file) => file instanceof File);
		setPhotoSources(usableFiles);
	}

	function setPhotoSources(sources) {
		const usableSources = buildPhotoSources(sources);
		activeSources = usableSources;
		sourceVersion++;
		cancelAnimationFrame(raf);
		clearTiles();
		hoveredTile = null;
		clearCache();
		resetPool();
		hasRevealed = false;
		canvas.style.opacity = "0";
		startRespawnAll();
	}

	window.MotherDayPhotoPlane = {
		setFiles: setPhotoFiles,
		setSources: setPhotoSources,
	};

	function resetHoverState() {
		hoveredTile = null;
		for (const t of tiles) {
			t.hoverScale = 1;
			t.hoverAlpha = null;
		}
	}

	function clearMousePosition(resetHover = false) {
		mouseX = OFFSCREEN_MOUSE;
		mouseY = OFFSCREEN_MOUSE;
		mouseIsOnPage = false;
		if (resetHover) resetHoverState();
	}

	function updateMousePosition(e) {
		mouseX = e.clientX;
		mouseY = e.clientY;
		mouseIsOnPage = true;
	}

	function mouseIsCurrentlyOnPage() {
		return (
			mouseIsOnPage &&
			document.visibilityState === "visible" &&
			document.documentElement.matches(":hover") &&
			mouseX >= 0 &&
			mouseX <= window.innerWidth &&
			mouseY >= 0 &&
			mouseY <= window.innerHeight
		);
	}

	function refreshMousePosition() {
		if (!mouseIsOnPage) return false;
		if (mouseIsCurrentlyOnPage()) return true;

		clearMousePosition(true);
		return false;
	}

	const mouseMoveEvent = window.PointerEvent ? "pointermove" : "mousemove";
	window.addEventListener(mouseMoveEvent, updateMousePosition, { passive: true });
	window.addEventListener("mouseleave", () => clearMousePosition(true));
	window.addEventListener("blur", () => clearMousePosition(true));
	document.addEventListener("mouseleave", () => clearMousePosition(true));
	document.addEventListener("pointerleave", () => clearMousePosition(true));
	document.addEventListener("mouseout", (e) => {
		if (!e.relatedTarget && !e.toElement) clearMousePosition(true);
	});
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState !== "visible") clearMousePosition(true);
	});

	function resize() {
		canvas.width = innerWidth;
		canvas.height = innerHeight;
	}
	window.addEventListener("resize", () => {
		resize();
		startRespawnAll();
	});
	resize();

	function rand(a, b) {
		return a + Math.random() * (b - a);
	}

	function clamp(value, min, max) {
		return Math.max(min, Math.min(max, value));
	}

	function applyBitmapToTile(t, bmp) {
		if (!bitmapCanDraw(bmp)) throw new Error("Photo bitmap is not drawable.");
		const d = Math.random();
		const sz = 80 + d * (80 * sizeVar - 80);
		const aspectRatio = bmp.width / bmp.height || 1;
		t.bmp = bmp;
		t.depth = d;
		t.w = sz * aspectRatio;
		t.h = sz;
		t.speed = (0.25 + d * 2.0) * speedVal;
		t.alpha = 0.3 + d * 0.7;
	}

	function streamStartY(t) {
		return -t.h - STREAM_EDGE_MARGIN;
	}

	function streamEndY(t) {
		return canvas.height + t.h + STREAM_EDGE_MARGIN;
	}

	function spreadProgress(index, total) {
		const count = Math.max(total, 1);
		const center = (index + 0.5) / count;
		const jitter = rand(-0.5, 0.5) * (STREAM_SLOT_JITTER / count);
		return clamp(center + jitter, 0, 1);
	}

	function spreadX(index, total, width) {
		const count = Math.max(total, 1);
		const jitter = rand(-0.5, 0.5) / count;
		const progress = (index * STREAM_X_PHASE + jitter + 1) % 1;
		return rand(-width, 0) + progress * (canvas.width + width * 1.5);
	}

	function placeTileInStream(t, index, total) {
		t.x = spreadX(index, total, t.w);
		t.y = streamStartY(t) + spreadProgress(index, total) * (streamEndY(t) - streamStartY(t));
	}

	function topSpawnSpacing() {
		return clamp(canvas.height / Math.max(densityVal, 1), 24, 160);
	}

	function placeTileAboveStream(t) {
		const topY = streamStartY(t);
		const spacing = topSpawnSpacing();
		const minQueuedY = topY - spacing * 3;
		let highestY = Infinity;

		for (const other of tiles) {
			if (other === t || other.loading) continue;
			if (other.y < minQueuedY || other.y > topY + spacing) continue;
			highestY = Math.min(highestY, other.y);
		}

		t.x = rand(-t.w, canvas.width + t.w);
		t.y = Number.isFinite(highestY) && highestY < 0
			? clamp(Math.min(topY, highestY - spacing), minQueuedY, topY)
			: topY;
	}

	function makeTileData(bmp, index, total) {
		const t = {
			bmp,
			w: 0,
			h: 0,
			depth: 0,
			x: 0,
			y: 0,
			speed: 0,
			alpha: 1,
			hoverScale: 1,
			hoverAlpha: null,
			loading: false,
		};
		applyBitmapToTile(t, bmp);
		placeTileInStream(t, index, total);
		return t;
	}

	async function respawnTop(t) {
		if (t.loading) return;
		t.loading = true;
		const version = sourceVersion;

		try {
			const bmp = await nextBitmap();
			if (version !== sourceVersion) return;
			const previousBitmap = t.bmp;
			applyBitmapToTile(t, bmp);
			if (previousBitmap !== bmp) releaseBitmapIfUnused(previousBitmap);
			placeTileAboveStream(t);
			t.hoverScale = 1;
			t.hoverAlpha = null;
		} catch {
			// Keep the previous tile if no replacement can be decoded.
		} finally {
			t.loading = false;
		}
	}

	async function respawnAll() {
		const version = sourceVersion;
		const respawnId = ++respawnVersion;
		cancelAnimationFrame(raf);
		clearTiles();
		hoveredTile = null;

		const initial = await prewarm(Math.min(densityVal, 20));
		if (version !== sourceVersion || respawnId !== respawnVersion) return;

		for (let i = 0; i < densityVal && initial.length; i++) {
			const bmp = initial[i % initial.length];
			if (bmp) tiles.push(makeTileData(bmp, i, densityVal));
		}

		if (!initial.length) {
			canvas.style.opacity = "1";
		}

		loop();
		for (let i = 0; i < 20; i++) nextBitmap().catch(() => {});
	}

	function startRespawnAll() {
		respawnAll().catch(() => {
			canvas.style.opacity = "1";
		});
	}

	function drawRounded(bmp, x, y, w, h, r, a) {
		if (!bitmapCanDraw(bmp)) return false;
		ctx.save();
		try {
			ctx.globalAlpha = a;
			ctx.beginPath();
			ctx.moveTo(x + r, y);
			ctx.lineTo(x + w - r, y);
			ctx.quadraticCurveTo(x + w, y, x + w, y + r);
			ctx.lineTo(x + w, y + h - r);
			ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
			ctx.lineTo(x + r, y + h);
			ctx.quadraticCurveTo(x, y + h, x, y + h - r);
			ctx.lineTo(x, y + r);
			ctx.quadraticCurveTo(x, y, x + r, y);
			ctx.closePath();
			ctx.clip();
			ctx.drawImage(bmp, x, y, w, h);
			return true;
		} catch {
			return false;
		} finally {
			ctx.restore();
		}
	}

	const LERP_IN = 0.08;
	const LERP_OUT = 0.06;
	const SCALE_TARGET = 1.5;
	const SPEED_HOVER_FACTOR = 0.15;

	let hasRevealed = false;
	function loop() {
		ctx.clearRect(0, 0, canvas.width, canvas.height);

		const ar = (angleDeg * Math.PI) / 180;
		const sorted = [...tiles].sort((a, b) => a.depth - b.depth);
		const hasActiveMouse = refreshMousePosition();

		hoveredTile = null;
		for (const t of sorted) {
			if (!t.bmp) continue;
			const scaledW = t.w * t.hoverScale;
			const scaledH = t.h * t.hoverScale;
			const ox = t.x - (scaledW - t.w) / 2;
			const oy = t.y - (scaledH - t.h) / 2;
			t._ox = ox;
			t._oy = oy;
			t._sw = scaledW;
			t._sh = scaledH;
			if (
				hasActiveMouse &&
				mouseX >= ox &&
				mouseX <= ox + scaledW &&
				mouseY >= oy &&
				mouseY <= oy + scaledH
			) {
				hoveredTile = t;
			}
		}

		const anyHovered = hoveredTile !== null;
		const speedMult = anyHovered ? SPEED_HOVER_FACTOR : 1;

		for (const t of sorted) {
			const isHovered = t === hoveredTile;
			const lerpFactor = isHovered ? LERP_IN : LERP_OUT;
			const scaleTarget = isHovered ? SCALE_TARGET : 1;
			t.hoverScale += (scaleTarget - t.hoverScale) * lerpFactor;

			if (t.hoverAlpha === null) t.hoverAlpha = t.alpha;
			const alphaTarget = isHovered ? 1.0 : t.alpha;
			t.hoverAlpha += (alphaTarget - t.hoverAlpha) * lerpFactor;
			if (!isHovered && Math.abs(t.hoverAlpha - t.alpha) < 0.005) {
				t.hoverAlpha = null;
			}

			t.x += Math.sin(ar) * t.speed * 0.5 * speedMult;
			t.y += Math.cos(ar) * t.speed * 0.5 * speedMult;

			if (
				t.y > canvas.height + t.h + 10 ||
				(angleDeg > 20 && t.x > canvas.width + t.w + 10) ||
				(angleDeg < -20 && t.x < -t.w * 2)
			) {
				respawnTop(t);
			}
		}

		const drawOrder = anyHovered
			? [...sorted.filter((t) => t !== hoveredTile), hoveredTile]
			: sorted;

		for (const t of drawOrder) {
			if (!t.bmp) {
				respawnTop(t);
				continue;
			}
			const scaledW = t.w * t.hoverScale;
			const scaledH = t.h * t.hoverScale;
			const ox = t.x - (scaledW - t.w) / 2;
			const oy = t.y - (scaledH - t.h) / 2;
			const drawAlpha = t.hoverAlpha !== null ? t.hoverAlpha : t.alpha;
			if (!drawRounded(t.bmp, ox, oy, scaledW, scaledH, 10 * t.hoverScale, drawAlpha)) {
				discardBitmap(t.bmp);
				t.bmp = null;
				respawnTop(t);
			}
		}

		if (!hasRevealed && tiles.length > 0) {
			hasRevealed = true;
			requestAnimationFrame(() => {
				canvas.style.opacity = "1";
			});
		}
		raf = requestAnimationFrame(loop);
	}

	const settingsBtn = document.getElementById("settings-btn");
	const panel = document.getElementById("photo-controls");
	settingsBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		panel.classList.toggle("open");
	});
	document.addEventListener("click", (e) => {
		if (!panel.contains(e.target) && e.target !== settingsBtn) panel.classList.remove("open");
	});

	chrome.storage.local.get(["speed", "density", "sizevar", "angle"], (r) => {
		if (r.speed !== undefined) {
			speedVal = r.speed;
			document.getElementById("ctrl-speed").value = r.speed;
			document.getElementById("val-speed").textContent = parseFloat(r.speed).toFixed(1);
		}
		if (r.density !== undefined) {
			densityVal = Math.round(r.density);
			document.getElementById("ctrl-density").value = r.density;
			document.getElementById("val-density").textContent = Math.round(r.density);
		}
		if (r.sizevar !== undefined) {
			sizeVar = r.sizevar;
			document.getElementById("ctrl-sizevar").value = r.sizevar;
			document.getElementById("val-sizevar").textContent = parseFloat(r.sizevar).toFixed(1);
		}
		if (r.angle !== undefined) {
			angleDeg = r.angle;
			document.getElementById("ctrl-angle").value = r.angle;
			document.getElementById("val-angle").textContent = `${Math.round(r.angle)}°`;
		}
		resetPool();
		startRespawnAll();
	});

	function bindSlider(id, valId, setter, fmt) {
		document.getElementById(id).addEventListener("input", function () {
			const v = parseFloat(this.value);
			setter(v);
			document.getElementById(valId).textContent = fmt(v);
			chrome.storage.local.set({ [id.replace("ctrl-", "")]: v });
		});
	}
	bindSlider(
		"ctrl-speed",
		"val-speed",
		(v) => {
			speedVal = v;
		},
		(v) => v.toFixed(1),
	);
	bindSlider(
		"ctrl-density",
		"val-density",
		(v) => {
			densityVal = Math.round(v);
			startRespawnAll();
		},
		(v) => Math.round(v),
	);
	bindSlider(
		"ctrl-sizevar",
		"val-sizevar",
		(v) => {
			sizeVar = v;
		},
		(v) => v.toFixed(1),
	);
	bindSlider(
		"ctrl-angle",
		"val-angle",
		(v) => {
			angleDeg = v;
		},
		(v) => `${Math.round(v)}°`,
	);

	if (Array.isArray(window.MotherDayPendingPhotoSources)) {
		setPhotoSources(window.MotherDayPendingPhotoSources);
	} else if (Array.isArray(window.MotherDayPendingPhotoFiles)) {
		setPhotoFiles(window.MotherDayPendingPhotoFiles);
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
