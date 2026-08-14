#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const MANIFEST_URL =
	"https://fonts.google.com/download/list?" +
	"family=Material%20Symbols%20Rounded";
const SOURCE_FILENAME = "static/MaterialSymbolsRounded-Regular.ttf";
const OUTPUT_PATH = path.join("src", "fonts", "uosc_icons.ttf");
const MAX_DOWNLOAD_SIZE = 20 * 1024 * 1024;

async function download(url) {
	const response = await fetch(url, {
		headers: {
			Accept: "application/json,application/octet-stream,*/*",
			"User-Agent": "uosc-font-updater/1.0",
		},
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) {
		throw new Error(`Download from ${url} failed with HTTP ${response.status}`);
	}
	if (!response.body) {
		throw new Error(`Download from ${url} did not contain a response body`);
	}

	const chunks = [];
	let size = 0;
	for await (const chunk of response.body) {
		size += chunk.length;
		if (size > MAX_DOWNLOAD_SIZE) {
			throw new Error(`Download from ${url} exceeded ${MAX_DOWNLOAD_SIZE} bytes`);
		}
		chunks.push(chunk);
	}
	return Buffer.concat(chunks, size);
}

function parseManifest(content) {
	// Google prepends an XSSI guard (`)]}'`) before the JSON document.
	const jsonStart = content.indexOf(0x7b);
	if (jsonStart < 0) {
		throw new Error("Google Fonts response did not contain a JSON object");
	}
	try {
		return JSON.parse(content.subarray(jsonStart).toString("utf8"));
	} catch (error) {
		throw new Error("Google Fonts response contained invalid JSON", {
			cause: error,
		});
	}
}

function findFontUrl(manifest) {
	const fileRefs = manifest?.manifest?.fileRefs;
	if (!Array.isArray(fileRefs)) {
		throw new Error("Google Fonts manifest did not contain file references");
	}

	const matches = fileRefs.filter(
		(fileRef) => fileRef?.filename === SOURCE_FILENAME,
	);
	if (matches.length !== 1) {
		throw new Error(
			`Expected one ${JSON.stringify(SOURCE_FILENAME)} entry, found ${matches.length}`,
		);
	}

	if (typeof matches[0].url !== "string") {
		throw new Error("Manifest font entry did not contain a URL");
	}
	const fontUrl = new URL(matches[0].url);
	if (fontUrl.protocol !== "https:" || fontUrl.hostname !== "fonts.gstatic.com") {
		throw new Error(`Manifest contained an unexpected font URL: ${fontUrl}`);
	}
	return fontUrl;
}

function validateFont(content) {
	if (content.length < 12) {
		throw new Error("Downloaded font is too small to contain an sfnt header");
	}

	const signatures = new Set(["00010000", "4f54544f", "74727565", "74797031"]);
	const signature = content.subarray(0, 4).toString("hex");
	if (!signatures.has(signature)) {
		throw new Error(`Downloaded file has an invalid sfnt signature: ${signature}`);
	}

	const tableCount = content.readUInt16BE(4);
	if (tableCount === 0 || 12 + tableCount * 16 > content.length) {
		throw new Error("Downloaded font has an invalid sfnt table directory");
	}
}

async function replaceFont(content) {
	await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
	const temporaryPath = path.join(
		path.dirname(OUTPUT_PATH),
		`.${path.basename(OUTPUT_PATH)}.${randomUUID()}.tmp`,
	);
	try {
		await writeFile(temporaryPath, content);
		await rename(temporaryPath, OUTPUT_PATH);
	} catch (error) {
		await rm(temporaryPath, { force: true });
		throw error;
	}
}

async function main() {
	const manifest = parseManifest(await download(MANIFEST_URL));
	const fontUrl = findFontUrl(manifest);
	const font = await download(fontUrl);
	validateFont(font);
	await replaceFont(font);

	const digest = createHash("sha256").update(font).digest("hex");
	console.log(`Updated ${OUTPUT_PATH} from ${SOURCE_FILENAME}`);
	console.log(`Size: ${font.length} bytes`);
	console.log(`SHA-256: ${digest}`);
}

await main();
