const path = require("node:path");
const { tests } = require("@iobroker/testing");
const { expect } = require("chai");
const { startMock } = require("./mockUuServer");

// Run integration tests - See https://github.com/ioBroker/testing for a detailed explanation and further options
tests.integration(path.join(__dirname, ".."), {
	defineAdditionalTests({ suite }) {
		suite("Against a mocked Ultimate Updater Web UI", getHarness => {
			/** @type {any} */
			let mock;
			/** @type {any} */
			let harness;
			const NS = "ultimate-updater.0";
			const wait = ms => new Promise(r => setTimeout(r, ms));

			before(async function () {
				this.timeout(60000);
				mock = await startMock();
				harness = getHarness();
				const obj = await harness.objects.getObjectAsync(`system.adapter.${NS}`);
				// password is in encryptedNative → store it encrypted like admin does (legacy XOR, still supported)
				const sys = await harness.objects.getObjectAsync("system.config");
				const secret = String(sys.native.secret);
				const encrypt = v => [...v].map((c, i) => String.fromCharCode(secret.charCodeAt(i % secret.length) ^ c.charCodeAt(0))).join("");
				Object.assign(obj.native, {
					ip: "127.0.0.1",
					port: mock.port,
					https: false,
					username: "root@pam",
					password: encrypt("secret"),
					realm: "",
					pollIdle: 5,
					pollBusy: 1,
				});
				await harness.objects.setObjectAsync(obj._id, obj);
				await harness.startAdapterAndWait();
				await wait(3000);
			});
			after(() => mock && mock.server.close());

			it("logs in with separate realm and connects", async () => {
				expect(mock.state.lastLogin).to.deep.include({ username: "root", realm: "pam" });
				const conn = await harness.states.getStateAsync(`${NS}.info.connection`);
				expect(conn && conn.val).to.equal(true);
			});

			it("creates target devices and summary states", async () => {
				const sec = await harness.states.getStateAsync(`${NS}.targets.web_lxc_101.security_updates`);
				expect(sec && sec.val).to.equal(2);
				const dev = await harness.objects.getObjectAsync(`${NS}.targets.web_lxc_101`);
				expect(dev && dev.type).to.equal("device");
				const reach = await harness.objects.getObjectAsync(`${NS}.targets.web_lxc_101.reachable`);
				expect(reach && reach.common.role).to.equal("indicator.reachable");
				const total = await harness.states.getStateAsync(`${NS}.summary.securityUpdatesTotal`);
				expect(total && total.val).to.equal(2);
				const reboot = await harness.states.getStateAsync(`${NS}.summary.rebootRequiredList`);
				expect(reboot && reboot.val).to.equal('["pve"]');
			});

			it("stores the log of a failed job", async () => {
				const log = await harness.states.getStateAsync(`${NS}.jobs.uu_1.log`);
				expect(log && log.val).to.equal("E: apt failed");
			});

			it("starts an update when the button is pressed", async () => {
				await harness.states.setStateAsync(`${NS}.targets.web_lxc_101.updateNow`, true, false);
				await wait(1500);
				expect(mock.state.actions).to.deep.include(["update", "lxc:101"]);
				const btn = await harness.states.getStateAsync(`${NS}.targets.web_lxc_101.updateNow`);
				expect(btn && btn.ack).to.equal(true);
			});

			it("updates a host via update-node", async () => {
				await harness.states.setStateAsync(`${NS}.targets.pve_host_pve.updateNow`, true, false);
				await wait(1500);
				expect(mock.state.actions).to.deep.include(["update-node", "pve"]);
			});

			it("logs out when the adapter stops", async function () {
				this.timeout(10000);
				await harness.stopAdapter();
				await wait(500);
				expect(mock.state.sessions.size).to.equal(0);
			});
		});
	},
});
