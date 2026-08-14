/**
 * Prefill da coluna decisao_final em city-pages-audit.csv a partir de recomendacao:
 *   manter_e_enriquecer → manter
 *   consolidar          → consolidar
 *   revisar_manual      → "" (vazio — aguarda revisão)
 *
 * Sobrescreve city-pages-audit.csv (adiciona/atualiza a coluna).
 *
 * Uso:
 *   node scripts/prefill-city-decisions.mjs
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('.');
const CSV_PATH = path.join(ROOT, 'city-pages-audit.csv');

const PREFILL = {
	manter_e_enriquecer: 'manter',
	consolidar: 'consolidar',
	revisar_manual: '',
};

function parseCsv(text) {
	const rows = [];
	let row = [];
	let cell = '';
	let inQ = false;

	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		const n = text[i + 1];

		if (inQ) {
			if (c === '"' && n === '"') {
				cell += '"';
				i++;
				continue;
			}
			if (c === '"') {
				inQ = false;
				continue;
			}
			cell += c;
			continue;
		}

		if (c === '"') {
			inQ = true;
			continue;
		}
		if (c === ',') {
			row.push(cell);
			cell = '';
			continue;
		}
		if (c === '\n' || (c === '\r' && n === '\n')) {
			if (c === '\r') i++;
			row.push(cell);
			rows.push(row);
			row = [];
			cell = '';
			continue;
		}
		if (c === '\r') {
			row.push(cell);
			rows.push(row);
			row = [];
			cell = '';
			continue;
		}
		cell += c;
	}

	if (cell.length > 0 || row.length > 0) {
		row.push(cell);
		rows.push(row);
	}

	return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}

function csvEscape(value) {
	const str = String(value ?? '');
	if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
	return str;
}

async function main() {
	const text = await readFile(CSV_PATH, 'utf8');
	const matrix = parseCsv(text);

	if (matrix.length < 2) {
		throw new Error('city-pages-audit.csv vazio ou sem dados.');
	}

	const headers = matrix[0].map((h) => String(h).trim());
	const recIdx = headers.indexOf('recomendacao');
	if (recIdx === -1) {
		throw new Error('Coluna "recomendacao" ausente em city-pages-audit.csv.');
	}

	let decIdx = headers.indexOf('decisao_final');
	if (decIdx === -1) {
		headers.push('decisao_final');
		decIdx = headers.length - 1;
	}

	const counts = { manter: 0, consolidar: 0, vazio: 0, outros: 0 };

	const outRows = [headers];

	for (const cells of matrix.slice(1)) {
		const row = [...cells];
		while (row.length < headers.length) row.push('');

		const recomendacao = String(row[recIdx] ?? '').trim();
		let decisao = '';

		if (Object.prototype.hasOwnProperty.call(PREFILL, recomendacao)) {
			decisao = PREFILL[recomendacao];
		} else {
			counts.outros++;
			console.warn(`⚠ recomendacao desconhecida: ${JSON.stringify(recomendacao)}`);
		}

		row[decIdx] = decisao;

		if (decisao === 'manter') counts.manter++;
		else if (decisao === 'consolidar') counts.consolidar++;
		else counts.vazio++;

		outRows.push(row);
	}

	const body = outRows.map((r) => r.map(csvEscape).join(',')).join('\n') + '\n';
	await writeFile(CSV_PATH, body, 'utf8');

	console.log(`prefill-city-decisions → ${path.relative(ROOT, CSV_PATH)}`);
	console.log(`  manter:      ${counts.manter}`);
	console.log(`  consolidar:  ${counts.consolidar}`);
	console.log(`  vazio (manual): ${counts.vazio}`);
	if (counts.outros) console.log(`  outros/desconhecido: ${counts.outros}`);
	console.log(`  total:       ${counts.manter + counts.consolidar + counts.vazio}`);
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
