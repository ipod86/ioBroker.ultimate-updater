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
const { buildReport, label } = require("./lib/report");
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
		this.noLogPermission = false;
		/** jobs whose log could not be fetched (not retried) */
		this.logUnavailable = new Set();
		/** running collective update: { stop } – null if none */
		this.bulk = null;
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		await this.setStateChangedAsync("info.connection", false, true);

		const cred = await this.resolveCredentials();
		if (!cred) {
			return;
		}
		if (!this.config.ip) {
			this.log.error("Please configure the IP address of the Ultimate Updater Web UI.");
			return;
		}
		try {
			this.client = new UuClient({
				...this.config,
				username: cred.login,
				password: cred.password,
				token: cred.token,
			});
			this.log.info(
				this.client.tokenMode
					? "Using the Ultimate Updater integration API v1 (API token)"
					: "Using the Ultimate Updater Web UI login",
			);
		} catch (e) {
			this.log.error(`Invalid address "${this.config.ip}:${this.config.port}": ${e.message}`);
			return;
		}

		if (this.config.authMode === "token" && this.config.https === false) {
			this.log.warn('The integration API (API token) only works over HTTPS – please enable "Use HTTPS".');
		}
		if (this.config.authMode !== "token" && this.config.https === false) {
			this.log.warn(
				'"Use HTTPS" is off: the Proxmox password (an Administrator account) is sent unencrypted over the network – please enable HTTPS or use an API token.',
			);
		}
		if (!this.config.validateCertificate && this.config.https !== false) {
			this.log.info(
				"The TLS certificate of the Ultimate Updater Web UI is not validated (see settings) – use this only in a trusted network.",
			);
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
	 * @returns {Promise<{login?: string, password?: string, token?: string} | null>} login data or null if not usable
	 */
	async resolveCredentials() {
		const tokenMode = this.config.authMode === "token";
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
				if (tokenMode) {
					const token = String(c.values.key || "");
					if (!token) {
						this.log.error(
							`Credential "${this.config.credentialId}" has no key – for the API token please select a "Key" credential.`,
						);
						return null;
					}
					return { token };
				}
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
		if (tokenMode) {
			if (!this.config.apiToken) {
				this.log.error("Please enter the API token of Ultimate Updater in the adapter settings.");
				return null;
			}
			return { token: this.config.apiToken };
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
						if (this.config.authMode === "token") {
							this.client.setToken(cred.values.key);
						} else {
							this.client.setCredentials(cred.values.login, cred.values.password);
						}
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
	 * @param {unknown} value - configured value
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
	 * @template T
	 * @param {() => Promise<T>} task - task
	 * @returns {Promise<T>} task result
	 */
	queue(task) {
		const run = this.busy.then(task, task);
		this.busy = run.then(
			() => {},
			() => {},
		);
		return run;
	}

	/**
	 * Object id part from free text (same scheme as the original script: only [a-zA-Z0-9_]).
	 *
	 * @param {unknown} s - text
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
	 * @param {import("./lib/types").ApiData} t - target
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
	 * @param {Record<string, import("./lib/types").ApiData>} common - common part
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
	 * @param {import("./lib/types").ApiData} val - current value
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
	 * @param {import("./lib/types").ApiData} val - value
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
		let role = this.roleFor(String(id.split(".").pop()), type, val);
		// keep a time role once it was chosen, so a value like "never" does not flip the object between date and text
		const known = this.objCache.get(id); // "state|<common as JSON>"
		if (known && !common.role) {
			try {
				const prev = JSON.parse(known.slice(known.indexOf("|") + 1));
				if ((prev.role === "date" || prev.role === "value.time") && prev.type === type) {
					role = prev.role;
				}
			} catch {
				// unreadable cache entry: keep the computed role
			}
		}
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
	 * @param {Record<string, import("./lib/types").ApiData>} obj - data
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
	 * @param {import("./lib/types").ApiData[]} targets - targets from /api/status
	 */
	async notifyTargets(targets) {
		const first = !this.notified;
		const prev = this.notified || { sec: {}, reboot: [], jobs: [] };
		const sec = {};
		const reboot = [];
		for (const t of targets) {
			const id = String(t.id);
			const name = label(t);
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
	 * @param {import("./lib/types").ApiData[]} jobs - jobs from /api/jobs
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
	 * Display name of a job target for notifications ("115 · iobroker", host: node name).
	 *
	 * @param {string} target - job target
	 * @returns {string} name
	 */
	targetName(target) {
		for (const t of this.targets.values()) {
			if (t.id === target || `host:${t.node}` === target || (t.type === "host" && t.node === target)) {
				return label(t);
			}
		}
		return target ? label({ id: target }) : "?";
	}

	/**
	 * Shut down guest? Web UI status has "status"; API v1 reports it via skip_reason/check_status.
	 *
	 * @param {import("./lib/types").ApiData} t - target
	 * @returns {boolean} true if the VM/CT is shut down
	 */
	isStopped(t) {
		return (
			t.status === "stopped" ||
			t.check_status === "stopped" ||
			(!!t.skip_reason && /STOPPED/.test(String(t.skip_reason.code || "")))
		);
	}

	/**
	 * @param {import("./lib/types").ApiData} t - target
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
		await this.button(
			"updateSecurityOnly",
			"Full update of the VMs/CTs that have security updates (without hosts)",
		);
		await this.channel("bulk", "Collective update");
		await this.extendObject("bulk.active", {
			type: "state",
			common: {
				name: "A collective update is running",
				type: "boolean",
				role: "indicator.working",
				read: true,
				write: false,
				def: false,
			},
			native: {},
		});
		await this.extendObject("bulk.progress", {
			type: "state",
			common: {
				name: "Progress of the collective update",
				type: "string",
				role: "text",
				read: true,
				write: false,
			},
			native: {},
		});
		await this.button("bulk.stop", "Stop the collective update after the current target");
		await this.setStateChangedAsync("bulk.active", false, true);
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
			await this.setStateChangedAsync("info.connection", true, true);
		} catch (e) {
			if (this.unloading) {
				return;
			}
			this.log.warn(`Job status check failed: ${e.message}`);
			await this.setStateChangedAsync("info.connection", false, true);
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
			if (FAILURE_STATES.includes(j.state) && !this.noLogPermission && !this.logUnavailable.has(j.unit)) {
				const logState = await this.getStateAsync(`${prefix}.log`);
				if (!logState || !logState.val) {
					try {
						const log = await this.api().getJobLog(j.unit);
						await this.value(`${prefix}.log`, "Log (last lines of a failed job)", log);
					} catch (e) {
						if (e.status === 403) {
							// API token without "logs" permission: tell once, do not retry on every poll
							this.noLogPermission = true;
							this.log.info(
								'The API token has no "logs" permission – logs of failed jobs are not fetched.',
							);
						} else {
							this.logUnavailable.add(j.unit); // try once per job and adapter run
							this.log.warn(`Log of job ${j.unit} not available: ${e.message}`);
						}
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
	 * @param {import("./lib/types").ApiData[]} jobs - jobs from /api/jobs
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
				await this.value(
					"info.generatedAt",
					"Status generated at (server)",
					String(status.generated_at ?? ""),
					{
						role: "date",
					},
				);
				await this.value("info.targetCount", "Number of targets", targets.length);

				await this.writeSummary(targets);
				await this.writeTargets(targets);
				await this.refreshJobs();
				await this.refreshVersion();
				await this.setStateChangedAsync("info.connection", true, true);
				this.log.debug(`Status refreshed: ${targets.length} targets`);
			} catch (e) {
				if (this.unloading) {
					return;
				}
				this.log.error(`Status refresh failed: ${e.message}`);
				await this.setStateChangedAsync("info.connection", false, true);
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
	 * @param {import("./lib/types").ApiData[]} targets - targets from /api/status
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
		await this.value(
			"summary.report",
			"Status report as text (like the Ultimate Updater status mail)",
			buildReport(targets, this.T),
			{
				role: "text",
			},
		);
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
	 * @param {import("./lib/types").ApiData[]} targets - targets from /api/status
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
	 * @param {() => Promise<import("./lib/types").ApiData>} fn - action
	 */
	async action(label, fn) {
		if (this.bulk) {
			this.log.warn(`A collective update is running – ${label} not started.`);
			return;
		}
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
	 * Waits the given time (ends early when the adapter unloads).
	 *
	 * @param {number} ms - milliseconds
	 * @returns {Promise<void>}
	 */
	wait(ms) {
		return new Promise(resolve => this.setTimeout(() => resolve(), ms));
	}

	/**
	 * Waits until no job of Ultimate Updater is running (or the given job has finished).
	 *
	 * @param {string} [unit] - only wait for this job
	 * @returns {Promise<string>} final state of the job ("" when waiting for all jobs)
	 */
	async waitForJobs(unit) {
		const pollMs = this.clamp(this.config.pollBusy, 2, 1) * 1000;
		const deadline = Date.now() + 3 * 60 * 60 * 1000; // a single update should never take 3 h
		let missing = 0;
		while (!this.unloading) {
			const jobs = await this.queue(() => this.api().getJobs());
			if (unit) {
				const job = jobs.find(j => j.unit === unit);
				if (job && !BUSY_STATES.includes(job.state)) {
					return String(job.state);
				}
				// a job that does not appear at all (anymore) counts as finished after a few polls
				if (!job && ++missing >= 3) {
					return "unknown";
				}
			} else if (!jobs.some(j => BUSY_STATES.includes(j.state))) {
				return "";
			}
			if (Date.now() > deadline) {
				throw new Error(
					unit ? `job ${unit} did not finish within 3 hours` : "jobs did not finish within 3 hours",
				);
			}
			await this.wait(pollMs);
		}
		throw new Error("adapter is stopping");
	}

	/**
	 * Collective update of VMs/CTs, one target after the other: the next update is only started
	 * when the previous job has finished (Ultimate Updater answers 202 when a job starts, not when
	 * it ends). Hosts and excluded targets are skipped.
	 *
	 * @param {boolean} securityOnly - only targets that have security updates (they still get a full update)
	 */
	async runBulkUpdate(securityOnly) {
		const label = securityOnly ? "Update of the VMs/CTs with security updates" : "Update of all VMs/CTs";
		if (this.bulk) {
			this.log.warn(`A collective update is already running – ${label} not started.`);
			return;
		}
		const bulk = { stop: false };
		this.bulk = bulk;
		let ok = 0;
		let failed = 0;
		let unchanged = 0; // job state "skipped": nothing to update (Ultimate Updater 5.2+)
		let skipped = 0;
		let stoppedSkipped = 0;
		const resultText = () =>
			`${ok} ok${unchanged ? `, ${unchanged} unchanged` : ""}, ${failed} failed, ${skipped} not started${stoppedSkipped ? `, ${stoppedSkipped} shut down skipped` : ""}`;
		try {
			const jobs = await this.queue(() => this.api().getJobs());
			if (jobs.some(j => BUSY_STATES.includes(j.state))) {
				this.log.warn(`A check/update job is already running – ${label} not started.`);
				return;
			}
			const status = await this.queue(() => this.api().getStatus());
			const candidates = ((status && status.targets) || []).filter(
				t => t.type !== "host" && !this.isExcluded(t) && (!securityOnly || (t.security_updates || 0) > 0),
			);
			// "running" (default): shut down VMs/CTs are skipped – Ultimate Updater only updates them
			// if STOPPED_CONTAINER/STOPPED_VM is enabled in its update.conf, otherwise the job fails
			const onlyRunning = this.config.bulkTargets !== "all";
			const list = onlyRunning ? candidates.filter(t => !this.isStopped(t)) : candidates;
			stoppedSkipped = candidates.length - list.length;
			this.log.info(
				`${label}: ${list.length} targets, one after the other (hosts and excluded targets skipped${stoppedSkipped ? `, ${stoppedSkipped} shut down VMs/CTs skipped` : ""})`,
			);
			await this.setStateChangedAsync("bulk.active", true, true);

			for (let i = 0; i < list.length; i++) {
				const t = list[i];
				const name = t.name || t.id;
				if (bulk.stop || this.unloading) {
					skipped = list.length - i;
					this.log.info(`${label} stopped – ${skipped} targets not updated`);
					break;
				}
				await this.setStateChangedAsync("bulk.progress", `${i + 1}/${list.length}: ${name}`, true);
				// another job (e.g. started in the Web UI) must not overlap with ours
				await this.waitForJobs();
				let res;
				try {
					res = await this.queue(() => this.api().update(t.id));
				} catch (e) {
					failed++;
					this.log.warn(`Update of ${name} could not be started: ${e.message}`);
					continue;
				}
				this.kickPoll();
				const unit = res && res.job ? String(res.job) : "";
				const result = unit ? await this.waitForJobs(unit) : await this.waitForJobs();
				if (!unit || result === "completed" || result === "completed_with_warnings" || result === "unknown") {
					ok++;
				} else if (result === "skipped") {
					unchanged++;
				} else {
					failed++;
				}
				this.log.info(`Update of ${name}: ${result || "finished"} (${i + 1}/${list.length})`);
			}
			this.log.info(`${label} finished: ${resultText()}`);
		} catch (e) {
			this.log.error(`${label} aborted: ${e.message}`);
		} finally {
			this.bulk = null;
			if (!this.unloading) {
				await this.setStateChangedAsync("bulk.active", false, true);
				await this.setStateChangedAsync("bulk.progress", resultText(), true);
				this.kickPoll();
			}
		}
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
			["checkAll", "updateAllVmsCts", "updateSecurityOnly", "bulk.stop"].includes(rel) ||
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
			// runs in the background (can take long); progress in bulk.*
			this.runBulkUpdate(rel === "updateSecurityOnly");
			return;
		}
		if (rel === "bulk.stop") {
			if (this.bulk) {
				this.bulk.stop = true;
				this.log.info("Collective update will stop after the current target");
			}
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
	async onUnload(callback) {
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
				// abort running requests, end the Web UI session (at most 2 s), then refuse new requests
				client.abort();
				await client.logout().catch(() => {});
				client.close();
			}
		} catch (error) {
			this.log.error(`Error during unloading: ${error.message}`);
		} finally {
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
