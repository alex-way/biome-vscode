import { chmodSync } from "node:fs";
import { coerce, rcompare } from "semver";
import { fetch } from "undici";
import {
	ExtensionContext,
	ProgressLocation,
	Uri,
	commands,
	window,
	workspace,
} from "vscode";
import { Commands } from "./commands";

export const selectAndDownload = async (
	context: ExtensionContext,
): Promise<string | undefined> => {
	const versions = await window.withProgress(
		{
			location: ProgressLocation.Notification,
			title: "Fetching Biome versions",
			cancellable: false,
		},
		async () => {
			return await getVersions(context);
		},
	);

	const version = await askVersion(versions);

	if (!version) {
		return undefined;
	}

	return await window.withProgress(
		{
			location: ProgressLocation.Notification,
			title: `Downloading Biome ${version}`,
			cancellable: false,
		},
		async () => {
			await commands.executeCommand(Commands.StopServer);
			await download(version, context);
			await commands.executeCommand(Commands.RestartLspServer);
			return version;
		},
	);
};

export const updateToLatest = async (context: ExtensionContext) => {
	await window.withProgress(
		{
			location: ProgressLocation.Notification,
			title: "Updating Biome version",
			cancellable: false,
		},
		async () => {
			const versions = await getVersions(context);
			const version = versions[0];
			await commands.executeCommand(Commands.StopServer);
			await download(version, context);
			await commands.executeCommand(Commands.RestartLspServer);
		},
	);
};

/**
 * Download the Biome CLI from GitHub
 *
 * @param version The version to download
 */
const download = async (version: string, context: ExtensionContext) => {
	const releases = (await (
		await fetch(
			`https://api.github.com/repos/biomejs/biome/releases/tags/cli/v${version}`,
		)
	).json()) as {
		assets: { name: string; browser_download_url: string }[];
	};

	const platformArch = `${process.platform}-${process.arch}`;

	// Find the asset for the current platform
	const asset = releases.assets.find(
		(asset) =>
			asset.name ===
			`biome-${platformArch}${process.platform === "win32" ? ".exe" : ""}`,
	);

	if (!asset) {
		window.showErrorMessage(
			`The specified version is not available for your platform/architecture (${platformArch}).`,
		);
		return;
	}

	let bin: ArrayBuffer;
	try {
		const blob = await fetch(asset.browser_download_url);
		bin = await blob.arrayBuffer();
	} catch {
		window.showErrorMessage(
			`Could not download the binary for your platform/architecture (${platformArch}).`,
		);
		return;
	}

	// Write binary file to disk
	await workspace.fs.writeFile(
		Uri.joinPath(
			context.globalStorageUri,
			"server",
			`biome${process.platform === "win32" ? ".exe" : ""}`,
		),
		new Uint8Array(bin),
	);

	// Make biome executable
	chmodSync(
		Uri.joinPath(
			context.globalStorageUri,
			"server",
			`biome${process.platform === "win32" ? ".exe" : ""}`,
		).fsPath,
		0o755,
	);

	// Record latest version
	await context.globalState.update("bundled_biome_version", version);
};

/**
 * Display the VS Code prompt for selection the version
 */
const askVersion = async (versions: string[]): Promise<string | undefined> => {
	const options = versions.map((version, index) => ({
		label: version,
		description: index === 0 ? "(latest)" : "",
	}));

	const result = await window.showQuickPick(options, {
		placeHolder: "Select the version of the biome CLI to install",
	});

	return result?.label;
};

/**
 * Retrieves the list of versions of the CLI.
 *
 * The calls to the API are cached for 1 hour to prevent hitting the rate limit.
 */
export const getVersions = async (
	context: ExtensionContext,
): Promise<string[] | undefined> => {
	const cachedVersions = context.globalState.get<{
		expires_at: Date;
		versions: string[];
	}>("biome_versions_cache");

	// If the cache exists and is still valid, return it
	if (cachedVersions && new Date(cachedVersions.expires_at) > new Date()) {
		return cachedVersions.versions;
	}

	let releases = undefined;
	try {
		releases = (await (
			await fetch(
				"https://api.github.com/repos/biomejs/biome/releases?per_page=100",
			)
		).json()) as { tag_name: string }[];
	} catch (e) {
		releases = undefined;
	}

	if (!releases) {
		return undefined;
	}

	const versions = releases
		.filter((release) => release.tag_name.startsWith("cli/"))
		.map((release) => release.tag_name.replace("cli/", ""))
		.map((release) => coerce(release))
		.sort((a, b) => rcompare(a, b))
		.filter((release) => release?.version !== null)
		.map((release) => release?.version);

	// Cache the result for 1 hour
	await context.globalState.update("biome_versions_cache", {
		expires_at: new Date(Date.now() + 60 * 60 * 1000),
		versions,
	});

	return versions;
};
