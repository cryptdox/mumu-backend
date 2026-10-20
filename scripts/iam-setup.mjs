#!/usr/bin/env node
/**
 * Provision the MuMu app's IAM resources and role grants on client "mu".
 *
 *   node scripts/iam-setup.mjs            # dry run: reads IAM, prints the plan
 *   node scripts/iam-setup.mjs --apply    # creates missing MU_* resources, grants roles per role-matrix.json
 *
 * Additive only: never deletes resources or removes a role's permissions
 * (uses /api/permission/role/:roleId/assign, not the replace-all endpoint).
 *
 * Env (or a scripts/.iam.env file with KEY=value lines — gitignored):
 *   IAM_URL          default http://localhost:3000
 *   IAM_CLIENT_ID    default mu
 *   IAM_ACCESS_CODE  default eqH5lA (x-cr-access-code of mu @ CRYPTDOX)
 *   IAM_EMAIL        default cryptdox.ethos@gmail.com (realm owner — can manage the client)
 *   IAM_PASSWORD     prompted for (hidden) when unset
 *   IAM_TOKEN        skip login and use this access token
 *   IAM_CAPTCHA_TOKEN only when IAM runs with PHASE=PROD
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(DIR, ".iam.env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const APPLY = process.argv.includes("--apply");
const IAM_URL = (process.env.IAM_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const CLIENT_ID = process.env.IAM_CLIENT_ID ?? "mu";
const ACCESS_CODE = process.env.IAM_ACCESS_CODE ?? "eqH5lA";
const EMAIL = process.env.IAM_EMAIL ?? "cryptdox.ethos@gmail.com";
const TYPE = "API_ENDPOINT";
const ACTIONS = ["CREATE", "READ", "READ_ALL", "UPDATE", "DELETE"];
const matrix = JSON.parse(fs.readFileSync(path.join(DIR, "role-matrix.json"), "utf8"));
const ROLES = Object.keys(matrix).filter((k) => !k.startsWith("_"));
// Every resource named anywhere in the matrix, each with all five actions.
const RESOURCES = [...new Set(ROLES.flatMap((r) => Object.keys(matrix[r])))];

let token = process.env.IAM_TOKEN ?? "";

function die(msg) {
  console.error(`\n✘ ${msg}`);
  process.exit(1);
}

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => {
      if (s.includes(question)) rl.output.write(s);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function call(method, urlPath, { body, headers = {}, auth = true } = {}) {
  const res = await fetch(IAM_URL + urlPath, {
    method,
    headers: { ...(body !== undefined && { "content-type": "application/json" }), ...(auth && token && { authorization: `Bearer ${token}` }), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.success === false) throw new Error(`${method} ${urlPath} → HTTP ${res.status}: ${json?.message ?? res.statusText}`);
  return json?.data ?? json;
}

const itemsOf = (data) => (Array.isArray(data) ? data : data?.items ?? []);
const resourceClientId = (r) => r.clientIdInternal ?? r.realmId; // IAM names it realmId in lists

async function listAll(p) {
  const out = [];
  const sep = p.includes("?") ? "&" : "?";
  for (let offset = 0; ; offset += 100) {
    const data = await call("GET", `${p}${sep}offset=${offset}&limit=100`);
    const items = itemsOf(data);
    out.push(...items);
    const total = typeof data?.total === "number" ? data.total : out.length;
    if (items.length < 100 || out.length >= total) break;
  }
  return out;
}

function keysFor(role) {
  return Object.entries(matrix[role]).flatMap(([res, actions]) => (actions === "*" ? ACTIONS : actions).map((a) => `${res}:${a}`));
}

async function main() {
  console.log(`IAM ${IAM_URL} · client "${CLIENT_ID}" · ${APPLY ? "APPLY" : "DRY RUN"}\n`);
  if (!token) {
    const password = process.env.IAM_PASSWORD || (await askHidden(`IAM password for ${EMAIL}: `));
    const data = await call("POST", "/api/auth/login", {
      auth: false,
      headers: { "x-cr-access-code": ACCESS_CODE },
      body: { email: EMAIL, password, captchaToken: process.env.IAM_CAPTCHA_TOKEN || "XXXX.DUMMY.TOKEN.XXXX" },
    });
    token = data.accessToken;
    if (!token) die("Login returned no access token");
    console.log(`✔ Signed in as ${EMAIL}`);
  }

  const client = (await listAll(`/api/client?search=${encodeURIComponent(CLIENT_ID)}`)).find((c) => c.clientId === CLIENT_ID);
  if (!client) die(`Client "${CLIENT_ID}" not found`);
  const cid = client.clientIdInternal;
  console.log(`✔ Client ${CLIENT_ID} → ${cid}`);

  const roles = itemsOf(await call("GET", `/api/role/client/${cid}?limit=100`));
  console.log(`✔ Roles: ${roles.map((r) => r.name).join(", ")}`);

  // 1. Resources (IAM's POST /api/resource is an upsert and also grants ADMIN every action)
  const existing = (await listAll(`/api/resource?clientIdInternal=${cid}`)).filter((r) => resourceClientId(r) === cid && r.type === TYPE);
  const missing = RESOURCES.filter((name) => {
    const cur = existing.find((r) => r.name === name);
    return !cur || ACTIONS.some((a) => !(cur.actions ?? []).includes(a));
  });
  console.log(`\nResources: ${RESOURCES.length} wanted, ${missing.length} to create/extend${missing.length ? `: ${missing.join(", ")}` : ""}`);
  if (missing.length && APPLY) {
    await call("POST", "/api/resource", {
      body: { clientId: CLIENT_ID, resources: missing.map((name) => ({ name, permissions: [{ type: TYPE, actions: ACTIONS }] })) },
    });
    console.log(`  ✔ upserted ${missing.length}`);
  }

  // 2. Permission ids ("MU_POST:CREATE" → id)
  const permId = new Map();
  for (const p of await listAll(`/api/permission/client/${cid}`)) {
    if (p.resource?.type === TYPE && RESOURCES.includes(p.resource?.name)) permId.set(`${p.resource.name}:${p.action}`, p.permissionId);
  }

  // 3. Role grants
  for (const roleName of ROLES) {
    const role = roles.find((r) => r.name === roleName);
    if (!role) {
      console.log(`\n! ${roleName}: not a role of ${CLIENT_ID} — skipped`);
      continue;
    }
    const want = keysFor(roleName);
    const have = new Set((await listAll(`/api/permission/role/${role.roleId}`)).map((p) => p.permissionId));
    const todo = want.filter((k) => !permId.has(k) || !have.has(permId.get(k)));
    console.log(`\n${roleName}: wants ${want.length}, missing ${todo.length}`);
    if (!todo.length) continue;
    if (!APPLY) {
      console.log(`  + would grant ${todo.join(", ")}`);
      continue;
    }
    const unresolved = todo.filter((k) => !permId.has(k));
    if (unresolved.length) die(`Permissions not found (create resources first): ${unresolved.join(", ")}`);
    await call("POST", `/api/permission/role/${role.roleId}/assign`, { body: { permissionIds: todo.map((k) => permId.get(k)) } });
    console.log(`  ✔ granted ${todo.length}`);
  }

  console.log(APPLY ? "\n✔ Done. Users get the new permissions at their next login / token refresh." : "\nDry run only — re-run with --apply.");
}

main().catch((err) => die(err.message));
