"use strict";

/**
 * Status report as text, built like the status mail of Ultimate Updater (status-model.sh):
 * updates grouped per node, then current, reboot required, not reachable, errors,
 * unsupported, not checked and skipped targets. Headings in the ioBroker system language.
 */

const SEPARATOR = "----------------------------";
const LINUX_UPDATERS = ["apt", "debian", "dnf", "pkg", "pacman", "apk", "yum", "ha"];
const LINUX_OS = [
	"linux",
	"debian",
	"ubuntu",
	"freebsd",
	"pfsense",
	"fedora",
	"centos",
	"rhel",
	"rocky",
	"alma",
	"opensuse",
	"suse",
	"arch",
	"alpine",
	"gentoo",
	"home assistant",
	"haos",
];

/**
 * Icon per target as in the original: host, external, LXC, Windows VM, Linux VM, unknown VM.
 *
 * @param {import("./types").ApiData} t - target
 * @returns {string} icon
 */
function icon(t) {
	if (t.type === "host") {
		return "🖥️";
	}
	if (t.type === "lxc") {
		return "🐧";
	}
	if (t.type !== "vm") {
		return "🌐";
	}
	const os = [t.os, t.os_version, t.os_display].filter(Boolean).join(" ").toLowerCase();
	const updater = String(t.updater || "").toLowerCase();
	if (os.includes("windows") || updater === "windows-update") {
		return "🪟";
	}
	if (LINUX_OS.some(m => os.includes(m)) || LINUX_UPDATERS.includes(updater)) {
		return "🐧";
	}
	return "❔";
}

/**
 * "101 · NAS" for guests, the node name for hosts.
 *
 * @param {import("./types").ApiData} t - target
 * @returns {string} display name
 */
function label(t) {
	const id = String(t.id || "");
	if (t.type === "host" || id.startsWith("host:")) {
		return String(t.node || id.replace(/^host:/, ""));
	}
	const short = id.replace(/^(lxc|vm|guest|external):/, "");
	return t.name && t.name !== short ? `${short} · ${t.name}` : short;
}

/**
 * @param {import("./types").ApiData} t - target
 * @returns {number|null} pending updates or null if unknown
 */
function available(t) {
	const a = t.updates && typeof t.updates.available === "number" ? t.updates.available : null;
	if (a !== null) {
		return a;
	}
	if (typeof t.security_updates === "number" || typeof t.normal_updates === "number") {
		return (Number(t.security_updates) || 0) + (Number(t.normal_updates) || 0);
	}
	return null;
}

/**
 * @param {import("./types").ApiData} t - target
 * @param {import("./types").ApiData} T - texts of the system language
 * @returns {string} reason why the check was skipped
 */
function skipText(t, T) {
	const code = String((t.skip_reason && t.skip_reason.code) || "");
	if (/STOPPED/.test(code) || t.status === "stopped") {
		return T.repStopped;
	}
	if (/PAUSED/.test(code)) {
		return T.repPaused;
	}
	return T.repSkipped;
}

/**
 * Builds the report.
 *
 * @param {import("./types").ApiData[]} targets - targets from /api/status
 * @param {import("./types").ApiData} T - texts of the system language (lib/i18n.js)
 * @returns {string} report text
 */
function buildReport(targets, T) {
	const updates = [];
	const current = [];
	const reboots = [];
	const offline = [];
	const errors = [];
	const unsupported = [];
	const notChecked = [];
	const skipped = [];
	let total = 0;
	let known = false;

	for (const t of targets) {
		const status = String(t.check_status || "");
		const count = available(t);
		// only current checks count – a shut down VM may still carry an old update count
		const countable = status
			? ["ok", "updates_available"].includes(status)
			: t.reachable !== false && t.status !== "stopped" && !t.skip_reason;
		if (countable && count !== null) {
			known = true;
			total += count;
			if (count > 0) {
				updates.push(t);
			} else if (status === "ok") {
				current.push(t);
			}
		}
		if (t.reboot_required === true) {
			reboots.push(t);
		}
		if (t.skip_reason || t.status === "stopped") {
			skipped.push(t);
		} else if (status === "offline" || t.reachable === false) {
			offline.push(t);
		} else if (status === "unsupported") {
			unsupported.push(t);
		} else if (status === "error") {
			const e = t.error || {};
			errors.push([t, typeof e === "object" ? e.message || e.code || "" : String(e)]);
		} else if (["not_checked", "skipped", "stopped"].includes(status)) {
			notChecked.push(t);
		}
	}

	const split = t =>
		typeof t.security_updates === "number" || typeof t.normal_updates === "number"
			? [
					`${T.repSecurity}: ${Number(t.security_updates) || 0}`,
					`${T.repNormal}: ${Number(t.normal_updates) || 0}`,
				]
			: [`⬆️ ${available(t) || 0} ${T.repUpdates}`];

	const lines = [T.repTitle, "=".repeat(T.repTitle.length), ""];
	if (updates.length) {
		lines.push(`${T.repAvailable}:`);
		// grouped per node, host first
		const nodes = [];
		const byNode = {};
		for (const t of updates) {
			const node = String(t.node || "-");
			if (!byNode[node]) {
				byNode[node] = [];
				nodes.push(node);
			}
			byNode[node].push(t);
		}
		for (const node of nodes) {
			const list = byNode[node];
			// like the original: show the host of a node with updates even if it has none itself
			const host =
				list.find(t => t.type === "host") ||
				targets.find(
					t =>
						t.type === "host" &&
						String(t.node || "-") === node &&
						t.reachable !== false &&
						["ok", "updates_available", ""].includes(String(t.check_status || "")),
				);
			lines.push("");
			if (host) {
				lines.push(`🖥️ ${node}`, ...split(host));
				if (host.reboot_required === true) {
					lines.push(`🔄 ${T.repReboot}`);
				}
			} else {
				lines.push(`🖥️ ${node}`, `⬆️ ${list.reduce((s, t) => s + (available(t) || 0), 0)} ${T.repUpdates}`);
			}
			lines.push(SEPARATOR);
			for (const t of list.filter(x => x.type !== "host")) {
				lines.push(`${icon(t)} ${label(t)}`, ...split(t));
				if (t.reboot_required === true) {
					lines.push(`🔄 ${T.repReboot}`);
				}
				lines.push(SEPARATOR);
			}
		}
	} else {
		lines.push(`${T.repAvailable}: ${T.repNone}`);
	}
	if (known) {
		lines.push("", `${T.repTotal}: ${total}`);
	}
	const section = (title, items, render) => {
		if (items.length) {
			lines.push("", `${title}:`);
			for (const item of items) {
				lines.push(...render(item));
			}
		}
	};
	section(T.repCurrent, current, t => [`✅ ${icon(t)} ${label(t)}`, `   ${T.repNoUpdates}`]);
	section(T.repReboot, reboots, t => [`🔄 ${label(t)}`]);
	section(T.repOffline, offline, t => [`⚠️ ${icon(t)} ${label(t)}`]);
	section(T.repErrors, errors, ([t, msg]) => [`⚠️ ${icon(t)} ${label(t)}${msg ? `: ${msg}` : ""}`]);
	section(T.repUnsupported, unsupported, t => [`⚠️ ${label(t)}`]);
	section(T.repNotChecked, notChecked, t => [`⚠️ ${label(t)}`]);
	section(T.repSkippedTitle, skipped, t => [`💤 ${label(t)}`, `   ${skipText(t, T)}`]);
	return lines.join("\n");
}

module.exports = { buildReport, icon, label };
