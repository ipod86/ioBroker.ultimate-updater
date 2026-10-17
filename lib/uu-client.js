"use strict";

/**
 * Thin client for the Ultimate Updater Web UI API (https://github.com/BassT23/Proxmox).
 *
 * All HTTP access of the adapter lives here. Upstream plans a documented, versioned API with
 * token authentication; when it exists, only this module has to be replaced.
 *
 * Current Web UI authentication (since Ultimate Updater 5.1.3):
 *  - POST /api/login {username, password, realm} → session cookie UU_SESSION + csrf token
 *  - username WITHOUT "@realm", the realm is a separate field (pam, pve, …)
 *  - write requests need the cookie and the header X-CSRF-Token
 * Sessions are valid for 8 h; the client keeps one session and logs in again on 401/403.
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
	 * @param {{ip: string, port: number, https?: boolean, username: string, password: string, realm?: string, validateCertificate?: boolean}} opts - connection options: Web UI address, Proxmox user (optionally with realm suffix), password, realm (default pam), TLS check
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
		let user = String(opts.username || "").trim();
		let realm = String(opts.realm || "").trim();
		// "root" + "pam" (the API rejects user names containing the realm separator)
		const at = user.lastIndexOf("@");
		if (at > 0) {
			realm = realm || user.slice(at + 1);
			user = user.slice(0, at);
		}
		this.username = user;
		this.realm = realm || "pam";
		this.password = String(opts.password || "");
		this.validateCertificate = !!opts.validateCertificate;
		this.session = null; // { cookie, csrf }
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
		if (!this.session) {
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
			if (!this.session) {
				await this.login();
			}
			const res = await this.request(method, path, body, this.authHeaders(method !== "GET"));
			if ((res.status === 401 || res.status === 403) && attempt === 0) {
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
		return this.call("GET", "/api/status");
	}
	/** @returns {Promise<any[]>} jobs */
	async getJobs() {
		const res = await this.call("GET", "/api/jobs");
		return (res && res.jobs) || [];
	}
	/**
	 * @param {string} unit - job unit
	 * @returns {Promise<string>} last log lines
	 */
	async getJobLog(unit) {
		const res = await this.call("GET", `/api/jobs/${encodeURIComponent(unit)}/log`);
		return String((res && res.log) || "");
	}
	/** @returns {Promise<any>} updater version info */
	getUpdaterVersion() {
		return this.call("GET", "/api/updater-version");
	}
	/**
	 * @param {string} id - target id
	 * @returns {Promise<any>} job info
	 */
	check(id) {
		return this.call("POST", `/api/check/${encodeURIComponent(id)}`, {});
	}
	/**
	 * @param {string} id - target id
	 * @returns {Promise<any>} job info
	 */
	update(id) {
		return this.call("POST", `/api/update/${encodeURIComponent(id)}`, {});
	}
	/**
	 * @param {string} node - node name
	 * @returns {Promise<any>} job info
	 */
	checkNode(node) {
		return this.call("POST", `/api/check-node/${encodeURIComponent(node)}`, {});
	}
	/**
	 * @param {string} node - node name
	 * @returns {Promise<any>} job info
	 */
	updateNode(node) {
		return this.call("POST", `/api/update-node/${encodeURIComponent(node)}`, {});
	}
	/**
	 * Reboots a target (server only allows it when reboot_required is set).
	 *
	 * @param {string} id - target id
	 * @returns {Promise<any>} job info
	 */
	reboot(id) {
		return this.call("POST", `/api/targets/${encodeURIComponent(id)}/reboot`, {});
	}
	/**
	 * Requests cancellation of a running job.
	 *
	 * @param {string} unit - job unit
	 * @returns {Promise<any>} result
	 */
	cancelJob(unit) {
		return this.call("POST", `/api/jobs/${encodeURIComponent(unit)}/cancel`, {});
	}
	/** @returns {Promise<any>} job info */
	checkAll() {
		return this.call("POST", "/api/check-all", {});
	}
}

/** Job states the server treats as busy (server.py) */
const BUSY_STATES = ["running", "pending", "starting"];
/** Final states for which the log is fetched */
const FAILURE_STATES = ["failed", "interrupted"];

module.exports = { UuClient, UuError, BUSY_STATES, FAILURE_STATES };
