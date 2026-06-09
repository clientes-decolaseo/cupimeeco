import cidadesGsp from '../../src/data/cidades-gsp.json' with { type: 'json' };

const municipios = cidadesGsp.municipios;
const aliases = cidadesGsp.aliases;
const bairrosSaoPaulo = new Set(cidadesGsp.bairrosSaoPaulo);

function decodeHtml(text) {
	return text
		.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
		.replace(/&amp;/g, '&')
		.trim();
}

function slugify(text) {
	return text
		.toLowerCase()
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

export function extractLocationFromPath(path) {
	const segment = path.split('/').pop() ?? path;
	const match = segment.match(
		/(?:descupinizacao|descupinizadora|dedetizacao|desinsetizacao|dedetizadora-de-cupim|dedetizadora-de-rato|dedetizadora-em|dedetizadora-de-barata|dedetizadora-de-formiga|dedetizadora-de-pulga|dedetizadora-de-escorpiao|desratizacao|desratizadora|empresa-de-descupinizacao|empresa-de-dedetizacao|limpeza|desentupidora|hidrojateamento)(?:-em|-no|-na|-de)?-(.+)$/i,
	);
	return match ? match[1].replace(/-\d+$/, '') : null;
}

function parseCityFromTitle(title) {
	const clean = decodeHtml(title);
	const match = clean.match(/\b(?:em|na|no)\s+(.+)$/i);
	if (!match) return null;
	return match[1].replace(/\s+\d+.*$/, '').trim();
}

function resolveMunicipioSlug(slug) {
	if (municipios[slug]) return slug;
	if (bairrosSaoPaulo.has(slug)) return 'sao-paulo';
	const aliasKey = slug.replace(/-/g, ' ');
	if (aliases[aliasKey]) return aliases[aliasKey];
	if (aliases[slug]) return aliases[slug];
	return null;
}

export function resolveCityFromPage(page) {
	const pathSlug = extractLocationFromPath(page.path);
	const titleCity = parseCityFromTitle(page.title);

	if (pathSlug) {
		const municipioSlug = resolveMunicipioSlug(pathSlug);
		if (municipioSlug && municipios[municipioSlug]) {
			return { id: municipioSlug, atendida: true };
		}
		if (bairrosSaoPaulo.has(pathSlug)) {
			return { id: 'sao-paulo', atendida: true };
		}
	}

	if (titleCity) {
		const titleSlug = slugify(titleCity);
		const aliasSlug = aliases[titleSlug] ?? aliases[titleCity.toLowerCase()];
		const municipioSlug = aliasSlug ?? (municipios[titleSlug] ? titleSlug : null);
		if (municipioSlug && municipios[municipioSlug]) {
			return { id: municipioSlug, atendida: true };
		}
		if (/zona\s+(norte|sul|leste|oeste)/i.test(titleCity)) {
			return { id: 'sao-paulo', atendida: true };
		}
	}

	return { id: pathSlug ?? 'fora', atendida: false };
}

export function isPageInServiceArea(page) {
	return resolveCityFromPage(page).atendida;
}
