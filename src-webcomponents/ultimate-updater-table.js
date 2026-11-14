/* <iob-ultimate-updater-table>: all Proxmox hosts, VMs and containers of an ultimate-updater instance with open
   updates, reboot hint, job state and buttons - optionally with CPU, RAM and disk load from the proxmox adapter.
   The buttons write the button states of the adapter directly through the connection of the host. */
import { IobWebComponent, defineWebComponent } from "@iobroker/web-components/element";

const TXT = {
	de: {
		system: "System",
		cpu: "CPU",
		ram: "RAM",
		disk: "Disk",
		upd: "Upd",
		action: "Aktion",
		checkAll: "Alle prüfen",
		updateAll: "Alle VMs/CTs updaten",
		securityOnly: "Nur mit Sicherheitsupdates",
		check: "Prüfen",
		update: "Update",
		reboot: "Neustart",
		running: "läuft",
		failed: "Fehler",
		interrupted: "abgebrochen",
		noConnection: "Keine Verbindung zum Ultimate Updater",
		bulk: "Sammel-Update läuft",
		jobRunning: "Ein Job läuft …",
		allRunning: "Alle prüfen läuft",
		of: "von ca.",
		job: { update: "Update", check: "Prüfung", other: "Job" },
		runs: "läuft …",
		confirmAll: "Alle VMs/CTs komplett aktualisieren (alle offenen Updates)?",
		confirmSec:
			"Nur VMs/CTs mit offenen Sicherheitsupdates aktualisieren – dort werden ALLE offenen Updates installiert?",
		confirmUpdate: name => `${name} aktualisieren?`,
		confirmReboot: name => `${name} jetzt neu starten?`,
		stoppedHint:
			" Es ist ausgeschaltet – der Ultimate Updater startet es dafür nur, wenn STOPPED_CONTAINER/STOPPED_VM in seiner update.conf aktiv ist.",
		ok: "OK",
		cancel: "Abbrechen",
		details: "Details",
		showLog: "Grund und Log anzeigen",
		loading: "Log wird geladen …",
		noLog: "Kein Log vorhanden",
		bulkJob: (target, failed) => `Sammel-Job ${target} ${failed ? "fehlgeschlagen" : "abgebrochen"}`,
		noTargets: "Keine Systeme gefunden",
		pickInstance: "Bitte eine ultimate-updater-Instanz wählen",
		security: "Sicherheitsupdates",
		normal: "weitere Updates",
		types: { host: "Host", lxc: "CT", vm: "VM" },
	},
	en: {
		system: "System",
		cpu: "CPU",
		ram: "RAM",
		disk: "Disk",
		upd: "Upd",
		action: "Action",
		checkAll: "Check all",
		updateAll: "Update all VMs/CTs",
		securityOnly: "Only with security updates",
		check: "Check",
		update: "Update",
		reboot: "Reboot",
		running: "running",
		failed: "failed",
		interrupted: "interrupted",
		noConnection: "No connection to Ultimate Updater",
		bulk: "Collective update running",
		jobRunning: "A job is running …",
		allRunning: "Check all running",
		of: "of about",
		job: { update: "Update", check: "Check", other: "Job" },
		runs: "running …",
		confirmAll: "Update all VMs/CTs completely (all open updates)?",
		confirmSec: "Update only VMs/CTs with open security updates – ALL open updates are installed there?",
		confirmUpdate: name => `Update ${name}?`,
		confirmReboot: name => `Reboot ${name} now?`,
		stoppedHint:
			" It is switched off – Ultimate Updater starts it for this only if STOPPED_CONTAINER/STOPPED_VM is active in its update.conf.",
		ok: "OK",
		cancel: "Cancel",
		details: "details",
		showLog: "Show reason and log",
		loading: "Loading log …",
		noLog: "No log available",
		bulkJob: (target, failed) => `Collective job ${target} ${failed ? "failed" : "interrupted"}`,
		noTargets: "No systems found",
		pickInstance: "Please choose an ultimate-updater instance",
		security: "security updates",
		normal: "other updates",
		types: { host: "Host", lxc: "CT", vm: "VM" },
	},
};

// Material Design Icons
const ICON = {
	check: "M9.5,3A6.5,6.5 0 0,1 16,9.5C16,11.11 15.41,12.59 14.44,13.73L14.71,14H15.5L20.5,19L19,20.5L14,15.5V14.71L13.73,14.44C12.59,15.41 11.11,16 9.5,16A6.5,6.5 0 0,1 3,9.5A6.5,6.5 0 0,1 9.5,3M9.5,5C7,5 5,7 5,9.5C5,12 7,14 9.5,14C12,14 14,12 14,9.5C14,7 12,5 9.5,5Z",
	update: "M5,20H19V18H5M19,9H15V3H9V9H5L12,16L19,9Z",
	reboot: "M12,4C14.1,4 16.1,4.8 17.6,6.3C20.7,9.4 20.7,14.5 17.6,17.6C15.8,19.5 13.3,20.2 10.9,19.9L11.4,17.9C13.1,18.1 14.9,17.5 16.2,16.2C18.5,13.9 18.5,10.1 16.2,7.7C15.1,6.6 13.5,6 12,6V10.6L7,5.6L12,0.6V4M6.3,17.6C3.7,15 3.3,11 5.1,7.9L6.6,9.4C5.5,11.6 5.9,14.4 7.8,16.2C8.3,16.7 8.9,17.1 9.6,17.4L9,19.4C8,19 7.1,18.4 6.3,17.6Z",
};

// the states of a target the table reads
const TARGET_FIELDS = [
	"id",
	"name",
	"type",
	"status",
	"reachable",
	"security_updates",
	"normal_updates",
	"reboot_required",
	"jobState",
	"jobUnit",
	"check_status",
	"skip_reason.code",
];
const JOB_FIELDS = ["unit", "state", "target", "type", "started_at", "finished_at"];
const GLOBAL = ["jobRunning", "info.connection", "summary.text", "bulk.active", "bulk.progress"];
const RUNNING = ["running", "pending", "starting"];
const DENSITY = { compact: 3, normal: 6, comfortable: 9 };

const esc = s =>
	String(s == null ? "" : s).replace(
		/[&<>"']/g,
		c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
	);

// a CSS color from the settings, or the default (no "url(", no ";" - it goes into a style sheet)
const color = (v, d) => (typeof v === "string" && /^[#a-zA-Z0-9(),.%\s-]+$/.test(v.trim()) && v.trim() ? v.trim() : d);

const num = (v, d) => (v === "" || v == null || isNaN(Number(v)) ? d : Number(v));

// job unit as the adapter stores it as object ID
const jobKey = unit => String(unit).replace(/[^a-zA-Z0-9_]/g, "_");

// duration in m:ss
const mmss = ms => {
	const s = Math.max(0, Math.round(ms / 1000));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// log of a job without the ASCII banner, systemd lines and empty lines
function cleanLog(log) {
	const lines = String(log || "").split("\n");
	const bannerEnd = lines.findIndex(l => /Ultimate Updater \d+\.\d+/.test(l));
	return lines
		.slice(bannerEnd >= 0 ? bannerEnd + 1 : 0)
		.map(l => l.replace(/\s+$/, ""))
		.filter(
			l =>
				l.trim() &&
				!/\.service[: ]/.test(l) &&
				!/^(There are an error during update|Please check output here or in logfile)$/.test(l.trim()),
		);
}

// the actual reason: first "E:" line, else a warning or hint, else the last line
function logReason(lines) {
	const pick =
		lines.find(l => /^E: /.test(l.trim())) ||
		lines.find(l => /^Err:/.test(l.trim())) ||
		lines.find(l => /not supported/i.test(l)) ||
		lines.find(l => /Skipped|failed|Fehler/i.test(l) && !/Error during update/.test(l)) ||
		lines.find(l => /^⚠/.test(l.trim()) && !/Error during update/.test(l)) ||
		lines[lines.length - 1] ||
		"";
	return pick.trim().replace(/^[^\w(]+\s*/u, "");
}

/**
 * The table element
 */
class UltimateUpdaterTable extends IobWebComponent {
	/**
	 * Shadow root and click handling
	 */
	constructor() {
		super();
		this.attachShadow({ mode: "open" });
		this.shadowRoot.innerHTML = '<style></style><div class="uu-card"></div>';
		this._ids = []; // states found below the instances (targets, jobs, proxmox)
		this._found = ""; // instance pair the IDs were found for
		this._hasState = new Set(); // all state IDs below the targets (buttons that exist)
		this._open = new Set(); // rows whose log is open
		this._logs = {}; // unit -> log text (loaded on demand)
		this._pending = new Map(); // button state -> time it was pressed
		this._ask = null; // confirmation shown: { text, id }
		this.shadowRoot.addEventListener("click", e => this._onClick(e));
	}

	/** Starts the search for targets and jobs and the timers */
	connectedCallback() {
		super.connectedCallback();
		// new or deleted systems and jobs: look again every two minutes
		this._discoverTimer = setInterval(() => void this._discover(true), 120000);
		// running jobs: the elapsed time in the head line moves on
		this._tick = setInterval(() => this._isRunning() && this.render(), 5000);
	}

	/** Stops the timers */
	disconnectedCallback() {
		clearInterval(this._discoverTimer);
		clearInterval(this._tick);
		super.disconnectedCallback && super.disconnectedCallback();
	}

	/** @returns {object} texts in the system language */
	get t() {
		return TXT[this.systemLang === "de" ? "de" : "en"];
	}

	/** @returns {string} the ultimate-updater instance */
	get uu() {
		const i = String((this.settings || {}).instance || "ultimate-updater.0");
		return /^ultimate-updater\.\d+$/.test(i) ? i : i.match(/^\d+$/) ? `ultimate-updater.${i}` : "";
	}

	/** @returns {string} the proxmox instance, empty when the load columns are off */
	get pve() {
		const s = this.settings || {};
		const i = String(s.pveInstance || "");
		if (!i || (s.showCpu === false && s.showRam === false && !s.showDisk)) {
			return "";
		}
		return /^proxmox\.\d+$/.test(i) ? i : i.match(/^\d+$/) ? `proxmox.${i}` : "";
	}

	/**
	 * @param {Record<string, unknown>} _settings settings
	 * @returns {string[]} all states the table shows
	 */
	getStateIds(_settings) {
		const uu = this.uu;
		if (!uu) {
			return [];
		}
		if (this._found !== `${uu}|${this.pve}`) {
			void this._discover(false);
		}
		return [...GLOBAL.map(g => `${uu}.${g}`), ...this._ids];
	}

	/**
	 * Finds the targets, jobs and proxmox guests of the instances and subscribes their states
	 *
	 * @param {boolean} again true for the regular repeat: only resubscribe when something changed
	 */
	async _discover(again) {
		const socket = this.socket;
		const uu = this.uu;
		if (!socket || !uu || this._discovering) {
			return;
		}
		const pve = this.pve;
		const key = `${uu}|${pve}`;
		this._discovering = true;
		try {
			const ids = [];
			const targetStates = await socket.getObjectViewSystem("state", `${uu}.targets.`, `${uu}.targets.香`);
			const has = new Set(Object.keys(targetStates));
			const targets = new Set();
			for (const id of has) {
				const rest = id.slice(uu.length + 9).split(".");
				targets.add(rest[0]);
			}
			for (const t of targets) {
				for (const f of TARGET_FIELDS) {
					const id = `${uu}.targets.${t}.${f}`;
					has.has(id) && ids.push(id);
				}
			}
			const jobStates = await socket.getObjectViewSystem("state", `${uu}.jobs.`, `${uu}.jobs.香`);
			for (const id of Object.keys(jobStates)) {
				if (JOB_FIELDS.some(f => id.endsWith(`.${f}`)) && id.split(".").length === 5) {
					ids.push(id);
				}
			}
			if (pve) {
				const pveStates = await socket.getObjectViewSystem("state", `${pve}.`, `${pve}.香`);
				for (const id of Object.keys(pveStates)) {
					const rest = id.slice(pve.length + 1);
					if (
						/^(lxc|qemu)\.[^.]+\.(vmid|cpu|mem_lev|disk_lev|status)$/.test(rest) ||
						/^node_[^.]+\.(cpu|memory\.used_lev)$/.test(rest)
					) {
						ids.push(id);
					}
				}
			}
			const changed = !again || this._found !== key || ids.join() !== this._ids.join();
			this._hasState = has;
			this._ids = ids;
			this._found = key;
			if (changed) {
				// the base class subscribes what getStateIds names when the settings are set again
				this.settings = { ...this.settings };
			}
		} catch (e) {
			this._error = String(e && e.message ? e.message : e);
			this.render();
		} finally {
			this._discovering = false;
		}
	}

	/**
	 * @param {string} id state ID
	 * @returns {unknown} value of a subscribed state
	 */
	val(id) {
		const s = this.states[id];
		return s ? s.val : null;
	}

	/** @returns {boolean} a job is running (the head line shows its time) */
	_isRunning() {
		const uu = this.uu;
		return !!uu && (this.val(`${uu}.jobRunning`) === true || this._jobs().running.length > 0);
	}

	/** @returns {{running: object[], lastAllMs: number, all: object[]}} jobs from the job states */
	_jobs() {
		const uu = this.uu;
		const running = [];
		const all = [];
		let lastAllMs = 0;
		let lastAllStart = 0;
		for (const id of this._ids) {
			if (!id.startsWith(`${uu}.jobs.`) || !id.endsWith(".unit")) {
				continue;
			}
			const p = id.slice(0, -5);
			const state = this.val(`${p}.state`);
			const target = String(this.val(`${p}.target`) || "");
			const type = this.val(`${p}.type`);
			const started = Date.parse(this.val(`${p}.started_at`) || "") || 0;
			all.push({ unit: this.val(id), state, target, type, started });
			if (RUNNING.includes(state)) {
				running.push({ target, type, started });
			} else if (target === "all-systems" && type === "check" && /^completed/.test(String(state))) {
				const finished = Date.parse(this.val(`${p}.finished_at`) || "") || 0;
				if (finished > started && started > lastAllStart) {
					lastAllStart = started;
					lastAllMs = finished - started;
				}
			}
		}
		return { running, lastAllMs, all };
	}

	/** @returns {Map<string, string>} vmid ("123", "host:pve") -> path in the proxmox adapter */
	_pvePaths() {
		const pve = this.pve;
		const map = new Map();
		if (!pve) {
			return map;
		}
		for (const id of this._ids) {
			if (!id.startsWith(`${pve}.`)) {
				continue;
			}
			if (id.endsWith(".vmid")) {
				map.set(String(this.val(id)), id.slice(0, -5));
			} else if (/\.node_[^.]+\.cpu$/.test(id)) {
				const p = id.slice(0, -4);
				map.set(`host:${p.split(".")[2].replace(/^node_/, "")}`, p);
			}
		}
		return map;
	}

	/** @returns {object[]} the systems, sorted and filtered as the settings say */
	_devices() {
		const s = this.settings || {};
		const uu = this.uu;
		const pve = this._pvePaths();
		const devices = [];
		for (const id of this._ids) {
			if (!id.startsWith(`${uu}.targets.`) || !id.endsWith(".id") || id.split(".").length !== 5) {
				continue;
			}
			const p = id.slice(0, -3);
			const v = f => this.val(`${p}.${f}`);
			const type = v("type");
			const vmid = String(this.val(id) || "");
			const dev = {
				path: p,
				name: v("name") || vmid,
				vmid,
				type,
				reachable: v("reachable") === true,
				stopped:
					v("status") === "stopped" ||
					v("check_status") === "stopped" ||
					/STOPPED/.test(String(v("skip_reason.code") || "")),
				sec: Number(v("security_updates")) || 0,
				normal: Number(v("normal_updates")) || 0,
				known: v("security_updates") !== null || v("normal_updates") !== null,
				reboot: v("reboot_required") === true,
				job: v("jobState"),
				jobUnit: v("jobUnit"),
				hasReboot: this._hasState.has(`${p}.reboot`),
			};
			const pp = pve.get(vmid);
			if (pp) {
				dev.cpu = this.val(`${pp}.cpu`);
				dev.ram = this.val(type === "host" ? `${pp}.memory.used_lev` : `${pp}.mem_lev`);
				// VMs without guest agent report 0 for the disk
				const disk = this.val(`${pp}.disk_lev`);
				dev.disk = type === "host" || (type === "vm" && !Number(disk)) ? null : disk;
			}
			if (s.hosts === false && type === "host") {
				continue;
			}
			if (s.stopped === false && dev.stopped) {
				continue;
			}
			if (s.onlyWithUpdates && dev.sec + dev.normal === 0 && !dev.reboot) {
				continue;
			}
			devices.push(dev);
		}
		const byName = (a, b) =>
			String(a.name).localeCompare(String(b.name), this.systemLang, { numeric: true, sensitivity: "base" });
		const sort = s.sort || "status";
		devices.sort((a, b) => {
			if (sort === "name") {
				return byName(a, b);
			}
			if (sort === "updates") {
				return b.sec - a.sec || b.sec + b.normal - (a.sec + a.normal) || byName(a, b);
			}
			// running ones first, switched off ones at the end; hosts first, then by name
			return a.stopped - b.stopped || (b.type === "host") - (a.type === "host") || byName(a, b);
		});
		return devices;
	}

	/**
	 * Button HTML
	 *
	 * @param {string} label text (tooltip for icon buttons)
	 * @param {string} id state the button writes true to
	 * @param {string} cls classes
	 * @param {boolean} disabled not clickable
	 * @param {string} confirm question before writing, empty for none
	 * @param {string} icon icon key for icon buttons, empty for a text button
	 * @returns {string} HTML
	 */
	_button(label, id, cls, disabled, confirm, icon) {
		const pending = this._pending.has(id);
		const content = pending ? "…" : icon ? `<svg viewBox="0 0 24 24"><path d="${ICON[icon]}"/></svg>` : esc(label);
		return `<button class="uu-btn ${icon ? "ico " : ""}${cls}" data-id="${esc(id)}"${
			confirm ? ` data-confirm="${esc(confirm)}"` : ""
		} title="${esc(label)}"${disabled || pending ? " disabled" : ""}>${content}</button>`;
	}

	/**
	 * Load as a coloured number: from "warn" orange, from "crit" red
	 *
	 * @param {unknown} v percent
	 * @returns {string} HTML
	 */
	_load(v) {
		if (v === null || v === undefined || v === "" || isNaN(Number(v))) {
			return '<span class="uu-na">–</span>';
		}
		const s = this.settings || {};
		const n = Math.round(Number(v));
		const cls = n >= num(s.critAt, 85) ? " hi" : n >= num(s.warnAt, 60) ? " mid" : "";
		return `<span class="uu-load${cls}">${n}%</span>`;
	}

	/**
	 * Reason and log of a job
	 *
	 * @param {string} unit job unit
	 * @returns {string} HTML
	 */
	_errorContent(unit) {
		const t = this.t;
		if (!(unit in this._logs)) {
			void this._loadLog(unit);
			return `<div class="uu-reason muted">${esc(t.loading)}</div>`;
		}
		const lines = cleanLog(this._logs[unit]);
		if (!lines.length) {
			return `<div class="uu-reason muted">${esc(t.noLog)}</div>`;
		}
		const n = num((this.settings || {}).logLines, 20);
		return `<div class="uu-reason">${esc(logReason(lines))}</div><pre>${esc(lines.slice(-n).join("\n"))}</pre>`;
	}

	/**
	 * Reads the log of a job once (logs are big, so they are not subscribed)
	 *
	 * @param {string} unit job unit
	 */
	async _loadLog(unit) {
		if (this._loading === unit || !this.socket) {
			return;
		}
		this._loading = unit;
		try {
			const st = await this.socket.getState(`${this.uu}.jobs.${jobKey(unit)}.log`);
			this._logs[unit] = st ? String(st.val || "") : "";
		} catch {
			this._logs[unit] = "";
		}
		this._loading = null;
		this.render();
	}

	/**
	 * Clicks: buttons, log toggles, confirmation
	 *
	 * @param {MouseEvent} e the click
	 */
	async _onClick(e) {
		if (this.editMode) {
			return;
		}
		const el = e.target.closest("[data-id],[data-toggle],[data-ask]");
		if (!el) {
			return;
		}
		if (el.dataset.toggle) {
			const k = el.dataset.toggle;
			this._open.has(k) ? this._open.delete(k) : this._open.add(k);
			if (el.dataset.unit) {
				delete this._logs[el.dataset.unit]; // read the newest log when opening
			}
			this.render();
			return;
		}
		if (el.dataset.ask) {
			const ask = this._ask;
			this._ask = null;
			if (el.dataset.ask === "ok" && ask) {
				await this._press(ask.id);
			}
			this.render();
			return;
		}
		if (el.disabled) {
			return;
		}
		const confirm = el.dataset.confirm;
		if (confirm && (this.settings || {}).confirm !== false) {
			this._ask = { text: confirm, id: el.dataset.id };
			this.render();
			return;
		}
		await this._press(el.dataset.id);
	}

	/**
	 * Writes true to a button state of the adapter
	 *
	 * @param {string} id state ID
	 */
	async _press(id) {
		this._pending.set(id, Date.now());
		this.render();
		await this.setState(id, true);
		// the adapter resets the button; show "…" a few seconds, a job state takes over from there
		setTimeout(() => {
			this._pending.delete(id);
			this.render();
		}, 4000);
	}

	/** @returns {string} the style sheet for the settings */
	_css() {
		const s = this.settings || {};
		const scale = num(s.fontScale, 100) / 100;
		const pad = DENSITY[s.density] ?? DENSITY.normal;
		const cUpd = color(s.colorUpdate, "#1976D2");
		const cCheck = color(s.colorCheck, "#455a64");
		const cSec = color(s.colorSecurity, "#c62828");
		const cReboot = color(s.colorReboot, "#e65100");
		const cWarn = color(s.colorWarn, "#ff9800");
		const cCrit = color(s.colorCrit, "#f44336");
		const cOk = color(s.colorOk, "#4caf50");
		return `
:host { display: block; width: 100%; height: 100%; overflow: auto; color: var(--iob-text, inherit); }
* { box-sizing: border-box; }
.uu-card { width: 100%; font-family: var(--iob-font-family, sans-serif); font-size: ${(16 * scale).toFixed(1)}px; line-height: 1.2; position: relative; }
.uu-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 6px; }
.uu-summary { font-size: 0.85em; opacity: 0.8; }
.uu-summary.busy { color: ${cWarn}; opacity: 1; }
.uu-global { display: flex; flex-wrap: wrap; gap: 4px; }
.uu-table { width: 100%; border-collapse: collapse; font-size: 0.9em; }
.uu-table th { padding: 4px 5px; text-align: left; font-size: 0.75em; opacity: 0.5; text-transform: uppercase; font-weight: 600; border-bottom: 1px solid color-mix(in srgb, currentColor 25%, transparent); white-space: nowrap; }
.uu-table th.c { text-align: center; }
.uu-table th.r { text-align: right; }
.uu-table td { padding: ${pad}px 5px; border-bottom: 1px solid color-mix(in srgb, currentColor 6%, transparent); vertical-align: middle; }
${s.zebra ? ".uu-table tbody tr.uu-row:nth-of-type(even) td { background: color-mix(in srgb, currentColor 4%, transparent); }" : ""}
.uu-table td.c { text-align: center; white-space: nowrap; }
.uu-table td.r { white-space: nowrap; width: 1%; }
.uu-off td:not(.r) { opacity: 0.45; }
.uu-dot { height: 7px; width: 7px; border-radius: 50%; display: inline-block; margin-right: 6px; vertical-align: middle; }
.uu-dot.on { background-color: ${cOk}; }
.uu-dot.down { background-color: ${cCrit}; }
.uu-dot.stop { background-color: #9e9e9e; }
.uu-type { font-size: 0.7em; opacity: 0.5; margin-left: 4px; }
.uu-sec { font-weight: bold; color: ${cCrit}; }
.uu-upd { font-weight: bold; color: ${cWarn}; }
.uu-zero { color: ${cOk}; opacity: 0.7; }
.uu-na { opacity: 0.4; }
.uu-load { font-size: 0.85em; opacity: 0.75; }
.uu-load.mid { color: ${cWarn}; opacity: 1; }
.uu-load.hi { color: ${cCrit}; opacity: 1; font-weight: bold; }
.uu-flag { font-size: 0.75em; padding: 1px 5px; border-radius: 8px; margin-left: 4px; white-space: nowrap; }
.uu-flag.reboot { background: color-mix(in srgb, ${cWarn} 20%, transparent); color: ${cWarn}; }
.uu-flag.run { background: rgba(25,118,210,0.25); color: #64b5f6; }
.uu-flag.fail { background: color-mix(in srgb, ${cCrit} 20%, transparent); color: ${cCrit}; }
.uu-toggle { cursor: pointer; }
.uu-btn { font: inherit; background-color: ${cUpd}; color: #fff; border: none; padding: 4px 8px; border-radius: 3px; cursor: pointer; font-size: 0.8em; margin-left: 3px; }
.uu-head .uu-btn { margin-left: 0; }
.uu-btn.check { background-color: ${cCheck}; }
.uu-btn.reboot { background-color: ${cReboot}; }
.uu-btn.sec { background-color: ${cSec}; }
.uu-btn.stopped { background-color: #5a5a5a; color: #ddd; }
.uu-btn:disabled { background-color: #333; opacity: 0.4; cursor: not-allowed; }
.uu-btn.ico { width: 26px; height: 26px; padding: 0; margin-left: 4px; display: inline-flex; align-items: center; justify-content: center; vertical-align: middle; }
.uu-btn.ico svg { width: 16px; height: 16px; fill: currentColor; }
.uu-logrow td { padding-top: 0; }
.uu-logwrap { width: 0; min-width: 100%; overflow: hidden; }
.uu-reason { margin-top: 4px; font-size: 0.8em; color: ${cCrit}; white-space: normal; overflow-wrap: anywhere; }
.uu-reason.muted { color: inherit; opacity: 0.6; }
pre { margin: 4px 0 0; padding: 6px; max-height: 220px; overflow: auto; font-size: 0.72em; line-height: 1.35; background: rgba(0,0,0,0.3); border-radius: 4px; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-all; }
.uu-global-log { margin-top: 8px; }
.uu-global-log .uu-flag { display: inline-block; margin: 0; padding: 1px 7px; }
.uu-bar { width: 100%; height: 3px; margin: -2px 0 6px; background: color-mix(in srgb, currentColor 8%, transparent); border-radius: 2px; overflow: hidden; }
.uu-bar span { display: block; height: 100%; background: ${cWarn}; transition: width 1s linear; }
.uu-msg { padding: 12px; text-align: center; opacity: 0.7; }
.uu-ask { position: sticky; top: 0; z-index: 2; margin-bottom: 8px; padding: 10px; border-radius: 6px; background: var(--iob-paper, #2b374e); border: 1px solid color-mix(in srgb, currentColor 30%, transparent); box-shadow: 0 4px 16px rgba(0,0,0,.35); }
.uu-ask p { margin: 0 0 8px; font-size: 0.9em; }
.uu-ask div { display: flex; justify-content: flex-end; gap: 6px; }
.uu-ask .uu-btn { margin: 0; padding: 5px 12px; }
`;
	}

	/** Draws the table */
	render() {
		const style = this.shadowRoot.querySelector("style");
		const css = this._css();
		if (style.textContent !== css) {
			style.textContent = css;
		}
		const root = this.shadowRoot.querySelector(".uu-card");
		const html = this._html();
		if (root.innerHTML !== html) {
			// keep the scroll position of open logs
			const scroll = [...root.querySelectorAll("pre")].map(p => p.scrollTop);
			root.innerHTML = html;
			root.querySelectorAll("pre").forEach((p, i) => (p.scrollTop = scroll[i] || 0));
		}
	}

	/** @returns {string} the HTML of the table */
	_html() {
		const t = this.t;
		const s = this.settings || {};
		const uu = this.uu;
		if (!uu) {
			return `<div class="uu-msg">${esc(t.pickInstance)}</div>`;
		}
		const v = id => this.val(`${uu}.${id}`);
		const jobRunning = v("jobRunning") === true;
		const bulkActive = v("bulk.active") === true;
		const connected = v("info.connection") === true;
		const devices = this._devices();
		const { running, lastAllMs, all } = this._jobs();
		const names = {};
		for (const d of devices) {
			names[d.vmid] = d.name;
			names[d.vmid.replace(/^host:/, "")] = d.name;
		}
		let progress = "";
		let bar = -1;
		const allJob = running.find(j => j.target === "all-systems");
		if (allJob) {
			const elapsed = allJob.started ? Date.now() - allJob.started : 0;
			progress = `${t.allRunning}: ${mmss(elapsed)}${lastAllMs ? ` ${t.of} ${mmss(lastAllMs)}` : ""}`;
			if (lastAllMs) {
				bar = Math.min(99, Math.round((elapsed / lastAllMs) * 100));
			}
		} else if (running.length) {
			progress = `${running
				.map(j => `${t.job[j.type] || t.job.other}: ${names[j.target] || j.target}`)
				.join(", ")} ${t.runs}`;
		}
		const busy = jobRunning || bulkActive || !connected;
		const icons = s.buttonStyle !== "text";
		const showHead = s.summary !== false || s.globalButtons !== false;
		let html = "";

		if (this._ask) {
			html += `<div class="uu-ask"><p>${esc(this._ask.text)}</p><div><button class="uu-btn check" data-ask="cancel">${esc(
				t.cancel,
			)}</button><button class="uu-btn" data-ask="ok">${esc(t.ok)}</button></div></div>`;
		}
		if (showHead) {
			html += '<div class="uu-head">';
			if (s.summary !== false) {
				const text = !connected
					? t.noConnection
					: bulkActive
						? `${t.bulk}: ${v("bulk.progress") || "…"}`
						: jobRunning || progress
							? progress || t.jobRunning
							: v("summary.text") || "";
				html += `<span class="uu-summary ${busy ? "busy" : ""}">${esc(text)}</span>`;
			}
			if (s.globalButtons !== false) {
				const confirm = s.confirm !== false;
				html += '<span class="uu-global">';
				html += this._button(t.checkAll, `${uu}.checkAll`, "check", busy, "", "");
				html += this._button(t.updateAll, `${uu}.updateAllVmsCts`, "", busy, confirm ? t.confirmAll : "", "");
				html += this._button(
					t.securityOnly,
					`${uu}.updateSecurityOnly`,
					"sec",
					busy,
					confirm ? t.confirmSec : "",
					"",
				);
				html += "</span>";
			}
			html += "</div>";
			if (s.summary !== false && bar >= 0 && !bulkActive) {
				html += `<div class="uu-bar"><span style="width:${bar}%"></span></div>`;
			}
		}

		if (!devices.length) {
			return `${html}<div class="uu-msg">${esc(this._found ? t.noTargets : "…")}</div>`;
		}

		const pveOn = !!this.pve;
		const cols = [];
		if (pveOn && s.showCpu !== false) {
			cols.push(["cpu", t.cpu]);
		}
		if (pveOn && s.showRam !== false) {
			cols.push(["ram", t.ram]);
		}
		if (pveOn && s.showDisk) {
			cols.push(["disk", t.disk]);
		}
		const span = 3 + cols.length;
		html += `<table class="uu-table"><thead><tr><th style="width:100%">${esc(t.system)}</th>${cols
			.map(c => `<th class="c">${esc(c[1])}</th>`)
			.join("")}<th class="c">${esc(t.upd)}</th><th class="r">${esc(t.action)}</th></tr></thead><tbody>`;

		for (const dev of devices) {
			const dot = dev.stopped ? "stop" : dev.reachable ? "on" : "down";
			let flags = "";
			if (dev.reboot) {
				flags += `<span class="uu-flag reboot">${esc(t.reboot)}</span>`;
			}
			if (RUNNING.includes(dev.job)) {
				flags += `<span class="uu-flag run">${esc(t.running)}</span>`;
			}
			const failed = dev.job === "failed" || dev.job === "interrupted";
			const canLog = failed && s.errorLog !== false && dev.jobUnit;
			if (failed) {
				const text = dev.job === "failed" ? t.failed : t.interrupted;
				flags += canLog
					? `<span class="uu-flag fail uu-toggle" title="${esc(t.showLog)}" data-toggle="${esc(dev.path)}" data-unit="${esc(
							dev.jobUnit,
						)}">${esc(text)} ${this._open.has(dev.path) ? "▴" : "▾"}</span>`
					: `<span class="uu-flag fail">${esc(text)}</span>`;
			}

			let upd;
			if (!dev.known) {
				upd = '<span class="uu-na">–</span>';
			} else if (dev.sec + dev.normal === 0) {
				upd = '<span class="uu-zero">0</span>';
			} else {
				upd = dev.sec > 0 ? `<span class="uu-sec" title="${esc(t.security)}">${dev.sec}</span>` : "";
				upd += dev.sec > 0 && dev.normal > 0 ? " / " : "";
				upd += dev.normal > 0 ? `<span class="uu-upd" title="${esc(t.normal)}">${dev.normal}</span>` : "";
			}

			const disabled = busy || (!dev.reachable && !dev.stopped);
			const off = dev.stopped ? " stopped" : "";
			const hint = dev.stopped ? t.stoppedHint : "";
			const confirm = s.confirm !== false || dev.stopped;
			let actions = "";
			if (s.checkButton !== false) {
				actions += this._button(
					t.check,
					`${dev.path}.checkNow`,
					`check${off}`,
					disabled,
					"",
					icons ? "check" : "",
				);
			}
			if (s.updateButton !== false) {
				actions += this._button(
					t.update,
					`${dev.path}.updateNow`,
					off.trim(),
					disabled || (dev.known && dev.sec + dev.normal === 0),
					confirm ? `${t.confirmUpdate(dev.name)}${hint}` : "",
					icons ? "update" : "",
				);
			}
			if (s.rebootButton !== false && dev.hasReboot) {
				actions += this._button(
					t.reboot,
					`${dev.path}.reboot`,
					`reboot${off}`,
					disabled,
					t.confirmReboot(dev.name),
					icons ? "reboot" : "",
				);
			}
			const typeLabel = t.types[dev.type] || dev.type || "";
			const idLabel = s.showVmid !== false && /^\d+$/.test(dev.vmid) ? ` ${dev.vmid}` : "";
			const loadCells = cols
				.map(c => `<td class="c">${dev.stopped ? '<span class="uu-na">–</span>' : this._load(dev[c[0]])}</td>`)
				.join("");
			html += `<tr class="uu-row${dev.stopped || !dev.reachable ? " uu-off" : ""}"><td><span class="uu-dot ${dot}"></span>${esc(
				dev.name,
			)}${s.showType !== false ? `<span class="uu-type">${esc(typeLabel)}${esc(idLabel)}</span>` : ""}${flags}</td>${loadCells}<td class="c">${upd}</td><td class="r">${actions}</td></tr>`;
			if (canLog && this._open.has(dev.path)) {
				html += `<tr class="uu-logrow"><td colspan="${span}"><div class="uu-logwrap">${this._errorContent(
					dev.jobUnit,
				)}</div></td></tr>`;
			}
		}
		html += "</tbody></table>";

		// collective jobs ("check all") that belong to no single system
		if (s.globalJobLog !== false) {
			const known = new Set();
			for (const d of devices) {
				known.add(d.vmid);
				known.add(d.vmid.replace(/^host:/, ""));
			}
			let last = null;
			for (const j of all) {
				if (known.has(j.target) || !j.unit) {
					continue;
				}
				if (!last || j.started > last.started) {
					last = j;
				}
			}
			if (last && (last.state === "failed" || last.state === "interrupted")) {
				const k = `job:${last.unit}`;
				html += `<div class="uu-global-log"><span class="uu-flag fail uu-toggle" data-toggle="${esc(k)}" data-unit="${esc(
					last.unit,
				)}">${esc(t.bulkJob(last.target, last.state === "failed"))} – ${esc(t.details)} ${this._open.has(k) ? "▴" : "▾"}</span>${
					this._open.has(k) ? this._errorContent(last.unit) : ""
				}</div>`;
			}
		}
		return html;
	}
}

defineWebComponent("iob-ultimate-updater-table", UltimateUpdaterTable);
