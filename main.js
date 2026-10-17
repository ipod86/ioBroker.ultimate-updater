"use strict";

/*
 * Created with @iobroker/create-adapter v3.1.5
 *
 * Reads the update status of all Proxmox hosts, LXC containers and VMs from
 * BassT23's Ultimate Updater (https://github.com/BassT23/Proxmox) and offers
 * buttons to check/update single targets or all of them.
 */

const utils = require("@iobroker/adapter-core");
const { Credentials } = require("@iobroker/adapter-core");
const { UuClient, BUSY_STATES, FAILURE_STATES } = require("./lib/uu-client");
const { texts } = require("./lib/i18n");

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
		this.on("message", this.onMessage.bind(this));

		this.client = null;
		this.refreshTimer = null;
		this.pollTimer = null;
		this.jobRunning = false;
		this.busy = Promise.resolve(); // serialises refresh/poll/actions
		/** target key → target data of the last refresh */
		this.targets = new Map();
		this.unloading = false;
		this.T = texts("en");
		/** last notified state (null = first run) */
		this.notified = null;
		this.notifiedJobsInitialised = false;
		/** unsubscribes from the credential of the credentials manager */
		this.unsubscribeCredential = null;
		/** object id → JSON of the last written common (avoids rewriting objects) */
		this.objCache = new Map();
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		await this.setState("info.connection", false, true);

		const cred = await this.resolveCredentials();
		if (!cred) {
			return;
		}
		if (!this.config.ip) {
			this.log.error("Please configure the IP address of the Ultimate Updater Web UI.");
			return;
		}
		try {
			this.client = new UuClient({ ...this.config, username: cred.login, password: cred.password });
		} catch (e) {
			this.log.error(`Invalid address "${this.config.ip}:${this.config.port}": ${e.message}`);
			return;
		}

		const sys = await this.getForeignObjectAsync("system.config");
		this.T = texts((sys && sys.common && sys.common.language) || "en");

		await this.createStaticObjects();
		const ns = await this.getStateAsync("info.notifyState");
		try {
			this.notified = ns && ns.val ? JSON.parse(String(ns.val)) : null;
		} catch {
			this.notified = null;
		}
		// with a persisted state, failures that happened while the adapter was stopped are new and get notified
		this.notifiedJobsInitialised = !!this.notified;
		this.subscribeStates("*");

		if (this.config.credentialMode === "manager") {
			await this.watchCredential();
		}

		await this.refreshStatus();
		this.scheduleRefresh();
		this.schedulePoll();
	}

	// ── credentials ──────────────────────────────────────────────────────────

	/**
	 * Login data from the settings or from the central credentials manager (admin ≥ 7.9).
	 *
	 * @returns {Promise<{login: string, password: string} | null>} login data or null if not usable
	 */
	async resolveCredentials() {
		if (this.config.credentialMode === "manager") {
			if (!Credentials || !Credentials.getCredentials) {
				this.log.error(
					"The credentials manager is not available. Please update js-controller to 7.2.2 or higher.",
				);
				return null;
			}
			if (!this.config.credentialId) {
				this.log.error("Please select the login data in the adapter settings (credentials manager).");
				return null;
			}
			try {
				const c = await Credentials.getCredentials(this, this.config.credentialId);
				const login = String(c.values.login || "");
				const password = String(c.values.password || "");
				if (!login || !password) {
					this.log.error(
						`Credential "${this.config.credentialId}" has no login/password (a key credential cannot be used).`,
					);
					return null;
				}
				return { login, password };
			} catch (e) {
				this.log.error(`Cannot read credential "${this.config.credentialId}": ${e.message}`);
				return null;
			}
		}
		if (!this.config.username || !this.config.password) {
			this.log.error("Please configure user name and password of the Ultimate Updater Web UI.");
			return null;
		}
		return { login: this.config.username, password: this.config.password };
	}

	/** Reacts to changes of the selected credential: new login data are used right away. */
	async watchCredential() {
		try {
			this.unsubscribeCredential = await Credentials.subscribeCredentials(
				this,
				this.config.credentialId,
				(id, cred) => {
					if (!cred) {
						this.log.warn(`Credential ${id} was deleted – please select other login data.`);
						this.setState("info.connection", false, true);
						return;
					}
					this.log.info(`Credential ${id} was changed, logging in again`);
					if (this.client) {
						this.client.setCredentials(cred.values.login, cred.values.password);
					}
					this.refreshStatus();
				},
			);
		} catch (e) {
			this.log.warn(`Changes of credential ${this.config.credentialId} cannot be watched: ${e.message}`);
		}
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
		await this.ensureObject(id, "channel", { name });
	}

	/**
	 * Creates/updates an object only when it is new or its common part changed.
	 *
	 * @param {string} id - object id
	 * @param {"state" | "channel" | "device" | "folder"} type - object type
	 * @param {Record<string, any>} common - common part
	 */
	async ensureObject(id, type, common) {
		const sig = `${type}|${JSON.stringify(common)}`;
		if (this.objCache.get(id) === sig) {
			return;
		}
		await this.extendObject(id, { type, common, native: {} });
		this.objCache.set(id, sig);
	}

	/**
	 * Deletes an object (recursively) and forgets it in the cache.
	 *
	 * @param {string} id - object id
	 * @param {boolean} [recursive] - delete children too
	 */
	async removeObject(id, recursive = false) {
		await this.delObjectAsync(id, recursive ? { recursive: true } : undefined);
		for (const key of [...this.objCache.keys()]) {
			if (key === id || (recursive && key.startsWith(`${id}.`))) {
				this.objCache.delete(key);
			}
		}
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
		if (val === null || val === undefined) {
			// unknown value: keep type/role of an existing state, create new ones as text
			if (!this.objCache.has(id) && !(await this.getObjectAsync(id))) {
				await this.ensureObject(id, "state", {
					name,
					type: "string",
					role: "text",
					read: true,
					write: false,
					...common,
				});
			}
			await this.setStateChangedAsync(id, null, true);
			return;
		}
		const type = typeof val === "boolean" ? "boolean" : typeof val === "number" ? "number" : "string";
		const role = this.roleFor(String(id.split(".").pop()), type, val);
		await this.ensureObject(id, "state", { name, type, role, read: true, write: false, ...common });
		await this.setStateChangedAsync(id, val, true);
	}

	/**
	 * @param {string} id - state id
	 * @param {string} name - name
	 */
	async button(id, name) {
		await this.ensureObject(id, "state", {
			name,
			type: "boolean",
			role: "button",
			read: false,
			write: true,
			def: false,
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

	// ── notifications ────────────────────────────────────────────────────────

	/**
	 * Sends a notification via the ioBroker notification manager.
	 *
	 * @param {"securityUpdates" | "jobFailed" | "rebootRequired"} category - notification category
	 * @param {string} msg - text in the system language
	 */
	async notify(category, msg) {
		this.log.info(`Notification (${category}): ${msg}`);
		try {
			await this.registerNotification("ultimate-updater", category, msg);
		} catch (e) {
			this.log.warn(`Notification could not be sent: ${e.message}`);
		}
	}

	/** Persists what has been notified, so a restart does not repeat notifications. */
	async saveNotified() {
		await this.setStateChangedAsync("info.notifyState", JSON.stringify(this.notified), true);
	}

	/**
	 * Notifies new security updates and new reboot requirements (only on changes).
	 *
	 * @param {any[]} targets - targets from /api/status
	 */
	async notifyTargets(targets) {
		const first = !this.notified;
		const prev = this.notified || { sec: {}, reboot: [], jobs: [] };
		const sec = {};
		const reboot = [];
		for (const t of targets) {
			const id = String(t.id);
			const name = t.name || id;
			const n = Number(t.security_updates) || 0;
			sec[id] = n;
			if (!first && this.config.notifySecurity !== false && n > (prev.sec[id] || 0)) {
				await this.notify("securityUpdates", this.T.security(name, n));
			}
			if (t.reboot_required === true) {
				reboot.push(id);
				if (!first && this.config.notifyReboot !== false && !prev.reboot.includes(id)) {
					await this.notify("rebootRequired", this.T.reboot(name));
				}
			}
		}
		this.notified = { sec, reboot, jobs: prev.jobs || [] };
		await this.saveNotified();
	}

	/**
	 * Notifies failed/interrupted jobs once.
	 *
	 * @param {any[]} jobs - jobs from /api/jobs
	 */
	async notifyJobs(jobs) {
		if (!this.notified) {
			return; // first run: the status refresh initialises the state first
		}
		const known = new Set(this.notified.jobs || []);
		const failed = jobs.filter(j => j && j.unit && FAILURE_STATES.includes(j.state));
		let changed = false;
		for (const j of failed) {
			if (!known.has(j.unit)) {
				// failures that already existed when the adapter started are not notified
				if (this.config.notifyJobFailed !== false && this.notifiedJobsInitialised) {
					await this.notify("jobFailed", this.T.jobFailed(this.targetName(j.target), j.state));
				}
				changed = true;
			}
		}
		const units = failed.map(j => j.unit);
		if (changed || units.length !== known.size) {
			this.notified.jobs = units;
			await this.saveNotified();
		}
		this.notifiedJobsInitialised = true;
	}

	/**
	 * Display name of a job target ("lxc:101" → name of the target).
	 *
	 * @param {string} target - job target
	 * @returns {string} name
	 */
	targetName(target) {
		for (const t of this.targets.values()) {
			if (t.id === target || `host:${t.node}` === target || (t.type === "host" && t.node === target)) {
				return t.name || t.id;
			}
		}
		return String(target || "?");
	}

	/**
	 * @param {any} t - target
	 * @returns {boolean} excluded from the collective update buttons
	 */
	isExcluded(t) {
		const list = Array.isArray(this.config.excludeTargets) ? this.config.excludeTargets : [];
		return list.includes(String(t.id));
	}

	// ── objects ──────────────────────────────────────────────────────────────

	async createStaticObjects() {
		await this.channel("summary", "Summary");
		await this.ensureObject("jobs", "folder", { name: "Jobs" });
		await this.ensureObject("targets", "folder", { name: "Targets" });
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
		await this.extendObject("info.notifyState", {
			type: "state",
			common: {
				name: "Internal: last notified state (avoids repeated notifications)",
				type: "string",
				role: "json",
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
		if (this.pollTimer) {
			// only one poll chain may exist (an in-flight poll and kickPoll both end up here)
			this.clearTimeout(this.pollTimer);
			this.pollTimer = null;
		}
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
			if (this.unloading) {
				return;
			}
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
			if (BUSY_STATES.includes(j.state)) {
				await this.button(`${prefix}.cancel`, "Cancel this job");
			} else if (this.objCache.has(`${prefix}.cancel`) || (await this.getObjectAsync(`${prefix}.cancel`))) {
				await this.removeObject(`${prefix}.cancel`);
			}
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
		await this.writeTargetJobs(jobs);
		await this.notifyJobs(jobs);

		// remove jobs that are no longer in the server's history
		const existing = await this.getForeignObjectsAsync(`${this.namespace}.jobs.*`, "channel");
		for (const chId of Object.keys(existing)) {
			const parts = chId.split(".");
			const key = parts[3];
			if (parts.length === 4 && !seen.has(key)) {
				await this.removeObject(`jobs.${key}`, true);
			}
		}
	}

	/**
	 * Latest job per target as states of the target (jobState, jobUnit).
	 *
	 * @param {any[]} jobs - jobs from /api/jobs
	 */
	async writeTargetJobs(jobs) {
		const ts = j => Date.parse(j.started_at || j.finished_at || "") || 0;
		for (const [key, t] of this.targets) {
			const own = jobs.filter(
				j =>
					j &&
					(j.target === t.id ||
						(t.type === "host" && (j.target === `host:${t.node}` || j.target === t.node))),
			);
			own.sort((a, b) => ts(b) - ts(a));
			const last = own[0];
			await this.value(
				`targets.${key}.jobState`,
				"State of the latest job of this target",
				last ? String(last.state) : "none",
			);
			await this.value(`targets.${key}.jobUnit`, "Latest job of this target", last ? String(last.unit) : "none");
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
				if (this.unloading) {
					return;
				}
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
		const updates = sum("security_updates") + sum("normal_updates");
		const parts = [updates > 0 ? this.T.summary(updates, withUpdates.length) : this.T.summaryNone];
		if (reboot.length) {
			parts.push(this.T.summaryReboot(reboot.length));
		}
		await this.value("summary.text", "Summary as text", parts.join(", "));
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
			await this.ensureObject(prefix, "device", { name: `${t.name || t.id} (${t.type})` });
			await this.flatten(prefix, t);
			await this.button(`${prefix}.updateNow`, isHost ? "Update this host" : "Update this VM/CT");
			await this.button(
				`${prefix}.checkNow`,
				isHost ? "Check this host (no update)" : "Check this VM/CT (no update)",
			);
			// reboot button only if allowed in the settings and the target actually needs a reboot
			if (this.config.allowReboot && t.reboot_required === true && ["host", "lxc", "vm"].includes(t.type)) {
				await this.button(`${prefix}.reboot`, isHost ? "Reboot this host" : "Reboot this VM/CT");
			} else if (this.objCache.has(`${prefix}.reboot`) || (await this.getObjectAsync(`${prefix}.reboot`))) {
				await this.removeObject(`${prefix}.reboot`);
			}
		}
		// remove targets that the API no longer delivers (deleted VM/CT) – only if enabled in the settings
		const existing = await this.getForeignObjectsAsync(`${this.namespace}.targets.*`, "device");
		for (const devId of Object.keys(existing)) {
			const parts = devId.split(".");
			if (parts.length === 4 && !current.has(parts[3])) {
				if (this.config.deleteStaleTargets !== false) {
					await this.removeObject(`targets.${parts[3]}`, true);
					this.log.info(`Target no longer delivered, removed: ${parts[3]}`);
				} else {
					this.log.debug(`Target no longer delivered, kept (deletion disabled): ${parts[3]}`);
				}
			}
		}
		this.targets = current;
		await this.notifyTargets(targets);
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
		const isButton =
			["checkAll", "updateAllVmsCts", "updateSecurityOnly"].includes(rel) ||
			/^jobs\.[^.]+\.cancel$/.test(rel) ||
			/^targets\.[^.]+\.(updateNow|checkNow|reboot)$/.test(rel);
		if (!isButton) {
			return;
		}
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
					t => t.type !== "host" && !this.isExcluded(t) && (!securityOnly || (t.security_updates || 0) > 0),
				);
				this.log.info(`Starting update of ${list.length} VMs/CTs (hosts and excluded targets skipped)`);
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
		const cancel = /^jobs\.([^.]+)\.cancel$/.exec(rel);
		if (cancel) {
			const unitState = await this.getStateAsync(`jobs.${cancel[1]}.unit`);
			const unit = unitState && unitState.val ? String(unitState.val) : cancel[1];
			await this.queue(async () => {
				try {
					await this.api().cancelJob(unit);
					this.log.info(`Cancellation of job ${unit} requested`);
				} catch (e) {
					this.log.error(`Cancelling job ${unit} failed: ${e.message}`);
				}
			});
			this.kickPoll();
			return;
		}
		const rb = /^targets\.([^.]+)\.reboot$/.exec(rel);
		if (rb) {
			const t = this.targets.get(rb[1]);
			if (!this.config.allowReboot || !t) {
				this.log.warn("Reboot is disabled in the adapter settings or the target is unknown.");
				return;
			}
			await this.action(`Reboot of ${t.name || t.id}`, async () => {
				const res = await this.api().reboot(t.id);
				this.log.info(`Reboot of ${t.name || t.id} started${res && res.job ? ` (job ${res.job})` : ""}`);
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
	 * Admin requests (target list for the exclusion selection).
	 *
	 * @param {ioBroker.Message} obj - message
	 */
	async onMessage(obj) {
		if (!obj || obj.command !== "getTargets" || !obj.callback) {
			return;
		}
		let list = [...this.targets.values()];
		if (!list.length && this.client) {
			try {
				const status = await this.api().getStatus();
				list = (status && status.targets) || [];
			} catch (e) {
				this.log.debug(`Target list for admin not available: ${e.message}`);
			}
		}
		const options = list
			.filter(t => t.type !== "host")
			.map(t => ({ label: `${t.name || t.id} (${t.type}, ${t.id})`, value: String(t.id) }));
		this.sendTo(obj.from, obj.command, options, obj.callback);
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
			if (this.unsubscribeCredential) {
				this.unsubscribeCredential().catch(() => {});
				this.unsubscribeCredential = null;
			}
			const client = this.client;
			this.client = null;
			if (client) {
				// best effort, do not delay the unload (the session expires on the server anyway)
				client.logout().catch(() => {});
			}
			callback();
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
