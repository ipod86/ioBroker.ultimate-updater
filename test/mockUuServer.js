"use strict";

/**
 * Small mock of the Ultimate Updater integration API v1 (behaviour as in web-ui/server.py):
 * bearer token with permissions, {"confirm": true} for update/reboot, empty body for checks,
 * 202 for actions, no "status" field per target, skip_reason for shut down guests
 */

const http = require("node:http");

/** permission needed per v1 route */
const V1_PERMISSIONS = {
	"GET status": "read",
	"GET jobs": "read",
	"GET log": "logs",
	"GET updater-version": "read",
	"POST check": "check",
	"POST check-node": "check",
	"POST check-all": "check",
	"POST update": "update",
	"POST update-node": "update",
	"POST reboot": "reboot",
	"POST cancel": "cancel",
};

/**
 * Starts the mock on a random local port.
 *
 * @returns {Promise<{server: http.Server, state: any, port: number}>} running mock
 */
function startMock() {
	/** @type {{actions: string[][], targets: any[], jobs: any[], startJobOnUpdate: boolean, autoCompleteMs: number, timeline: any[], tokens: Record<string, string[]>, v1Calls: any[], finalStates: Record<string, string>}} */
	const state = {
		actions: [],
		targets: [
			{ id: "lxc:101", name: "web", type: "lxc", node: "pve", reachable: true, security_updates: 2, normal_updates: 5, reboot_required: false },
			{ id: "host:pve", name: "pve", type: "host", node: "pve", reachable: true, security_updates: 0, normal_updates: 1, reboot_required: true },
			{ id: "lxc:103", name: "db", type: "lxc", node: "pve", reachable: true, security_updates: 1, normal_updates: 0, reboot_required: false },
		],
		jobs: [{ unit: "uu-1", target: "lxc:102", state: "failed", exit_code: 1 }],
		startJobOnUpdate: false,
		autoCompleteMs: 0,
		/** @type {any[]} */
		timeline: [],
		// API v1 tokens → permissions
		tokens: {
			"tok-full": ["read", "logs", "check", "update", "reboot", "cancel"],
			"tok-read": ["read"],
		},
		/** @type {any[]} v1 requests: [method, path, body] */
		v1Calls: [],
		/** @type {Record<string, string>} final job state per target (default "completed") */
		finalStates: {},
	};

	/**
	 * Public v1 view of a target: no "status" field, skip_reason for shut down guests.
	 *
	 * @param {any} t - internal target
	 * @returns {any} v1 target
	 */
	const v1Target = t => {
		const { status, ...rest } = t;
		const stopped = status === "stopped";
		return {
			...rest,
			check_status: stopped ? "not_checked" : rest.check_status || "ok",
			error: null,
			skip_reason: stopped ? { code: "STOPPED_READ_ONLY", message: `${t.id} is stopped; the check did not start it` } : null,
		};
	};

	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", c => (body += c));
		req.on("end", () => {
			const send = (status, data, headers = {}) => {
				res.writeHead(status, { "Content-Type": "application/json", ...headers });
				res.end(JSON.stringify(data));
			};
			let url = req.url || "";

			if (url.startsWith("/api/v1/")) {
				const rest = url.slice("/api/v1/".length);
				let parsed;
				try {
					parsed = body ? JSON.parse(body) : {};
				} catch {
					return send(400, { error: { code: "BAD_REQUEST", message: "Invalid JSON" } });
				}
				state.v1Calls.push([req.method, url, parsed]);
				const auth = /^Bearer (.+)$/.exec(String(req.headers.authorization || ""));
				const perms = auth && state.tokens[auth[1]];
				if (!perms) {
					return send(401, { error: { code: "AUTH_REQUIRED", message: "Use a bearer token for machine API access." } });
				}
				const parts = rest.split("/");
				let route = parts[0];
				if (parts[0] === "jobs" && parts[2] === "log") {
					route = "log";
				} else if (parts[0] === "jobs" && parts[2] === "cancel") {
					route = "cancel";
				}
				const permission = V1_PERMISSIONS[`${req.method} ${route}`];
				if (!permission) {
					return send(404, { error: { code: "NOT_FOUND", message: "Not found." } });
				}
				if (!perms.includes(permission)) {
					return send(403, { error: { code: "PERMISSION_DENIED", message: `The token lacks the ${permission} permission.` } });
				}
				if (["update", "update-node", "reboot"].includes(route) && !(parsed && parsed.confirm === true)) {
					return send(422, { error: { code: "CONFIRMATION_REQUIRED", message: 'This action requires JSON {"confirm": true}.' } });
				}
				if (["check", "check-node", "check-all"].includes(route) && Object.keys(parsed || {}).length) {
					return send(422, { error: { code: "INVALID_ACTION_BODY", message: "Check actions do not accept request fields." } });
				}
				if (route === "check" && decodeURIComponent(parts[1]).startsWith("host:")) {
					return send(422, { error: { code: "USE_NODE_ACTION", message: "Use the node check endpoint for Proxmox hosts." } });
				}
				if (req.method === "GET" && route === "status") {
					return send(200, {
						api_version: 1,
						schema_version: 1,
						generated_at: "2026-10-17T08:00:00Z",
						state: "current",
						targets: state.targets.map(v1Target),
					});
				}
				// map the remaining v1 routes onto the internal handlers below
				url = route === "reboot" ? `/api/targets/${parts[1]}/reboot` : `/api/${rest}`;
			} else {
				return send(404, { error: { code: "NOT_FOUND", message: "Not found." } });
			}
			if (req.method === "GET" && url === "/api/jobs") {
				return send(200, { jobs: state.jobs });
			}
			if (req.method === "GET" && url === "/api/updater-version") {
				return send(200, { installed: "5.1.3", available: "5.1.3", update_available: false });
			}
			const log = /^\/api\/jobs\/([^/]+)\/log$/.exec(url);
			if (req.method === "GET" && log) {
				return send(200, { unit: decodeURIComponent(log[1]), log: "E: apt failed" });
			}
			if (req.method === "POST") {
				const cancel = /^\/api\/jobs\/([^/]+)\/cancel$/.exec(url);
				if (cancel) {
					state.actions.push(["cancel", decodeURIComponent(cancel[1])]);
					const job = state.jobs.find(j => j.unit === decodeURIComponent(cancel[1]));
					if (job) {
						job.state = "interrupted";
					}
					return send(202, { unit: decodeURIComponent(cancel[1]), state: "stopping" });
				}
				const reboot = /^\/api\/targets\/([^/]+)\/reboot$/.exec(url);
				if (reboot) {
					state.actions.push(["reboot", decodeURIComponent(reboot[1])]);
					return send(202, { job: "uu-rb", state: "running" });
				}
				if (url === "/api/check-all") {
					state.actions.push(["check-all", ""]);
					return send(202, { job: "uu-all", state: "running" });
				}
				const m = /^\/api\/(update|check|update-node|check-node)\/(.+)$/.exec(url);
				if (m) {
					state.actions.push([m[1], decodeURIComponent(m[2])]);
					if (state.autoCompleteMs > 0 && m[1] === "update") {
						// realistic job: running for a while, then completed
						const job = {
							unit: `uu-${decodeURIComponent(m[2]).replace(/[^a-z0-9]/gi, "")}-${state.actions.length}`,
							target: decodeURIComponent(m[2]),
							type: "update",
							state: "running",
							started_at: new Date().toISOString(),
						};
						state.jobs.push(job);
						state.timeline.push(["start", job.target, Date.now()]);
						setTimeout(() => {
							job.state = state.finalStates[job.target] || "completed";
							state.timeline.push(["done", job.target, Date.now()]);
						}, state.autoCompleteMs);
						return send(202, { target: job.target, job: job.unit, state: "running" });
					}
					if (state.startJobOnUpdate && m[1] === "update") {
						state.jobs.push({
							unit: "uu-2",
							target: decodeURIComponent(m[2]),
							state: "running",
							started_at: new Date().toISOString(),
						});
						state.startJobOnUpdate = false;
					}
					return send(202, { target: decodeURIComponent(m[2]), job: "uu-2", state: "running" });
				}
			}
			send(404, { error: { code: "NOT_FOUND", message: "Not found" } });
		});
	});
	return new Promise(resolve =>
		server.listen(0, "127.0.0.1", () =>
			resolve({ server, state, port: /** @type {import("node:net").AddressInfo} */ (server.address()).port }),
		),
	);
}

module.exports = { startMock };
