import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildRedirectMap, normalizeRedirectDestination } from './lib/redirect-map.mjs';

const ROOT = path.resolve('.');
const vercelPath = path.join(ROOT, 'vercel.json');

/** Wildcards — devem vir antes das regras exatas no Vercel. */
const WILDCARD_REDIRECTS = [
	{ source: '/d/:path*', destination: '/:path*', permanent: true },
	{ source: '/glossario/:path*', destination: '/blog/', permanent: true },
];

/** URLs com variação de maiúsculas/minúsculas (Vercel é case-sensitive). */
const CASE_ALIASES = [
	{ source: '/dedetizadora-em-Cotia', destination: '/dedetizadora-em-cotia/', permanent: true },
];

const vercel = JSON.parse(readFileSync(vercelPath, 'utf8'));
const redirectMap = buildRedirectMap();

const exactRedirects = [...redirectMap.entries()]
	.sort(([a], [b]) => a.localeCompare(b))
	.map(([from, to]) => ({
		source: `/${from}`,
		destination: normalizeRedirectDestination(to),
		permanent: true,
	}));

vercel.redirects = [...WILDCARD_REDIRECTS, ...CASE_ALIASES, ...exactRedirects];

writeFileSync(vercelPath, `${JSON.stringify(vercel, null, '\t')}\n`);

console.log(
	`vercel.json: ${WILDCARD_REDIRECTS.length} wildcards + ${exactRedirects.length} redirects 301 (${vercel.redirects.length} total)`,
);
