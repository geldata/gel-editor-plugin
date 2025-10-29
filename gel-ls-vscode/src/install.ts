import * as child_process from "node:child_process";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as semver from "semver";
import { Readable } from "node:stream";
import { LogOutputChannel, ProgressLocation, window } from "vscode";
import envPaths from "env-paths";
import { Stats } from "node:fs";
import { createGunzip } from 'node:zlib';

let clientLogger: LogOutputChannel;

const EDGEDB_PKG_ROOT = "https://packages.edgedb.com";

export interface Distribution {
    /**
     * Path of executable to run to start the server.
     */
    command: string;

    /**
     * Arguments to be passed to the executable when starting the server.
     */
    args: string[];

    /**
     * Version string returned by `gel-ls --version`
     */
    version: string;

    /**
     * True if installation is managed (and can be updated) by this extension.
     */
    managed: boolean;
}

interface Package {
    basename: string;
    name: string;
    version: string;
    version_details: {
        major: number,
        minor: number,
        patch: number | null,
        prerelease: { phase: string, number: number }[],
        metadata: {
            build_revision: string | null,
        }
    };
    revision: string;
    installref: string;
    installrefs: {
        ref: string,
        type: string,
        encoding: string,
        verification: {
            size: number,
            sha256: string,
            blake2b: string
        }
    }[]
}

/**
 * Search system path and edgedb data dir for a distribution of gel-ls.
 * If not found, download into edgedb data dir.
 */
export async function ensureInstalled(logger: LogOutputChannel): Promise<Distribution> {
    clientLogger = logger;

    // is gel-ls is installed in path?
    clientLogger.debug('looking for gel-ls in PATH');
    const inPath = await spawnForVersion('gel-ls');
    if (inPath) {
        clientLogger.debug('found');
        return { command: 'gel-ls', args: [], version: inPath, managed: false };
    }

    // determine install path
    const installDir = getInstallDir();
    const entrypoint = path.join(installDir, 'bin/gel-ls');

    clientLogger.debug(`looking for gel-ls in ${installDir}`);
    if (await isDirectory(installDir)) {
        const installed = await spawnForVersion(entrypoint);
        if (installed) {
            clientLogger.debug(`found`);
            return { command: entrypoint, args: [], version: installed, managed: true };
        } else {
            // the dir exists, but gel-ls does not work?
            throw new Error(`${installDir} exists, but it does not work`)
        }
    }

    // install
    clientLogger.debug(`gel-ls needs to be installed`);
    await install(installDir);

    const installed = await spawnForVersion(entrypoint);
    if (installed) {
        return { command: entrypoint, args: [], version: installed, managed: true };
    } else {
        throw new Error(`installed ${entrypoint}, but it does not work`)
    }
}

/**
 * Removes distribution of gel-ls from the file-system.
 */
export async function removeInstallation(): Promise<void> {
    const installDir = getInstallDir();
    try {
        clientLogger.info(`Removing installation dir: ${installDir}`);
        await fs.rm(installDir, { recursive: true, force: true });
    } catch (e) {
        clientLogger.debug(`Cannot remove installation: ${e}`);
    }
}

function getInstallDir(): string {
    return path.join(envPaths("edgedb", { suffix: null }).data, "gel-ls");
}

export async function spawnForVersion(executable_path: string): Promise<string | null> {
    clientLogger.trace(`running ${executable_path} --version`);

    // spawn the process
    const child = child_process.spawn(executable_path, ['--version'], {});
    const promise = new Promise((close, error) => {
        child.on('close', close);
        child.on('error', error);
    });
    const stdout = streamToString(child.stdout);

    try {
        await promise;
    } catch (e) {
        clientLogger.trace(`status: ${e.code}`);
        if (e.code == 'ENOENT' || e.code == 'EACCES') {
            return null;
        } else {
            throw e;
        }
    }

    clientLogger.trace(`status: ${child.exitCode}`);

    // if successful
    const output: string = await stdout;
    if (child.exitCode == 0) {
        const prefix1 = 'edgedb-ls, version ';
        const prefix2 = 'gel-ls, version ';
        if (output.startsWith(prefix1)) {
            return output.slice(prefix1.length);
        } else if (output.startsWith(prefix2)) {
            return output.slice(prefix2.length);
        } else {
            clientLogger.error(`unexpected "gel-ls --version output": ${output}`);
        }
    }

    return null
}

export async function isDirectory(path: string): Promise<boolean> {
    let stat: Stats;
    try {
        stat = await fs.stat(path);
    } catch (e) {
        if (e.code == 'ENOENT') {
            return false;
        }
        throw e;
    }
    return stat.isDirectory();
}

function streamToString(stream: Readable): Promise<string> {
    const chunks = [];
    return new Promise((resolve, reject) => {
        stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        stream.on('error', (err) => reject(err));
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    })
}

async function install(installDir: string) {
    let pkg = await findPackage('gel-ls', false);
    if (!pkg) {
        pkg = await findPackage('edgedb-ls', true);
    }

    const createDir = fs.mkdir(installDir, { recursive: true }).catch((error) => {
        if (error.code !== "EEXIST") throw error;
    });

    const installRef = pkg.installrefs.find(ref => ref.encoding == 'gzip');
    const installRefUrl = new URL(installRef.ref, EDGEDB_PKG_ROOT);

    clientLogger.info(`downloading ${installRefUrl}`);
    const response = await fetch(installRefUrl);
    if (!response.ok || !response.body) {
        throw new Error(`Cannot download: ${response.statusText}`);
    }
    const contentLength = Number.parseInt(response.headers.get('content-length'));

    await createDir;

    const tar = require('tar');
    const unpack = tar.extract({ cwd: installDir, strip: 1 }, []);

    const responseBody = Readable.fromWeb(response.body);
    downloadNotification(responseBody, contentLength);

    const done = new Promise((resolve, reject) => {
        unpack.on('close', resolve);
        unpack.on('error', reject);
    });

    responseBody.pipe(createGunzip()).pipe(unpack)
    await done;
}

function downloadNotification(responseBody: Readable, totalLength: number | null) {
    window.withProgress({
        location: ProgressLocation.Notification,
        title: 'Downloading gel-ls',
        cancellable: true
    }, (progress, cancelToken) => {
        cancelToken.onCancellationRequested(() => {
            responseBody.destroy();
        });

        if (totalLength) {
            progress.report({ increment: 0 });
            responseBody.on('data', (chunk) => {
                const increment = 100 * chunk.length / totalLength;
                progress.report({ increment });
            });
        }

        return new Promise<void>(resolve => {
            responseBody.on('close', resolve);
            responseBody.on('error', resolve);
        });
    });
}

async function findPackage(name: string, fail: boolean): Promise<Package> {
    const arch = os.arch();
    const platform = os.platform();
    const libc = null;
    const target = getTargetName(arch, platform, libc);

    const channel = 'nightly';
    const packages = await fetchPackages(target, channel);

    const versionRequirement = ">=4.1.1";
    const pkg = await getMatchingPkg(
        packages,
        name,
        versionRequirement
    );

    if (!pkg) {
        if (fail) {
            throw Error(
                `cannot find ${name} package, version ${versionRequirement} for ${target}.${channel}`
            );
        }
        return null;
    }
    clientLogger.debug(`found package ${pkg.name}, ${pkg.version}, ${pkg.revision}`);

    return pkg;
}

async function fetchPackages(target: string, channel: string): Promise<Package[]> {
    clientLogger.info(`fetching versions for ${target}.${channel}`);

    const index_name = target + (channel == 'release' ? '' : '.' + channel);
    const indexRequest = await fetch(
        new URL(`archive/.jsonindexes/${index_name}.json`, EDGEDB_PKG_ROOT)
    );
    const index = (await indexRequest.json()) as { packages: Package[] };
    return index.packages;
}

async function getMatchingPkg(
    packages: Package[],
    pkg_name: string,
    versionRequirement: string
): Promise<Package | null> {
    clientLogger.debug(`getting matching version for range: ${versionRequirement}`);

    return packages
        // filter by name
        .filter(pkg => pkg.basename === pkg_name)

        // filter by version requirement
        .filter(pkg => {
            const ver = semver.coerce(pkg.version); // if version does not have patch number, semver has problems
            return semver.satisfies(ver, versionRequirement, { includePrerelease: true })
        })

        .map(pkg => {
            clientLogger.trace(`pkg candidate: ${JSON.stringify(pkg.version_details)}`);
            return pkg;
        })

        // pick latest
        .reduce((best, curr) => (best == null || comparePackages(best, curr) < 0) ? curr : best, null);
}

function getTargetName(arch: string, platform: string, libc: string | null): string {
    let distArch = "";
    let distPlatform = "";

    if (platform === "linux") {
        if (!libc) {
            libc = "gnu";
        }
        distPlatform = `unknown-linux-${libc}`;
    } else if (platform === "darwin") {
        distPlatform = "apple-darwin";
    } else {
        throw Error(`this action cannot be run on ${platform}`);
    }

    if (arch === "x64") {
        distArch = "x86_64";
    } else if (arch === "arm64") {
        distArch = "aarch64";
    } else {
        throw Error(`this action does not support the ${arch} architecture`);
    }

    const target = `${distArch}-${distPlatform}`;
    clientLogger.debug(`package target: ${target}`);
    return target;
}

function comparePackages(a: Package, b: Package): number {
    if (a.version_details.major < b.version_details.major) {
        return -1;
    }
    if (a.version_details.major > b.version_details.major) {
        return 1;
    }
    if (a.version_details.minor < b.version_details.minor) {
        return -1;
    }
    if (a.version_details.minor > b.version_details.minor) {
        return 1;
    }

    const revisionA = Number.parseInt(a.version_details.metadata.build_revision ?? '0');
    const revisionB = Number.parseInt(b.version_details.metadata.build_revision ?? '0');
    return revisionA < revisionB ? -1 : 1;
}
