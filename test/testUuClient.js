"use strict";

/**
 * Tests of the API client against a small mock of the Ultimate Updater Web UI
 * (login with realm, session cookie, CSRF check, 202 for actions – as in web-ui/server.py).
 */

const { expect } = require("chai");
const { UuClient, UuError } = require("../lib/uu-client");
const { startMock } = require("./mockUuServer");

describe("UuClient", () => {
	let mock;
	beforeEach(async () => (mock = await startMock()));
	afterEach(() => mock.server.close());

	it("logs in with separate realm and reads the status", async () => {
		const c = new UuClient({ ip: "127.0.0.1", port: mock.port, https: false, username: "root", password: "secret", realm: "pam" });
		const status = await c.getStatus();
		expect(status.targets).to.have.length(3);
		expect(mock.state.lastLogin).to.deep.equal({ username: "root", password: "secret", realm: "pam" });
	});

	it("splits user@realm into user and realm", async () => {
		const c = new UuClient({ ip: "127.0.0.1", port: mock.port, https: false, username: "admin@pve", password: "secret", realm: "" });
		await c.getJobs();
		expect(mock.state.lastLogin.username).to.equal("admin");
		expect(mock.state.lastLogin.realm).to.equal("pve");
	});

	it("reports a failed login with the API error code", async () => {
		const c = new UuClient({ ip: "127.0.0.1", port: mock.port, https: false, username: "root", password: "wrong" });
		try {
			await c.getStatus();
			expect.fail("should throw");
		} catch (e) {
			expect(e).to.be.instanceOf(UuError);
			expect(e.status).to.equal(401);
			expect(e.code).to.equal("LOGIN_FAILED");
		}
	});

	it("sends the CSRF token on actions and accepts 202", async () => {
		const c = new UuClient({ ip: "127.0.0.1", port: mock.port, https: false, username: "root", password: "secret" });
		const res = await c.update("lxc:101");
		expect(res.job).to.equal("uu-2");
		expect(mock.state.actions).to.deep.equal([["update", "lxc:101"]]);
	});

	it("keeps the session and logs in again when it has expired", async () => {
		const c = new UuClient({ ip: "127.0.0.1", port: mock.port, https: false, username: "root", password: "secret" });
		await c.getStatus();
		await c.getJobs();
		expect(mock.state.logins).to.equal(1);
		mock.state.sessions.clear(); // server restart / session expired
		await c.getStatus();
		expect(mock.state.logins).to.equal(2);
	});

	it("API token: uses /api/v1 with bearer token, no login", async () => {
		const c = new UuClient({ ip: "127.0.0.1", port: mock.port, https: false, token: "tok-full" });
		expect(c.tokenMode).to.equal(true);
		const status = await c.getStatus();
		expect(status.api_version).to.equal(1);
		expect(mock.state.logins).to.equal(0);
		expect(mock.state.v1Calls[0]).to.deep.equal(["GET", "/api/v1/status", {}]);
	});

	it("API token: update/reboot send confirm, checks an empty body", async () => {
		const c = new UuClient({ ip: "127.0.0.1", port: mock.port, https: false, token: "tok-full" });
		await c.update("lxc:101");
		await c.updateNode("pve");
		await c.reboot("host:pve");
		await c.checkNode("pve");
		expect(mock.state.v1Calls.map(x => [x[1], x[2]])).to.deep.equal([
			["/api/v1/update/lxc%3A101", { confirm: true }],
			["/api/v1/update-node/pve", { confirm: true }],
			["/api/v1/reboot/host%3Apve", { confirm: true }],
			["/api/v1/check-node/pve", {}],
		]);
		expect(mock.state.actions).to.deep.include(["reboot", "host:pve"]);
	});

	it("API token: missing permission gives 403 with code, no retry", async () => {
		const c = new UuClient({ ip: "127.0.0.1", port: mock.port, https: false, token: "tok-read" });
		await c.getStatus();
		try {
			await c.update("lxc:101");
			expect.fail("should throw");
		} catch (e) {
			expect(e.status).to.equal(403);
			expect(e.code).to.equal("PERMISSION_DENIED");
		}
		expect(mock.state.v1Calls).to.have.length(2);
	});

	it("API token: invalid token gives 401", async () => {
		const c = new UuClient({ ip: "127.0.0.1", port: mock.port, https: false, token: "wrong" });
		try {
			await c.getJobs();
			expect.fail("should throw");
		} catch (e) {
			expect(e.status).to.equal(401);
			expect(e.code).to.equal("AUTH_REQUIRED");
		}
	});

	it("logs out", async () => {
		const c = new UuClient({ ip: "127.0.0.1", port: mock.port, https: false, username: "root", password: "secret" });
		await c.getStatus();
		await c.logout();
		expect(mock.state.sessions.size).to.equal(0);
		expect(c.session).to.equal(null);
	});
});
