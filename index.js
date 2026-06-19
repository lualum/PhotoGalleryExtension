"use strict";

(function () {
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

	if (!isMotherDayNewTabPage()) return;

	const store = chrome.storage.sync;

	(function () {
		// Clock
		function checkTime(i) { return i < 10 ? "0" + i : i; }
		function startTime() {
			var today = new Date(),
				h = checkTime(today.getHours()),
				m = checkTime(today.getMinutes());
			document.getElementById("time").innerHTML = h + ":" + m;
			setTimeout(startTime, 500);
		}
		startTime();
	})();

	class Init {
		constructor() {
			this.batteryconnectionDetails = null;
			this.dateDetails = null;
		}
	}
	class TabAction extends Init {
		constructor(props) { super(props); }
		getbatteryconnectionDetails() {
			let promise = insertconnectionDetails();
			promise.then((res) => { this.batteryconnectionDetails = res; });
		}
		setDateDetails() { this.dateDetails = getdateDetails(); }
	}

	let tab = new TabAction();
	tab.getbatteryconnectionDetails();
	tab.setDateDetails();
	insertinDom();

	function insertinDom() {
		document.getElementById("date").innerHTML =
			`${tab.dateDetails.day}, ${tab.dateDetails.month} ${tab.dateDetails.date}`;
	}
	async function insertconnectionDetails() {
		const battery = await navigator.getBattery();
		const connection = navigator.onLine
			? "~" + navigator.connection.downlink + " Mbps "
			: "Offline ";
		const batteryHealth =
			(battery.level * 100).toFixed() + "% " +
			(battery.charging ? "Charging" : "Battery");
		document.getElementById("battery").innerHTML = `${connection} - ${batteryHealth}`;
		return { connection, battery: batteryHealth };
	}
	function getdateDetails() {
		var today = new Date();
		var dL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
		var mL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
		return { day: dL[today.getDay()], month: mL[today.getMonth()], date: today.getDate(), year: today.getFullYear() };
	}

	// ── Favicon: invert for dark mode ──
	function setFavicon() {
		const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
		document.querySelector("link[rel='icon']").href = isDark
			? "icons/icon32_white.png"
			: "icons/icon32.png";
	}

	setFavicon();
	window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', setFavicon);
	setInterval(setFavicon, 50);
})();
