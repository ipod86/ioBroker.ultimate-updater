"use strict";

/**
 * Thin client for Ultimate Updater (https://github.com/BassT23/Proxmox). All HTTP access of the
 * adapter lives here. Two modes:
 *
 * 1. Web UI login (Ultimate Updater 5.1.3+):
 *    - POST /api/login {username, password, realm} → session cookie UU_SESSION + csrf token
 *    - username WITHOUT "@realm", the realm is a separate field (pam, pve, …)
 *    - write requests need the cookie and the header X-CSRF-Token
 *    - sessions are valid for 8 h; the client keeps one session and logs in again on 401/403
 *
 * 2. Integration API v1 with a bearer token (Ultimate Updater 5.2 / develop, docs/api-v1.md):
 *    - "Authorization: Bearer <token>", HTTPS only, endpoints below /api/v1/
 *    - permissions per token: read, logs, check, update, reboot, cancel (403 if missing)
 *    - update/update-node/reboot need the body {"confirm": true}, checks an empty body
 *    - reboot: /api/v1/reboot/<id> instead of /api/targets/<id>/reboot
 */

const http = require("node:http");
const https = require("node:https");

const TIMEOUT_MS = 15000;

/**
 * Error of an API call, carrying HTTP status and API error code.
 */
class UuError extends Error {
	/**
	 * @param {string} message - error text
	 * @param {number} [status] - HTTP status code
	 * @param {string} [code] - error code from the API (e.g. JOB_ALREADY_RUNNING)
	 */
	constructor(message, status, code) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

/**
 * Client for the Ultimate Updater Web UI API.
 */
class UuClient {
	/**
	 * @param {{ip: string, port: number, https?: boolean, username?: string, password?: string, realm?: string, token?: string, validateCertificate?: boolean}} opts - connection options: Web UI address, either Proxmox user (optionally with realm suffix) + password + realm (default pam) or an API token, TLS check
	 */
	constructor(opts) {
		const host = String(opts.ip || "").trim();
		if (!host) {
			throw new Error("No IP address / host name configured");
		}
		const port = Number(opts.port) || 8765;
		this.base = new URL(
			`${opts.https === false ? "http" : "https"}://${host.includes(":") ? `[${host}]` : host}:${port}`,
		);
		this.validateCertificate = !!opts.validateCertificate;
		this.configuredRealm = String(opts.realm || "").trim();
		this.session = null; // { cookie, csrf }
		this.token = "";
		if (opts.token) {
			this.setToken(opts.token);
		} else {
			this.setCredentials(opts.username, opts.password);
		}
	}

	/** @returns {boolean} true when the integration API v1 with a bearer token is used */
	get tokenMode() {
		return !!this.token;
	}

	/**
	 * Uses the integration API v1 with this bearer token.
	 *
	 * @param {any} token - API token
	 */
	setToken(token) {
		this.token = String(token || "").trim();
		this.session = null;
	}

	/**
	 * Path for the active mode ("/status" → "/api/status" or "/api/v1/status").
	 *
	 * @param {string} path - path below /api
	 * @returns {string} full path
	 */
	p(path) {
		return `${this.tokenMode ? "/api/v1" : "/api"}${path}`;
	}

	/**
	 * Sets user name and password; the next request logs in again.
	 *
	 * @param {any} username - user name, a realm suffix ("root" + "@pam") is split off
	 * @param {any} password - password
	 */
	setCredentials(username, password) {
		let user = String(username || "").trim();
		let realm = this.configuredRealm;
		// the API rejects user names containing the realm separator
		const at = user.lastIndexOf("@");
		if (at > 0) {
			realm = realm || user.slice(at + 1);
			user = user.slice(0, at);
		}
		this.username = user;
		this.realm = realm || "pam";
		this.password = String(password || "");
		this.token = "";
		this.session = null;
	}

	/**
	 * Raw HTTP request returning { status, headers, data }.
	 *
	 * @param {string} method - HTTP method
	 * @param {string} path - API path
	 * @param {object} [body] - JSON body
	 * @param {Record<string, string>} [headers] - extra headers
	 * @returns {Promise<{status: number, headers: object, data: any}>} response
	 */
	request(method, path, body, headers = {}) {
		const url = new URL(path, this.base);
		const lib = url.protocol === "http:" ? http : https;
		const payload = body === undefined ? undefined : JSON.stringify(body);
		return new Promise((resolve, reject) => {
			const req = lib.request(
				url,
				{
					method,
					timeout: TIMEOUT_MS,
					rejectUnauthorized: this.validateCertificate,
					headers: {
						Accept: "application/json",
						...(payload !== undefined
							? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
							: {}),
						...headers,
					},
				},
				res => {
					let raw = "";
					res.setEncoding("utf8");
					res.on("data", chunk => (raw += chunk));
					res.on("end", () => {
						let data = raw;
						try {
							data = raw ? JSON.parse(raw) : null;
						} catch {
							// keep text
						}
						resolve({ status: res.statusCode || 0, headers: res.headers, data });
					});
				},
			);
			req.on("timeout", () => req.destroy(new Error(`Request timed out: ${method} ${url.pathname}`)));
			req.on("error", reject);
			if (payload !== undefined) {
				req.write(payload);
			}
			req.end();
		});
	}

	/**
	 * Logs in and stores the session.
	 *
	 * @returns {Promise<void>}
	 */
	async login() {
		const res = await this.request("POST", "/api/login", {
			username: this.username,
			password: this.password,
			realm: this.realm,
		});
		if (res.status !== 200) {
			const err = res.data && res.data.error;
			throw new UuError(
				`Login failed (HTTP ${res.status}${err && err.code ? `, ${err.code}` : ""}): ${(err && err.message) || "unknown error"}`,
				res.status,
				err && err.code,
			);
		}
		const setCookie = res.headers["set-cookie"] || [];
		const cookie = (Array.isArray(setCookie) ? setCookie : [setCookie])
			.map(c => String(c).split(";")[0])
			.filter(c => c.startsWith("UU_SESSION="))
			.join("; ");
		if (!cookie || !res.data || !res.data.csrf) {
			throw new UuError("Login response contained no session", res.status);
		}
		this.session = { cookie, csrf: res.data.csrf };
	}

	/**
	 * Ends the session (best effort).
	 *
	 * @returns {Promise<void>}
	 */
	async logout() {
		if (this.tokenMode || !this.session) {
			return;
		}
		try {
			await this.request("POST", "/api/logout", {}, this.authHeaders(true));
		} catch {
			// session expires on the server anyway
		}
		this.session = null;
	}

	/**
	 * @param {boolean} write - include CSRF header
	 * @returns {Record<string, string>} headers
	 */
	authHeaders(write) {
		if (this.tokenMode) {
			return { Authorization: `Bearer ${this.token}` };
		}
		if (!this.session) {
			return {};
		}
		return write
			? { Cookie: this.session.cookie, "X-CSRF-Token": this.session.csrf }
			: { Cookie: this.session.cookie };
	}

	/**
	 * Authenticated call with one automatic re-login on 401/403.
	 *
	 * @param {string} method - HTTP method
	 * @param {string} path - API path
	 * @param {object} [body] - JSON body for POST
	 * @returns {Promise<any>} JSON response
	 */
	async call(method, path, body) {
		for (let attempt = 0; attempt < 2; attempt++) {
			if (!this.tokenMode && !this.session) {
				await this.login();
			}
			const res = await this.request(method, path, body, this.authHeaders(method !== "GET"));
			if ((res.status === 401 || res.status === 403) && attempt === 0 && !this.tokenMode) {
				this.session = null; // expired session or CSRF mismatch → log in again
				continue;
			}
			// actions answer 202 Accepted, reads 200
			if (res.status < 200 || res.status >= 300) {
				const err = res.data && res.data.error;
				throw new UuError(
					`${method} ${path} → HTTP ${res.status}${err && err.message ? `: ${err.message}` : ""}`,
					res.status,
					err && err.code,
				);
			}
			return res.data;
		}
		throw new UuError(`${method} ${path} → not authorized`, 401);
	}

	/** @returns {Promise<any>} status with targets[] */
	getStatus() {
		return this.call("GET", this.p("/status"));
	}
	/** @returns {Promise<any[]>} jobs */
	async getJobs() {
		const res = await this.call("GET", this.p("/jobs"));
		return (res && res.jobs) || [];
	}
	/**
	 * @param {string} unit - job unit
	 * @returns {Promise<string>} last log lines
	 */
	async getJobLog(unit) {
		const res = await this.call("GET", this.p(`/jobs/${encodeURIComponent(unit)}/log`));
		return String((res && res.log) || "");
	}
	/** @returns {Promise<any>} updater version info */
	getUpdaterVersion() {
		return this.call("GET", this.p("/updater-version"));
	}
	/**
	 * @param {string} id - target id
	 * @returns {Promise<any>} job info
	 */
	check(id) {
		return this.call("POST", this.p(`/check/${encodeURIComponent(id)}`), {});
	}
	/**
	 * @param {string} id - target id
	 * @returns {Promise<any>} job info
	 */
	update(id) {
		return this.call("POST", this.p(`/update/${encodeURIComponent(id)}`), this.confirmBody());
	}
	/**
	 * @param {string} node - node name
	 * @returns {Promise<any>} job info
	 */
	checkNode(node) {
		return this.call("POST", this.p(`/check-node/${encodeURIComponent(node)}`), {});
	}
	/**
	 * @param {string} node - node name
	 * @returns {Promise<any>} job info
	 */
	updateNode(node) {
		return this.call("POST", this.p(`/update-node/${encodeURIComponent(node)}`), this.confirmBody());
	}
	/**
	 * Reboots a target (server only allows it when reboot_required is set).
	 *
	 * @param {string} id - target id
	 * @returns {Promise<any>} job info
	 */
	reboot(id) {
		return this.tokenMode
			? this.call("POST", this.p(`/reboot/${encodeURIComponent(id)}`), this.confirmBody())
			: this.call("POST", `/api/targets/${encodeURIComponent(id)}/reboot`, {});
	}
	/**
	 * Requests cancellation of a running job.
	 *
	 * @param {string} unit - job unit
	 * @returns {Promise<any>} result
	 */
	cancelJob(unit) {
		return this.call("POST", this.p(`/jobs/${encodeURIComponent(unit)}/cancel`), {});
	}
	/** @returns {Promise<any>} job info */
	checkAll() {
		return this.call("POST", this.p("/check-all"), {});
	}

	/** @returns {object} body for update/reboot (API v1 requires an explicit confirmation) */
	confirmBody() {
		return this.tokenMode ? { confirm: true } : {};
	}
}

/** Job states the server treats as busy (server.py) */
const BUSY_STATES = ["running", "pending", "starting"];
/** Final states for which the log is fetched */
const FAILURE_STATES = ["failed", "interrupted"];

module.exports = { UuClient, UuError, BUSY_STATES, FAILURE_STATES };
