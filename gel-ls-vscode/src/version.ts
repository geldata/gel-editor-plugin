export interface Version {
    major: number
    minor: number
    dev: number | null
}

/**
 * Parses '7.0-dev.9502' into [7, 0, 9502].
 */
export function parseVersion(version: string): Version | null {
    const segments = version.split('+');

    const parts = segments[0].split('-');
    const maj_min = parts[0];
    const [maj, min] = maj_min.split('.');
    if (!maj || !min) {
        return null;
    }

    const prerelease = parts[1];
    let dev = null;
    if (prerelease) {
        const pre_parts = prerelease.split('.');
        if (pre_parts[0] == 'dev') {
            dev = Number.parseInt(pre_parts[1]);
        }
    }

    return {
        major: Number.parseInt(maj),
        minor: Number.parseInt(min),
        dev,
    }
}


/**
 * Compares two version numbers, potentially "-dev.N"
 */
export function isVersionLessOrEqual(a: Version, b: Version): boolean {
    if (a.major > b.major) {
        return false;
    }
    if (a.minor > b.minor) {
        return false;
    }

    // is be dev, but a is not?
    if (a.dev == null && b.dev != null) {
        return false;
    }

    // does a have a later dev number than b?
    if (a.dev != null && b.dev != null && a.dev > b.dev) {
        return false;
    }
    return true;
}

export function versionToString(version: Version | null): string {
    if (version == null) {
        return 'null'
    }

    if (version.dev) {
        return `${version.major}.${version.minor}-dev.${version.dev}`;
    }
    return `${version.major}.${version.minor}`;
}
