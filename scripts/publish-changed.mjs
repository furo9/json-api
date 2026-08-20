import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packagesDirectory = path.join(rootDirectory, "packages");
const dryRun = process.argv.includes("--dry-run");
const allowInitialPublish =
  process.env.ALLOW_INITIAL_PUBLISH === "true";

const entries = await readdir(packagesDirectory, { withFileTypes: true });
const packages = (
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const directory = path.join(packagesDirectory, entry.name);
        let manifestSource;
        try {
          manifestSource = await readFile(
            path.join(directory, "package.json"),
            "utf8",
          );
        } catch (error) {
          if (error.code === "ENOENT") return null;
          throw error;
        }
        const manifest = JSON.parse(manifestSource);
        return { directory, manifest };
      }),
  )
).filter(
  (workspacePackage) =>
    workspacePackage && !workspacePackage.manifest.private,
);

const packagesByName = new Map(
  packages.map((workspacePackage) => [
    workspacePackage.manifest.name,
    workspacePackage,
  ]),
);
const orderedPackages = topologicallySort(packages, packagesByName);

for (const workspacePackage of orderedPackages) {
  const { name, version } = workspacePackage.manifest;
  const publicationStatus = getPublicationStatus(name, version);
  if (publicationStatus === "published") {
    console.log(`Skipping ${name}@${version}; it is already published.`);
    continue;
  }
  if (
    publicationStatus === "uninitialized" &&
    !dryRun &&
    !allowInitialPublish
  ) {
    console.log(
      `Skipping ${name}@${version}; publish the package manually once before enabling automated releases.`,
    );
    continue;
  }

  const archiveDirectory = await mkdtemp(
    path.join(tmpdir(), "furo9-json-api-publish-"),
  );
  try {
    run("pnpm", ["pack", "--pack-destination", archiveDirectory], {
      cwd: workspacePackage.directory,
    });
    const archiveName =
      `${name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`;
    const archivePath = path.join(archiveDirectory, archiveName);
    run(
      "npm",
      [
        "publish",
        archivePath,
        "--access",
        "public",
        ...(dryRun ? ["--dry-run"] : []),
      ],
      { cwd: rootDirectory },
    );
    console.log(
      `${dryRun ? "Validated" : "Published"} ${name}@${version}.`,
    );
  } finally {
    await rm(archiveDirectory, { recursive: true, force: true });
  }
}

function getPublicationStatus(name, version) {
  if (npmViewExists(`${name}@${version}`)) return "published";
  return npmViewExists(name) ? "unpublished-version" : "uninitialized";
}

function npmViewExists(specifier) {
  const result = run(
    "npm",
    ["view", specifier, "version", "--json"],
    {
      cwd: rootDirectory,
      capture: true,
      allowFailure: true,
    },
  );
  if (result.status === 0) return true;

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (output.includes("E404") || output.includes("Not Found")) return false;

  throw new Error(`Unable to check ${specifier} on npm:\n${output}`);
}

function topologicallySort(workspacePackages, byName) {
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();

  function visit(workspacePackage) {
    const name = workspacePackage.manifest.name;
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      throw new Error(`Circular workspace dependency involving ${name}.`);
    }

    visiting.add(name);
    for (const dependencyName of getWorkspaceDependencies(
      workspacePackage.manifest,
      byName,
    )) {
      visit(byName.get(dependencyName));
    }
    visiting.delete(name);
    visited.add(name);
    ordered.push(workspacePackage);
  }

  for (const workspacePackage of workspacePackages) visit(workspacePackage);
  return ordered;
}

function getWorkspaceDependencies(manifest, byName) {
  const dependencyNames = new Set();
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (byName.has(name)) dependencyNames.add(name);
    }
  }
  return dependencyNames;
}

function run(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${command} ${args.join(" ")} exited with ${result.status}.`,
    );
  }
  return result;
}
