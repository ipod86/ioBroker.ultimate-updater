"use strict";

/**
 * Small mock of the Ultimate Updater Web UI API (behaviour as in web-ui/server.py):
 * login with separate realm, session cookie, CSRF check on POST, 202 for actions.
 */

const http = require("node:http");

/**
 * Starts the mock on a random local port.
 *
 * @returns {Promise<{server: http.Server, state: any, port: number}>} running mock
 */
function startMock() {
	/** @type {{sessions: Map<string, any>, logins: number, lastLogin: any, actions: string[][], targets: any[], jobs: any[], startJobOnUpdate: boolean}} */
	const state = {
		sessions: new Map(),
		logins: 0,
		lastLogin: null,
		actions: [],
		targets: [
			{ id: "lxc:101", name: "web", type: "lxc", node: "pve", reachable: true, security_updates: 2, normal_updates: 5, reboot_required: false },
			{ id: "host:pve", name: "pve", type: "host", node: "pve", reachable: true, security_updates: 0, normal_updates: 1, reboot_required: true },
			{ id: "lxc:103", name: "db", type: "lxc", node: "pve", reachable: true, security_updates: 1, normal_updates: 0, reboot_required: false },
		],
		jobs: [{ unit: "uu-1", target: "lxc:102", state: "failed", exit_code: 1 }],
		startJobOnUpdate: false,
	};
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", c => (body += c));
		req.on("end", () => {
			const send = (status, data, headers = {}) => {
				res.writeHead(status, { "Content-Type": "application/json", ...headers });
				res.end(JSON.stringify(data));
			};
			const cookie = (req.headers.cookie || "").match(/UU_SESSION=([^;]+)/);
			const session = cookie && state.sessions.get(cookie[1]);
			if (req.method === "POST" && req.url === "/api/login") {
				const p = JSON.parse(body || "{}");
				state.lastLogin = p;
				// like server.py: username without "@", realm required
				if (typeof p.realm !== "string" || /@/.test(p.username) || p.password !== "secret") {
					return send(401, { error: { code: "LOGIN_FAILED", message: "Invalid credentials." } });
				}
				state.logins++;
				const token = `tok${state.logins}`;
				state.sessions.set(token, { csrf: `csrf${state.logins}` });
				return send(
					200,
					{ authenticated: true, csrf: `csrf${state.logins}` },
					{
						"Set-Cookie": `UU_SESSION=${token}; Path=/; HttpOnly`,
					},
				);
			}
			if (!session) {
				return send(401, { error: { code: "AUTH_REQUIRED", message: "Sign in" } });
			}
			if (req.method === "GET" && req.url === "/api/status") {
				return send(200, { schema_version: "1", generated_at: "2026-10-17T08:00:00Z", targets: state.targets });
			}
			if (req.method === "GET" && req.url === "/api/jobs") {
				return send(200, { jobs: state.jobs });
			}
			if (req.method === "GET" && req.url === "/api/updater-version") {
				return send(200, { installed: "5.1.3", available: "5.1.3", update_available: false });
			}
			const log = /^\/api\/jobs\/([^/]+)\/log$/.exec(req.url || "");
			if (req.method === "GET" && log) {
				return send(200, { unit: decodeURIComponent(log[1]), log: "E: apt failed" });
			}
			if (req.method === "POST") {
				if (req.headers["x-csrf-token"] !== session.csrf) {
					return send(403, { error: { code: "CSRF_REJECTED", message: "A valid CSRF token is required." } });
				}
				if (req.url === "/api/logout") {
					state.sessions.delete(cookie[1]);
					return send(200, { authenticated: false });
				}
				const cancel = /^\/api\/jobs\/([^/]+)\/cancel$/.exec(req.url || "");
				if (cancel) {
					state.actions.push(["cancel", decodeURIComponent(cancel[1])]);
					const job = state.jobs.find(j => j.unit === decodeURIComponent(cancel[1]));
					if (job) {
						job.state = "interrupted";
					}
					return send(202, { unit: decodeURIComponent(cancel[1]), state: "stopping" });
				}
				const reboot = /^\/api\/targets\/([^/]+)\/reboot$/.exec(req.url || "");
				if (reboot) {
					state.actions.push(["reboot", decodeURIComponent(reboot[1])]);
					return send(202, { job: "uu-rb", state: "running" });
				}
				if (req.url === "/api/check-all") {
					state.actions.push(["check-all", ""]);
					return send(202, { job: "uu-all", state: "running" });
				}
				const m = /^\/api\/(update|check|update-node|check-node)\/(.+)$/.exec(req.url || "");
				if (m) {
					state.actions.push([m[1], decodeURIComponent(m[2])]);
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
