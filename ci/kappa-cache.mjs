// Input-addressed holo cache.
//
// A holo is a pure function of its inputs: the app's sources under prism/ and
// the SDK image prismpm.lock pins. So the build is keyed by the kappa (BLAKE3)
// of exactly those bytes, and a build whose kappa was already built anywhere
// in this owner's Prism apps is fetched instead of rebuilt. The kappa registry
// (registry.uor.foundation) is the discovery layer: it lists every Prism app,
// so lookups reach every app this owner has shipped. Each app's own container
// package on ghcr.io is the byte store, tagged by input kappa.
//
// A cached holo is never trusted: it is used only after its OCI digest, its
// self-fingerprint, its recorded input kappa and every acceptance vector it
// carries check out here. Any failure is a miss, and a miss is a full build.
// Nothing in this file can fail a build: errors are reported and fall through.
//
//   node ci/kappa-cache.mjs key                print the input kappa
//   node ci/kappa-cache.mjs restore <out.holo> fetch and verify, or report a miss
//   KAPPA=<kappa> node ci/kappa-cache.mjs save <app.holo>
//                                              store this build under the kappa
//                                              the lookup computed before it

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { kappa, load } from "../try/vendor/prism-code/src/index.mjs";

const SCHEMA = "prism/input-kappa/1";
const INPUTS = ["prism", "prismpm.lock"];
const PACKAGE = "prism-holo";
const MEDIA = "application/vnd.uor.prism.holo.v1";
const REGISTRY = process.env.PRISM_REGISTRY || "registry.uor.foundation";

const say = (text) => console.log(`kappa-cache: ${text}`);
const output = (name, value) => process.env.GITHUB_OUTPUT && appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const repository = () => (process.env.GITHUB_REPOSITORY || "").toLowerCase();

// The input kappa: every tracked file under the inputs, in byte order of path,
// each framed by its path and length so no two input sets share an encoding.
export function inputKappa() {
  const files = execFileSync("git", ["ls-files", "-z", "--", ...INPUTS], { encoding: "utf8" }).split("\0").filter(Boolean).sort();
  const parts = [Buffer.from(`${SCHEMA}\n`)];
  for (const path of files) {
    const bytes = readFileSync(path);
    parts.push(Buffer.from(`${path}\0${bytes.length}\0`), bytes);
  }
  return { kappa: kappa(Buffer.concat(parts)), files: files.length };
}
const tagOf = (k) => k.replace(":", "-");

async function token(name, actions) {
  const headers = {};
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_ACTOR) {
    headers.authorization = `Basic ${Buffer.from(`${process.env.GITHUB_ACTOR}:${process.env.GITHUB_TOKEN}`).toString("base64")}`;
  }
  const response = await fetch(`https://ghcr.io/token?service=ghcr.io&scope=repository:${name}:${actions}`, { headers });
  if (!response.ok) throw new Error(`ghcr token for ${name}: ${response.status}`);
  return (await response.json()).token;
}

// Every repository this owner has registered as a Prism app, this one first.
async function candidates() {
  const own = repository();
  const owner = own.split("/")[0];
  const list = [own];
  try {
    const pointer = await (await fetch(`https://${REGISTRY}/index/current.json`)).json();
    const index = await (await fetch(`https://${REGISTRY}/index/${pointer.path}`)).json();
    for (const app of index.apps ?? []) {
      const repo = String(app.repository ?? "").match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)\/?$/)?.[1]?.toLowerCase();
      if (repo && repo.split("/")[0] === owner && !list.includes(repo)) list.push(repo);
    }
  } catch (error) {
    say(`registry index unavailable (${error.message}); looking in this repository only`);
  }
  return list;
}

async function fetchEntry(repo, k) {
  const name = `${repo}/${PACKAGE}`;
  // ghcr answers a token request for a package that does not exist with 403.
  const bearer = await token(name, "pull").catch(() => null);
  if (!bearer) return null;
  const auth = { authorization: `Bearer ${bearer}` };
  const manifestResponse = await fetch(`https://ghcr.io/v2/${name}/manifests/${tagOf(k)}`, { headers: { ...auth, accept: "application/vnd.oci.image.manifest.v1+json" } });
  if (manifestResponse.status === 404 || manifestResponse.status === 401 || manifestResponse.status === 403) return null;
  if (!manifestResponse.ok) throw new Error(`manifest ${manifestResponse.status}`);
  const manifest = await manifestResponse.json();
  const layer = manifest.layers?.find((l) => l.mediaType === MEDIA);
  if (!layer) throw new Error("no holo layer");
  if (manifest.annotations?.["uor.prism.input-kappa"] !== k) throw new Error("recorded input kappa differs");
  const blob = Buffer.from(await (await fetch(`https://ghcr.io/v2/${name}/blobs/${layer.digest}`, { headers: auth })).arrayBuffer());
  if (sha256(blob) !== layer.digest) throw new Error("blob digest differs from its manifest");
  return { blob, annotations: manifest.annotations ?? {}, ref: `ghcr.io/${name}:${tagOf(k)}` };
}

// A holo is accepted only if it verifies itself and replays every example.
async function verify(blob) {
  const fingerprint = blob.subarray(blob.length - 32);
  if (kappa(blob.subarray(0, blob.length - 32)) !== `blake3:${fingerprint.toString("hex")}`) throw new Error("self-fingerprint fails");
  const app = await load(blob);
  const result = await app.acceptance();
  if (!(result.total > 0 && result.passed === result.total)) throw new Error(`${result.passed} of ${result.total} vectors passed`);
  return { name: app.name, vectors: result.total, fingerprint: fingerprint.toString("hex") };
}

async function restore(out) {
  const { kappa: k, files } = inputKappa();
  say(`input ${k} over ${files} files`);
  output("kappa", k);
  for (const repo of await candidates()) {
    const started = Date.now();
    try {
      const entry = await fetchEntry(repo, k);
      if (!entry) continue;
      const checked = await verify(entry.blob);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, entry.blob);
      say(`hit ${entry.ref}: ${checked.name}, ${checked.vectors} vectors replayed, fingerprint ${checked.fingerprint}, built by ${entry.annotations["uor.prism.run"] ?? "unknown run"} (${Date.now() - started} ms)`);
      output("hit", "true");
      output("from", entry.ref);
      output("built_by", entry.annotations["uor.prism.run"] ?? "");
      return;
    } catch (error) {
      say(`rejected ${repo}: ${error.message}`);
    }
  }
  say("miss: building");
  output("hit", "false");
}

async function save(holo) {
  // The kappa the lookup computed before the build: the build itself relocks
  // and reformats prism/, so recomputing it now would key different bytes.
  const k = process.env.KAPPA;
  if (!/^blake3:[0-9a-f]{64}$/.test(k ?? "")) throw new Error("KAPPA names no input kappa from the lookup");
  const repo = repository();
  const name = `${repo}/${PACKAGE}`;
  const blob = readFileSync(holo);
  const checked = await verify(blob);
  const bearer = await token(name, "pull,push");
  const auth = { authorization: `Bearer ${bearer}` };
  const put = async (bytes, type) => {
    const digest = sha256(bytes);
    const head = await fetch(`https://ghcr.io/v2/${name}/blobs/${digest}`, { method: "HEAD", headers: auth });
    if (head.ok) return digest;
    const start = await fetch(`https://ghcr.io/v2/${name}/blobs/uploads/`, { method: "POST", headers: auth });
    if (start.status !== 202) throw new Error(`upload start ${start.status}`);
    const location = new URL(start.headers.get("location"), "https://ghcr.io");
    location.searchParams.set("digest", digest);
    const done = await fetch(location, { method: "PUT", headers: { ...auth, "content-type": type }, body: bytes });
    if (done.status !== 201) throw new Error(`upload ${done.status}`);
    return digest;
  };
  const config = Buffer.from("{}");
  const manifest = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    artifactType: MEDIA,
    config: { mediaType: "application/vnd.oci.empty.v1+json", digest: await put(config, "application/octet-stream"), size: config.length },
    layers: [{ mediaType: MEDIA, digest: await put(blob, "application/octet-stream"), size: blob.length, annotations: { "org.opencontainers.image.title": `${checked.name}.holo` } }],
    annotations: {
      "org.opencontainers.image.source": `https://github.com/${repo}`,
      "org.opencontainers.image.description": `Prism holo for input ${k}`,
      "uor.prism.input-kappa": k,
      "uor.prism.fingerprint": `blake3:${checked.fingerprint}`,
      "uor.prism.commit": process.env.GITHUB_SHA ?? "",
      "uor.prism.run": process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : "",
    },
  };
  const response = await fetch(`https://ghcr.io/v2/${name}/manifests/${tagOf(k)}`, {
    method: "PUT",
    headers: { ...auth, "content-type": "application/vnd.oci.image.manifest.v1+json" },
    body: JSON.stringify(manifest),
  });
  if (response.status !== 201) throw new Error(`manifest ${response.status}: ${await response.text()}`);
  say(`saved ghcr.io/${name}:${tagOf(k)} (${checked.vectors} vectors replayed before saving)`);
}

const [mode, arg] = process.argv.slice(2);
try {
  if (mode === "key") console.log(inputKappa().kappa);
  else if (mode === "restore" && arg) await restore(arg);
  else if (mode === "save" && arg) await save(arg);
  else {
    console.error("usage: kappa-cache.mjs key | restore <out.holo> | save <app.holo>");
    process.exit(64);
  }
} catch (error) {
  // The cache only ever saves time; it never decides a build.
  say(`skipped: ${error.message}`);
  if (mode === "restore") output("hit", "false");
}
