"use strict";

/**
 * Tests of the API client against a small mock of the Ultimate Updater integration API v1
 * (bearer token with permissions, confirm body, 202 for actions).
 */

const { expect } = require("chai");
const { UuClient, UuError } = require("../lib/uu-client");
const { startMock } = require("./mockUuServer");

describe("UuClient", () => {
	let mock;
	beforeEach(async () => (mock = await startMock()));
	afterEach(() => mock.server.close());

	it("uses /api/v1 with the bearer token", async () => {
		const c = new UuClient({ ip: "127.0.0.1", port: mock.port, https: false, token: "tok-full" });
		const status = await c.getStatus();
		expect(status.api_version).to.equal(1);
		expect(mock.state.v1Calls[0]).to.deep.equal(["GET", "/api/v1/status", {}]);
	});

	it("update/reboot send confirm, checks an empty body", async () => {
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

	it("missing permission gives 403 with code", async () => {
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

	it("invalid token gives 401", async () => {
		const c = new UuClient({ ip: "127.0.0.1", port: mock.port, https: false, token: "wrong" });
		try {
			await c.getJobs();
			expect.fail("should throw");
		} catch (e) {
			expect(e).to.be.instanceOf(UuError);
			expect(e.status).to.equal(401);
			expect(e.code).to.equal("AUTH_REQUIRED");
		}
	});
});
