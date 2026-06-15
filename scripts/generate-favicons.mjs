import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const PUBLIC = path.resolve('public');
const SVG = path.join(PUBLIC, 'favicon.svg');
const svg = await readFile(SVG);

const sizes = [
	{ name: 'favicon-16x16.png', size: 16 },
	{ name: 'favicon-32x32.png', size: 32 },
	{ name: 'apple-touch-icon.png', size: 180 },
];

for (const { name, size } of sizes) {
	const buffer = await sharp(svg).resize(size, size).png().toBuffer();
	await writeFile(path.join(PUBLIC, name), buffer);
	console.log(`Gerado: public/${name}`);
}

const png32 = await sharp(svg).resize(32, 32).png().toBuffer();
const png16 = await sharp(svg).resize(16, 16).png().toBuffer();

// ICO mínimo: cabeçalho + duas entradas PNG embutidas
function buildIco(images) {
	const header = Buffer.alloc(6);
	header.writeUInt16LE(0, 0);
	header.writeUInt16LE(1, 2);
	header.writeUInt16LE(images.length, 4);

	const entries = [];
	const blobs = [];

	let offset = 6 + images.length * 16;

	for (const { size, data } of images) {
		const entry = Buffer.alloc(16);
		entry.writeUInt8(size === 256 ? 0 : size, 0);
		entry.writeUInt8(size === 256 ? 0 : size, 1);
		entry.writeUInt8(0, 2);
		entry.writeUInt8(0, 3);
		entry.writeUInt16LE(1, 4);
		entry.writeUInt16LE(32, 6);
		entry.writeUInt32LE(data.length, 8);
		entry.writeUInt32LE(offset, 12);
		entries.push(entry);
		blobs.push(data);
		offset += data.length;
	}

	return Buffer.concat([header, ...entries, ...blobs]);
}

const ico = buildIco([
	{ size: 16, data: png16 },
	{ size: 32, data: png32 },
]);

await writeFile(path.join(PUBLIC, 'favicon.ico'), ico);
console.log('Gerado: public/favicon.ico');
