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
					excludeTargets: ["lxc:103"],
					allowReboot: true,
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
				expect(total && total.val).to.equal(3);
				const text = await harness.states.getStateAsync(`${NS}.summary.text`);
				expect(text && text.val).to.equal("9 updates on 3 systems, 1 reboot required");
				const jobState = await harness.states.getStateAsync(`${NS}.targets.web_lxc_101.jobState`);
				expect(jobState && jobState.val).to.equal("none");
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

			it("creates a reboot button only for targets that need a reboot", async () => {
				expect(await harness.objects.getObjectAsync(`${NS}.targets.pve_host_pve.reboot`)).to.be.ok;
				expect(await harness.objects.getObjectAsync(`${NS}.targets.web_lxc_101.reboot`)).to.not.be.ok;
				await harness.states.setStateAsync(`${NS}.targets.pve_host_pve.reboot`, true, false);
				await wait(1500);
				expect(mock.state.actions).to.deep.include(["reboot", "host:pve"]);
			});

			it("updates all VMs/CTs one after the other and skips excluded targets", async function () {
				this.timeout(30000);
				mock.state.actions.length = 0;
				mock.state.timeline.length = 0;
				mock.state.autoCompleteMs = 2500;
				mock.state.targets.push({
					id: "lxc:104",
					name: "mail",
					type: "lxc",
					node: "pve",
					reachable: true,
					security_updates: 0,
					normal_updates: 3,
					reboot_required: false,
				});
				await harness.states.setStateAsync(`${NS}.updateAllVmsCts`, true, false);
				await wait(1500);
				const active = await harness.states.getStateAsync(`${NS}.bulk.active`);
				expect(active && active.val).to.equal(true);
				// only the first target has been started while its job is still running
				expect(mock.state.actions.filter(a => a[0] === "update").map(a => a[1])).to.deep.equal(["lxc:101"]);
				// a single update is refused while the collective update runs
				await harness.states.setStateAsync(`${NS}.targets.pve_host_pve.updateNow`, true, false);
				await wait(9000);
				const started = mock.state.actions.filter(a => a[0] === "update" || a[0] === "update-node").map(a => a[1]);
				expect(started).to.deep.equal(["lxc:101", "lxc:104"]);
				expect(started).to.not.include("lxc:103");
				// the second job started only after the first one had finished
				const doneFirst = mock.state.timeline.find(e => e[0] === "done" && e[1] === "lxc:101");
				const startSecond = mock.state.timeline.find(e => e[0] === "start" && e[1] === "lxc:104");
				expect(startSecond[2]).to.be.at.least(doneFirst[2]);
				await wait(3000);
				const after = await harness.states.getStateAsync(`${NS}.bulk.active`);
				expect(after && after.val).to.equal(false);
				const progress = await harness.states.getStateAsync(`${NS}.bulk.progress`);
				expect(progress && progress.val).to.equal("2 ok, 0 failed, 0 not started");
				mock.state.autoCompleteMs = 0;
				mock.state.targets = mock.state.targets.filter(t => t.id !== "lxc:104");
			});

			it("shows a running job at the target and cancels it", async function () {
				this.timeout(20000);
				mock.state.startJobOnUpdate = true;
				await harness.states.setStateAsync(`${NS}.targets.web_lxc_101.updateNow`, true, false);
				await wait(2500);
				const jobState = await harness.states.getStateAsync(`${NS}.targets.web_lxc_101.jobState`);
				expect(jobState && jobState.val).to.equal("running");
				const running = await harness.states.getStateAsync(`${NS}.jobRunning`);
				expect(running && running.val).to.equal(true);
				expect(await harness.objects.getObjectAsync(`${NS}.jobs.uu_2.cancel`)).to.be.ok;

				// target deleted in Proxmox meanwhile → removed on the refresh after the job ended
				mock.state.targets = mock.state.targets.filter(t => t.id !== "lxc:103");
				// unknown value for a number field must not change the state type
				mock.state.targets.find(t => t.id === "lxc:101").security_updates = null;
				await harness.states.setStateAsync(`${NS}.jobs.uu_2.cancel`, true, false);
				await wait(4000);
				expect(mock.state.actions).to.deep.include(["cancel", "uu-2"]);
				const after = await harness.states.getStateAsync(`${NS}.targets.web_lxc_101.jobState`);
				expect(after && after.val).to.equal("interrupted");
				expect(await harness.objects.getObjectAsync(`${NS}.jobs.uu_2.cancel`)).to.not.be.ok;
			});

			it("keeps the state type when the API delivers null", async () => {
				const obj = await harness.objects.getObjectAsync(`${NS}.targets.web_lxc_101.security_updates`);
				expect(obj && obj.common.type).to.equal("number");
				const st = await harness.states.getStateAsync(`${NS}.targets.web_lxc_101.security_updates`);
				expect(st && st.val).to.equal(null);
			});

			it("does not touch user writes to non-button states", async () => {
				await harness.states.setStateAsync(`${NS}.targets.web_lxc_101.name`, "manual", false);
				await wait(500);
				const st = await harness.states.getStateAsync(`${NS}.targets.web_lxc_101.name`);
				expect(st && st.val).to.equal("manual");
			});

			it("notifies the interrupted job once and removes the deleted target", async () => {
				const ns = await harness.states.getStateAsync(`${NS}.info.notifyState`);
				const notified = JSON.parse(String(ns && ns.val));
				expect(notified.jobs).to.include("uu-2");
				expect(await harness.objects.getObjectAsync(`${NS}.targets.db_lxc_103`)).to.not.be.ok;
			});

			it("logs out when the adapter stops", async function () {
				this.timeout(10000);
				await harness.stopAdapter();
				await wait(500);
				expect(mock.state.sessions.size).to.equal(0);
			});
		});

		suite("With login data from the credentials manager", getHarness => {
			/** @type {any} */
			let mock;
			/** @type {any} */
			let harness;
			/** @type {(v: string) => string} */
			let encrypt;
			const NS = "ultimate-updater.0";
			const CRED = "system.credentials.uu-test";
			const wait = ms => new Promise(r => setTimeout(r, ms));

			before(async function () {
				this.timeout(60000);
				mock = await startMock();
				harness = getHarness();
				const sys = await harness.objects.getObjectAsync("system.config");
				const secret = String(sys.native.secret);
				encrypt = v =>
					[...v]
						.map((c, i) => String.fromCharCode(secret.charCodeAt(i % secret.length) ^ c.charCodeAt(0)))
						.join("");
				await harness.objects.setObjectAsync(CRED, {
					type: "config",
					common: { name: "UU test login" },
					native: { type: "custom", version: 1, encryptedFields: ["password"], login: "root@pam", password: encrypt("secret") },
				});
				const obj = await harness.objects.getObjectAsync(`system.adapter.${NS}`);
				Object.assign(obj.native, {
					ip: "127.0.0.1",
					port: mock.port,
					https: false,
					credentialMode: "manager",
					credentialId: CRED,
					username: "",
					password: "",
					realm: "",
				});
				await harness.objects.setObjectAsync(obj._id, obj);
				await harness.startAdapterAndWait();
				await wait(3000);
			});
			after(() => mock && mock.server.close());

			it("logs in with the credential", async () => {
				expect(mock.state.lastLogin).to.deep.include({ username: "root", realm: "pam", password: "secret" });
				const conn = await harness.states.getStateAsync(`${NS}.info.connection`);
				expect(conn && conn.val).to.equal(true);
			});

			it("uses changed login data right away", async function () {
				this.timeout(15000);
				const cred = await harness.objects.getObjectAsync(CRED);
				cred.native.login = "admin@pve";
				await harness.objects.setObjectAsync(CRED, cred);
				await wait(3000);
				expect(mock.state.lastLogin).to.deep.include({ username: "admin", realm: "pve" });
			});

			it("stops", async function () {
				this.timeout(10000);
				await harness.stopAdapter();
			});
		});
	},
});
