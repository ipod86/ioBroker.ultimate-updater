"use strict";

/**
 * Thin client for the integration API v1 of Ultimate Updater 5.2+ (https://github.com/BassT23/Proxmox,
 * docs/api-v1.md). All HTTP access of the adapter lives here.
 *
 * - "Authorization: Bearer <token>", HTTPS only, endpoints below /api/v1/
 * - permissions per token: read, logs, check, update, reboot, cancel (403 if missing)
 * - update/update-node/reboot need the body {"confirm": true}, checks an empty body
 *
 * The Web UI login of Ultimate Updater is deliberately not supported: its endpoints are no stable interface and
 * it needs the password of a Proxmox administrator.
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
 * Client for the Ultimate Updater integration API v1.
 */
class UuClient {
	/**
	 * @param {{ip: string, port: number, https?: boolean, token?: string, validateCertificate?: boolean}} opts - connection options: Web UI address, API token, TLS check
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
		/** running requests, aborted by close() */
		this.pending = new Set();
		this.closed = false;
		this.setToken(opts.token);
	}

	/**
	 * Sets the bearer token (e.g. after the credential was changed).
	 *
	 * @param {unknown} token - API token
	 */
	setToken(token) {
		this.token = String(token || "").trim();
	}

	/**
	 * Path below /api/v1 ("/status" → "/api/v1/status").
	 *
	 * @param {string} path - path below /api/v1
	 * @returns {string} full path
	 */
	p(path) {
		return `/api/v1${path}`;
	}

	/**
	 * Raw HTTP request returning { status, headers, data }.
	 *
	 * @param {string} method - HTTP method
	 * @param {string} path - API path
	 * @param {object} [body] - JSON body
	 * @param {Record<string, string>} [headers] - extra headers
	 * @param {number} [timeoutMs] - request timeout
	 * @returns {Promise<{status: number, headers: object, data: import("./types").ApiData}>} response
	 */
	request(method, path, body, headers = {}, timeoutMs = TIMEOUT_MS) {
		const url = new URL(path, this.base);
		const lib = url.protocol === "http:" ? http : https;
		const payload = body === undefined ? undefined : JSON.stringify(body);
		return new Promise((resolve, reject) => {
			if (this.closed) {
				reject(new Error("Client closed"));
				return;
			}
			const req = lib.request(
				url,
				{
					method,
					timeout: timeoutMs,
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
			this.pending.add(req);
			req.on("close", () => this.pending.delete(req));
			if (payload !== undefined) {
				req.write(payload);
			}
			req.end();
		});
	}

	/**
	 * Aborts all running requests (adapter unload).
	 */
	abort() {
		for (const req of this.pending) {
			req.destroy(new Error("Client closed"));
		}
		this.pending.clear();
	}

	/**
	 * Aborts all running requests and refuses new ones.
	 */
	close() {
		this.abort();
		this.closed = true;
	}

	/**
	 * Authenticated call; actions answer 202, reads 200.
	 *
	 * @param {string} method - HTTP method
	 * @param {string} path - API path
	 * @param {object} [body] - JSON body for POST
	 * @returns {Promise<import("./types").ApiData>} JSON response
	 */
	async call(method, path, body) {
		const res = await this.request(method, path, body, { Authorization: `Bearer ${this.token}` });
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

	/** @returns {Promise<import("./types").ApiData>} status with targets[] */
	getStatus() {
		return this.call("GET", this.p("/status"));
	}
	/** @returns {Promise<import("./types").ApiData[]>} jobs */
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
	/** @returns {Promise<import("./types").ApiData>} updater version info */
	getUpdaterVersion() {
		return this.call("GET", this.p("/updater-version"));
	}
	/**
	 * @param {string} id - target id
	 * @returns {Promise<import("./types").ApiData>} job info
	 */
	check(id) {
		return this.call("POST", this.p(`/check/${encodeURIComponent(id)}`), {});
	}
	/**
	 * @param {string} id - target id
	 * @returns {Promise<import("./types").ApiData>} job info
	 */
	update(id) {
		return this.call("POST", this.p(`/update/${encodeURIComponent(id)}`), this.confirmBody());
	}
	/**
	 * @param {string} node - node name
	 * @returns {Promise<import("./types").ApiData>} job info
	 */
	checkNode(node) {
		return this.call("POST", this.p(`/check-node/${encodeURIComponent(node)}`), {});
	}
	/**
	 * @param {string} node - node name
	 * @returns {Promise<import("./types").ApiData>} job info
	 */
	updateNode(node) {
		return this.call("POST", this.p(`/update-node/${encodeURIComponent(node)}`), this.confirmBody());
	}
	/**
	 * Reboots a target (server only allows it when reboot_required is set).
	 *
	 * @param {string} id - target id
	 * @returns {Promise<import("./types").ApiData>} job info
	 */
	reboot(id) {
		return this.call("POST", this.p(`/reboot/${encodeURIComponent(id)}`), this.confirmBody());
	}
	/**
	 * Requests cancellation of a running job.
	 *
	 * @param {string} unit - job unit
	 * @returns {Promise<import("./types").ApiData>} result
	 */
	cancelJob(unit) {
		return this.call("POST", this.p(`/jobs/${encodeURIComponent(unit)}/cancel`), {});
	}
	/** @returns {Promise<import("./types").ApiData>} job info */
	checkAll() {
		return this.call("POST", this.p("/check-all"), {});
	}

	/** @returns {object} body for update/reboot (API v1 requires an explicit confirmation) */
	confirmBody() {
		return { confirm: true };
	}
}

/** Job states the server treats as busy (server.py) */
const BUSY_STATES = ["running", "pending", "starting"];
/** Final states for which the log is fetched */
const FAILURE_STATES = ["failed", "interrupted"];

module.exports = { UuClient, UuError, BUSY_STATES, FAILURE_STATES };
