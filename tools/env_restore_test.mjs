import fs from "node:fs";
// Unit test: setup-demo.mjs writes URLs/IDs into an env file and --teardown must put it back exactly.
// Usage: node env_restore_test.mjs      (works on temp files only)
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "setup-demo.mjs"), "utf8");
const grab = (a, b) => src.slice(src.indexOf(a), src.indexOf(b));
const code = grab("function parseEnv", "const cfgEnv") + "\n" + grab("function restoreEnvFile", "// ------------------------------------------------------------------ teardown\nif (args.teardown)")
  + "\nreturn { parseEnv, updateEnvFile, restoreEnvFile };";
const { parseEnv, updateEnvFile, restoreEnvFile } = new Function("fs", "ROOT", code)(fs, "/nonexistent");
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "ok  " : "FAIL"} ${label}`); if (!cond) failures++; };
const F = path.join(os.tmpdir(), `restore-test-${process.pid}.env`);
const U = { PAYMENTS_URL: "https://new-pay.test", CART_URL: "https://new-cart.test", PAYMENTS_MOCK_API_ID: "newpay", CART_MOCK_API_ID: "newcart" };
const setup = (updates) => updateEnvFile(F, updates).map(([key, previous, written]) => ({ key, previous, written }));

// 1) fresh keys added by setup: teardown must return the file to its exact original bytes
const original1 = "# demo app settings\nWMC_API_KEY=\"secret wmc # key\"\nWEBHOOK_API_KEY=whsecret123\nWEBHOOK_URL=https://webhook.site/wiremock\n";
fs.writeFileSync(F, original1);
let changes = setup(U);
check("setup added the four keys", changes.length === 4 && changes.every((c) => c.previous === null) && fs.readFileSync(F, "utf8").includes("PAYMENTS_MOCK_API_ID=newpay"));
let report = restoreEnvFile(F, { envChanges: changes });
check("teardown removed all four keys", report.every((l) => /removed/.test(l)) && report.length === 4);
check("the file is back to the exact original bytes (header gone too)", fs.readFileSync(F, "utf8") === original1);
check("secrets and the unrelated WEBHOOK_URL are untouched", /whsecret123/.test(fs.readFileSync(F, "utf8")) && /secret wmc # key/.test(fs.readFileSync(F, "utf8")));

// 2) keys that already existed (with a trailing comment): setup replaces them, teardown puts the raw original back
const original2 = "WMC_API_KEY=k\nPAYMENTS_URL=https://old-pay.test   # the old demo\nCART_URL=https://old-cart.test\n# a note\nPAYMENTS_MOCK_API_ID=oldpay\nCART_MOCK_API_ID=oldcart\n";
fs.writeFileSync(F, original2);
changes = setup(U);
check("setup replaced the existing lines in place", fs.readFileSync(F, "utf8").includes("PAYMENTS_URL=https://new-pay.test") && !fs.readFileSync(F, "utf8").includes("old-pay"));
report = restoreEnvFile(F, { envChanges: changes });
check("teardown restored each previous value", report.every((l) => /restored to/.test(l)));
check("file is back to the exact original bytes (including the trailing comment)", fs.readFileSync(F, "utf8") === original2);

// 3) you edited a key after setup: that key is left alone, the rest restored
fs.writeFileSync(F, original1);
changes = setup(U);
fs.writeFileSync(F, fs.readFileSync(F, "utf8").replace("CART_URL=https://new-cart.test", "CART_URL=https://my-own-cart.test"));
report = restoreEnvFile(F, { envChanges: changes });
const after3 = fs.readFileSync(F, "utf8");
check("the edited CART_URL was left as it is (and reported)", after3.includes("CART_URL=https://my-own-cart.test") && report.some((l) => /CART_URL: left as it is/.test(l)));
check("the other three keys were removed", !/PAYMENTS_URL|PAYMENTS_MOCK_API_ID|CART_MOCK_API_ID/.test(after3));

// 4) a state file from an older run (no change list): the four lines are removed while they still match
fs.writeFileSync(F, original1);
setup(U);
report = restoreEnvFile(F, { paymentsUrl: U.PAYMENTS_URL, cartUrl: U.CART_URL, paymentsMockApiId: "newpay", cartMockApiId: "newcart" });
check("legacy state file: the four keys removed, file back to the original", report.length === 4 && fs.readFileSync(F, "utf8") === original1);

// 5) idempotent / missing file
report = restoreEnvFile(F, { envChanges: [] });
check("restoring with nothing recorded changes nothing", fs.readFileSync(F, "utf8") === original1);
fs.rmSync(F);
check("a missing env file is reported, not an error", /no longer exists/.test(restoreEnvFile(F, { envChanges: changes })[0]));
console.log(failures ? `\n${failures} FAILED` : "\nALL ENV-RESTORE CHECKS PASSED");
process.exit(failures ? 1 : 0);
