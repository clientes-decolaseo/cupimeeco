/**
 * Diagnóstico de cadeias de redirect em produção.
 * Somente leitura — não altera arquivos nem configuração.
 *
 * Uso:
 *   node scripts/check-redirect-chains.mjs
 */

const URLS = [
	'https://cupins.eco.br/blog/cupins',
	'https://cupins.eco.br/blog/dedetizacao',
	'https://cupins.eco.br/tipos-de-raticidas-e-rodenticidas-anticoagulantes',
];

const MAX_HOPS = 20;
const FETCH_TIMEOUT_MS = 15_000;

/** Status que indicam redirect HTTP. */
function isRedirectStatus(status) {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function resolveLocation(currentUrl, locationHeader) {
	if (!locationHeader) return null;
	try {
		return new URL(locationHeader, currentUrl).href;
	} catch {
		return null;
	}
}

/** True se o path final for a homepage ("/" ou equivalente). */
function isHomepage(urlString) {
	try {
		const u = new URL(urlString);
		const path = u.pathname.replace(/\/+$/, '') || '/';
		return path === '/' && !u.search && !u.hash;
	} catch {
		return false;
	}
}

/**
 * Segue redirects com fetch redirect:'manual' até o destino final.
 * @returns {{ hops: Array<{ url: string, status: number|null, location?: string|null, error?: string }>, finalUrl: string|null }}
 */
async function followChain(startUrl) {
	const hops = [];
	const seen = new Set();
	let current = startUrl;

	for (let i = 0; i <= MAX_HOPS; i++) {
		if (seen.has(current)) {
			hops.push({
				url: current,
				status: null,
				error: 'loop detectado (URL já visitada)',
			});
			return { hops, finalUrl: null };
		}
		seen.add(current);

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

		let res;
		try {
			res = await fetch(current, {
				method: 'GET',
				redirect: 'manual',
				signal: controller.signal,
				headers: {
					'user-agent': 'cupim-eco-check-redirect-chains/1.0',
					accept: 'text/html,*/*',
				},
			});
		} catch (err) {
			hops.push({
				url: current,
				status: null,
				error: err?.name === 'AbortError' ? 'timeout' : String(err?.message || err),
			});
			return { hops, finalUrl: null };
		} finally {
			clearTimeout(timer);
		}

		const location = res.headers.get('location');

		if (isRedirectStatus(res.status)) {
			const next = resolveLocation(current, location);
			hops.push({
				url: current,
				status: res.status,
				location: next ?? location,
			});
			if (!next) {
				hops.push({
					url: current,
					status: null,
					error: `redirect ${res.status} sem Location válida`,
				});
				return { hops, finalUrl: null };
			}
			current = next;
			continue;
		}

		// Destino final (200, 404, etc.)
		hops.push({ url: current, status: res.status });
		return { hops, finalUrl: current };
	}

	hops.push({
		url: current,
		status: null,
		error: `limite de ${MAX_HOPS} hops excedido`,
	});
	return { hops, finalUrl: null };
}

function formatChain(hops) {
	return hops
		.map((h, idx) => {
			const label = idx === 0 ? 'origem' : `hop ${idx}`;
			if (h.error) return `${label}: ${h.url}  [${h.error}]`;
			if (isRedirectStatus(h.status)) {
				return `${label}: ${h.url}  → ${h.status} → ${h.location}`;
			}
			return `${label}: ${h.url}  [${h.status}]`;
		})
		.join('\n  ');
}

async function main() {
	console.log('check-redirect-chains — produção (redirect: manual)\n');

	let homeWarnings = 0;

	for (const url of URLS) {
		console.log('─'.repeat(72));
		console.log(`URL: ${url}`);

		const { hops, finalUrl } = await followChain(url);

		console.log('Cadeia:');
		console.log(`  ${formatChain(hops)}`);

		const chainArrow = hops
			.map((h) => {
				const code = h.status != null ? String(h.status) : 'ERR';
				return `${h.url} (${code})`;
			})
			.join(' → ');
		console.log(`Resumo: ${chainArrow}`);

		if (finalUrl && isHomepage(finalUrl)) {
			homeWarnings++;
			console.log(
				'AVISO: destino final é a homepage ("/") — redirect-para-home; corrigir para a página de conteúdo equivalente mais próxima.',
			);
		} else if (finalUrl) {
			console.log(`Destino final: ${finalUrl}`);
		} else {
			console.log('Destino final: (cadeia interrompida)');
		}

		console.log('');
	}

	console.log('─'.repeat(72));
	if (homeWarnings > 0) {
		console.log(`Concluído com ${homeWarnings} aviso(s) de redirect-para-home.`);
		process.exitCode = 1;
	} else {
		console.log('Concluído — nenhum redirect-para-home detectado.');
	}
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
