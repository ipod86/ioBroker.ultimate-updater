"use strict";

/*
 * Created with @iobroker/create-adapter v3.1.5
 *
 * Reads the update status of all Proxmox hosts, LXC containers and VMs from
 * BassT23's Ultimate Updater (https://github.com/BassT23/Proxmox) and offers
 * buttons to check/update single targets or all of them.
 */

const utils = require("@iobroker/adapter-core");
const { UuClient, BUSY_STATES, FAILURE_STATES } = require("./lib/uu-client");

const MAX_TIMEOUT_S = 2147483; // setTimeout limit (~24.8 days)

class UltimateUpdater extends utils.Adapter {
	/**
	 * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
	 */
	constructor(options) {
		super({
			...options,
			name: "ultimate-updater",
		});
		this.on("ready", this.onReady.bind(this));
		this.on("stateChange", this.onStateChange.bind(this));
		this.on("unload", this.onUnload.bind(this));

		this.client = null;
		this.refreshTimer = null;
		this.pollTimer = null;
		this.jobRunning = false;
		this.busy = Promise.resolve(); // serialises refresh/poll/actions
		/** target key → target data of the last refresh */
		this.targets = new Map();
		this.unloading = false;
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		await this.setState("info.connection", false, true);

		if (!this.config.ip || !this.config.username || !this.config.password) {
			this.log.error("Please configure IP address, user name and password of the Ultimate Updater Web UI.");
			return;
		}
		try {
			this.client = new UuClient(this.config);
		} catch (e) {
			this.log.error(`Invalid address "${this.config.ip}:${this.config.port}": ${e.message}`);
			return;
		}

		await this.createStaticObjects();
		this.subscribeStates("*");

		await this.refreshStatus();
		this.scheduleRefresh();
		this.schedulePoll();
	}

	// ── helpers ──

	/**
	 * Returns the API client (only null before onReady/after unload).
	 *
	 * @returns {UuClient} client
	 */
	api() {
		if (!this.client) {
			throw new Error("Adapter is not connected");
		}
		return this.client;
	}

	/**
	 * Clamps an interval from the config to a valid range.
	 *
	 * @param {any} value - configured value
	 * @param {number} def - default value
	 * @param {number} min - minimum
	 * @returns {number} value in the same unit
	 */
	clamp(value, def, min) {
		const n = Number(value);
		return Math.min(Math.max(Number.isFinite(n) && n > 0 ? n : def, min), MAX_TIMEOUT_S);
	}

	/**
	 * Runs the task after all previously queued tasks (no parallel API access).
	 *
	 * @param {() => Promise<any>} task - task
	 * @returns {Promise<any>} task result
	 */
	queue(task) {
		const run = this.busy.then(task, task);
		this.busy = run.catch(() => {});
		return run;
	}

	/**
	 * Object id part from free text (same scheme as the original script: only [a-zA-Z0-9_]).
	 *
	 * @param {any} s - text
	 * @returns {string} sanitised id part
	 */
	sanitize(s) {
		return String(s)
			.replace(this.FORBIDDEN_CHARS, "_")
			.replace(/[^a-zA-Z0-9_]/g, "_");
	}

	/**
	 * Name alone is not unique (several CTs may share a name) → name + id.
	 *
	 * @param {any} t - target
	 * @returns {string} key
	 */
	targetKey(t) {
		return `${this.sanitize(t.name || t.id)}_${this.sanitize(t.id)}`;
	}

	/**
	 * @param {string} id - channel id
	 * @param {string} name - name
	 */
	async channel(id, name) {
		await this.extendObject(id, { type: "channel", common: { name }, native: {} });
	}

	/**
	 * Role for a field of the API payload, chosen by name and type.
	 *
	 * @param {string} key - field name
	 * @param {"boolean" | "number" | "string"} type - value type
	 * @param {any} val - current value
	 * @returns {string} state role
	 */
	roleFor(key, type, val) {
		if (type === "boolean") {
			return key === "reachable" ? "indicator.reachable" : "indicator";
		}
		const isTime = /(^|_)(time|timestamp|at|check|update|started|finished|mtime)$/.test(key);
		if (type === "number") {
			// official role value.time = getTime() (ms); epoch seconds stay a plain value
			return isTime && key !== "exit_code" && Number(val) > 1e12 ? "value.time" : "value";
		}
		// official role date = string parsable by new Date()
		return isTime && typeof val === "string" && !Number.isNaN(Date.parse(val)) ? "date" : "text";
	}

	/**
	 * Creates/updates a read-only state and sets its value.
	 *
	 * @param {string} id - state id
	 * @param {string} name - name
	 * @param {any} val - value
	 * @param {Partial<ioBroker.StateCommon>} [common] - common overrides
	 */
	async value(id, name, val, common = {}) {
		const type = typeof val === "boolean" ? "boolean" : typeof val === "number" ? "number" : "string";
		const role = this.roleFor(String(id.split(".").pop()), type, val);
		await this.extendObject(id, {
			type: "state",
			common: { name, type, role, read: true, write: false, ...common },
			native: {},
		});
		await this.setStateChangedAsync(id, val === undefined ? null : val, true);
	}

	/**
	 * @param {string} id - state id
	 * @param {string} name - name
	 */
	async button(id, name) {
		await this.extendObject(id, {
			type: "state",
			common: { name, type: "boolean", role: "button", read: false, write: true, def: false },
			native: {},
		});
	}

	/**
	 * Writes all fields of an object as states; nested objects become channels, arrays JSON strings.
	 *
	 * @param {string} prefix - parent id
	 * @param {Record<string, any>} obj - data
	 */
	async flatten(prefix, obj) {
		for (const [key, val] of Object.entries(obj)) {
			const id = `${prefix}.${this.sanitize(key)}`;
			if (val !== null && typeof val === "object" && !Array.isArray(val)) {
				await this.channel(id, key);
				await this.flatten(id, val);
			} else if (Array.isArray(val)) {
				await this.value(id, key, JSON.stringify(val), { role: "json" });
			} else {
				await this.value(id, key, val);
			}
		}
	}

	// ── objects ──────────────────────────────────────────────────────────────

	async createStaticObjects() {
		await this.channel("summary", "Summary");
		await this.extendObject("jobs", { type: "folder", common: { name: "Jobs" }, native: {} });
		await this.extendObject("targets", { type: "folder", common: { name: "Targets" }, native: {} });
		await this.extendObject("jobRunning", {
			type: "state",
			common: {
				name: "A check/update job is running",
				type: "boolean",
				role: "indicator.working",
				read: true,
				write: false,
			},
			native: {},
		});
		await this.button("checkAll", "Check all targets incl. hosts (no update)");
		await this.button("updateAllVmsCts", "Update all VMs/CTs (without hosts)");
		await this.button("updateSecurityOnly", "Update VMs/CTs with security updates (without hosts)");
	}

	// ── refresh / poll ───────────────────────────────────────────────────────

	scheduleRefresh() {
		const minutes = this.clamp(this.config.refreshInterval, 60, 1);
		this.refreshTimer = this.setTimeout(
			() => {
				this.refreshTimer = null;
				this.refreshStatus().finally(() => !this.unloading && this.scheduleRefresh());
			},
			Math.min(minutes * 60, MAX_TIMEOUT_S) * 1000,
		);
	}

	schedulePoll() {
		if (this.unloading) {
			return;
		}
		const seconds = this.jobRunning
			? this.clamp(this.config.pollBusy, 2, 1)
			: this.clamp(this.config.pollIdle, 30, 5);
		this.pollTimer = this.setTimeout(() => {
			this.pollTimer = null;
			this.pollJobs().finally(() => this.schedulePoll());
		}, seconds * 1000);
	}

	/** Polls the job list immediately (e.g. right after a button press). */
	kickPoll() {
		if (this.pollTimer) {
			this.clearTimeout(this.pollTimer);
			this.pollTimer = null;
		}
		this.pollJobs().finally(() => this.schedulePoll());
	}

	/** Light-weight job check; a full status refresh follows when a job has finished. */
	async pollJobs() {
		const wasRunning = this.jobRunning;
		try {
			await this.queue(() => this.refreshJobs());
			await this.setState("info.connection", true, true);
		} catch (e) {
			this.log.warn(`Job status check failed: ${e.message}`);
			await this.setState("info.connection", false, true);
			return;
		}
		if (wasRunning && !this.jobRunning) {
			// job finished → update counters/reboot flags right away instead of waiting for the next refresh
			await this.refreshStatus();
		}
	}

	async refreshJobs() {
		const jobs = await this.api().getJobs();
		this.jobRunning = jobs.some(j => BUSY_STATES.includes(j.state));
		await this.setStateChangedAsync("jobRunning", this.jobRunning, true);
		await this.value("jobs.count", "Number of jobs (running + history)", jobs.length);

		const seen = new Set();
		for (const j of jobs) {
			if (!j || !j.unit) {
				continue;
			}
			const key = this.sanitize(j.unit);
			seen.add(key);
			const prefix = `jobs.${key}`;
			await this.channel(prefix, `${j.target || j.unit} (${j.state})`);
			await this.flatten(prefix, j);
			if (FAILURE_STATES.includes(j.state)) {
				const logState = await this.getStateAsync(`${prefix}.log`);
				if (!logState || !logState.val) {
					try {
						const log = await this.api().getJobLog(j.unit);
						await this.value(`${prefix}.log`, "Log (last lines of a failed job)", log);
					} catch (e) {
						this.log.warn(`Log of job ${j.unit} not available: ${e.message}`);
					}
				}
			}
		}
		// remove jobs that are no longer in the server's history
		const existing = await this.getForeignObjectsAsync(`${this.namespace}.jobs.*`, "channel");
		for (const chId of Object.keys(existing)) {
			const parts = chId.split(".");
			const key = parts[3];
			if (parts.length === 4 && !seen.has(key)) {
				await this.delObjectAsync(`jobs.${key}`, { recursive: true });
			}
		}
	}

	/** Full refresh: status of all targets, summary, jobs, updater version. */
	refreshStatus() {
		return this.queue(async () => {
			try {
				const status = await this.api().getStatus();
				const targets = (status && status.targets) || [];

				await this.value("info.lastRefresh", "Last refresh", Date.now(), { role: "value.time" });
				await this.value("info.schemaVersion", "Status schema version", String(status.schema_version ?? ""));
				await this.value("info.generatedAt", "Status generated at (server)", String(status.generated_at ?? ""));
				await this.value("info.targetCount", "Number of targets", targets.length);

				await this.writeSummary(targets);
				await this.writeTargets(targets);
				await this.refreshJobs();
				await this.refreshVersion();
				await this.setState("info.connection", true, true);
				this.log.debug(`Status refreshed: ${targets.length} targets`);
			} catch (e) {
				this.log.error(`Status refresh failed: ${e.message}`);
				await this.setState("info.connection", false, true);
			}
		});
	}

	async refreshVersion() {
		try {
			const v = await this.api().getUpdaterVersion();
			if (v && typeof v === "object") {
				await this.value(
					"info.updaterVersion",
					"Installed Ultimate Updater version",
					String(v.installed ?? ""),
				);
				await this.value(
					"info.updaterUpdateAvailable",
					"Ultimate Updater update available",
					v.update_available === true,
				);
			}
		} catch (e) {
			this.log.debug(`Updater version not available: ${e.message}`);
		}
	}

	/**
	 * @param {any[]} targets - targets from /api/status
	 */
	async writeSummary(targets) {
		const name = t => t.name || t.id;
		const withUpdates = targets.filter(t => (t.security_updates || 0) > 0 || (t.normal_updates || 0) > 0);
		const unreachable = targets.filter(t => t.reachable === false);
		const reboot = targets.filter(t => t.reboot_required === true);
		const sum = key => targets.reduce((s, t) => s + (Number(t[key]) || 0), 0);
		await this.value(
			"summary.securityUpdatesTotal",
			"Pending security updates (all targets)",
			sum("security_updates"),
		);
		await this.value("summary.normalUpdatesTotal", "Pending normal updates (all targets)", sum("normal_updates"));
		await this.value("summary.targetsWithUpdatesCount", "Targets with pending updates", withUpdates.length);
		await this.value(
			"summary.targetsWithUpdatesList",
			"Targets with pending updates",
			JSON.stringify(withUpdates.map(name)),
			{
				role: "json",
			},
		);
		await this.value(
			"summary.unreachableCount",
			"Unreachable targets (stopped VMs/CTs not counted)",
			unreachable.length,
		);
		await this.value("summary.unreachableList", "Unreachable targets", JSON.stringify(unreachable.map(name)), {
			role: "json",
		});
		await this.value("summary.rebootRequiredCount", "Targets with pending reboot", reboot.length);
		await this.value(
			"summary.rebootRequiredList",
			"Targets with pending reboot",
			JSON.stringify(reboot.map(name)),
			{
				role: "json",
			},
		);
	}

	/**
	 * @param {any[]} targets - targets from /api/status
	 */
	async writeTargets(targets) {
		const current = new Map();
		for (const t of targets) {
			if (!t || t.id === undefined || t.id === null) {
				continue;
			}
			const key = this.targetKey(t);
			current.set(key, t);
			const prefix = `targets.${key}`;
			const isHost = t.type === "host";
			await this.extendObject(prefix, {
				type: "device",
				common: { name: `${t.name || t.id} (${t.type})` },
				native: {},
			});
			await this.flatten(prefix, t);
			await this.button(`${prefix}.updateNow`, isHost ? "Update this host" : "Update this VM/CT");
			await this.button(
				`${prefix}.checkNow`,
				isHost ? "Check this host (no update)" : "Check this VM/CT (no update)",
			);
		}
		// remove targets that the API no longer delivers (deleted VM/CT)
		const existing = await this.getForeignObjectsAsync(`${this.namespace}.targets.*`, "device");
		for (const devId of Object.keys(existing)) {
			const parts = devId.split(".");
			if (parts.length === 4 && !current.has(parts[3])) {
				await this.delObjectAsync(`targets.${parts[3]}`, { recursive: true });
				this.log.info(`Target no longer delivered, removed: ${parts[3]}`);
			}
		}
		this.targets = current;
	}

	// ── actions ──────────────────────────────────────────────────────────────

	/**
	 * Runs an action unless a job is already running.
	 *
	 * @param {string} label - log label
	 * @param {() => Promise<any>} fn - action
	 */
	async action(label, fn) {
		await this.queue(async () => {
			try {
				const jobs = await this.api().getJobs();
				if (jobs.some(j => BUSY_STATES.includes(j.state))) {
					this.log.warn(`A check/update job is already running – ${label} not started.`);
					return;
				}
				await fn();
			} catch (e) {
				this.log.error(`${label} failed: ${e.message}`);
			}
		});
		this.kickPoll();
	}

	/**
	 * @param {string} id - State ID
	 * @param {ioBroker.State | null | undefined} state - State object
	 */
	async onStateChange(id, state) {
		if (!state || state.ack || !state.val || !this.client) {
			return;
		}
		const rel = id.slice(this.namespace.length + 1);
		await this.setState(rel, false, true);

		if (rel === "checkAll") {
			await this.action("Check all", async () => {
				const res = await this.api().checkAll();
				this.log.info(`Check of all targets started: ${(res && res.message) || "OK"}`);
			});
			return;
		}
		if (rel === "updateAllVmsCts" || rel === "updateSecurityOnly") {
			const securityOnly = rel === "updateSecurityOnly";
			await this.action(securityOnly ? "Security update" : "Update of all VMs/CTs", async () => {
				const status = await this.api().getStatus();
				const list = ((status && status.targets) || []).filter(
					t => t.type !== "host" && (!securityOnly || (t.security_updates || 0) > 0),
				);
				this.log.info(`Starting update of ${list.length} VMs/CTs (hosts excluded)`);
				for (const t of list) {
					try {
						await this.api().update(t.id);
					} catch (e) {
						this.log.warn(`Update of ${t.name || t.id} failed: ${e.message}`);
					}
				}
			});
			return;
		}
		const m = /^targets\.([^.]+)\.(updateNow|checkNow)$/.exec(rel);
		if (m) {
			const t = this.targets.get(m[1]);
			if (!t) {
				this.log.warn(`Unknown target ${m[1]} – please wait for the next refresh.`);
				return;
			}
			const update = m[2] === "updateNow";
			const label = `${update ? "Update" : "Check"} of ${t.name || t.id}`;
			await this.action(label, async () => {
				let res;
				if (t.type === "host") {
					res = update ? await this.api().updateNode(t.node) : await this.api().checkNode(t.node);
				} else {
					res = update ? await this.api().update(t.id) : await this.api().check(t.id);
				}
				this.log.info(`${label} started${res && res.job ? ` (job ${res.job})` : ""}`);
			});
		}
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 *
	 * @param {() => void} callback - Callback function
	 */
	onUnload(callback) {
		this.unloading = true;
		try {
			if (this.refreshTimer) {
				this.clearTimeout(this.refreshTimer);
			}
			if (this.pollTimer) {
				this.clearTimeout(this.pollTimer);
			}
			const client = this.client;
			this.client = null;
			if (client) {
				client.logout().finally(() => callback());
			} else {
				callback();
			}
		} catch (error) {
			this.log.error(`Error during unloading: ${error.message}`);
			callback();
		}
	}
}

if (require.main !== module) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
	 */
	module.exports = options => new UltimateUpdater(options);
} else {
	// otherwise start the instance directly
	new UltimateUpdater();
}
