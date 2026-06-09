import cidadesGsp from '../data/cidades-gsp.json';

export interface MunicipioAtendido {
	nome: string;
	regiao: string;
}

export interface RegiaoAtendida {
	id: string;
	label: string;
	ordem: number;
	intro: string;
}

export interface ResolvedCity {
	id: string;
	nome: string;
	regiaoId: string;
	atendida: boolean;
}

const regioes = cidadesGsp.regioes as RegiaoAtendida[];
const municipios = cidadesGsp.municipios as Record<string, MunicipioAtendido>;
const aliases = cidadesGsp.aliases as Record<string, string>;
const bairrosSaoPaulo = new Set(cidadesGsp.bairrosSaoPaulo as string[]);
const ordemCidades = cidadesGsp.ordemCidades as string[];

const regioesMap = new Map(regioes.map((r) => [r.id, r]));
const ordemIndex = new Map(ordemCidades.map((id, index) => [id, index]));

const SERVED_SLUGS = new Set(Object.keys(municipios));

export function getRegioesAtendidas(): RegiaoAtendida[] {
	return regioes;
}

export function getMunicipiosAtendidos(): Record<string, MunicipioAtendido> {
	return municipios;
}

export function isServedCityId(cityId: string): boolean {
	return cityId === 'sao-paulo' || SERVED_SLUGS.has(cityId);
}

export function getRegiaoLabel(regiaoId: string): string {
	return regioesMap.get(regiaoId)?.label ?? 'Outras localidades';
}

export function getRegiaoOrdem(regiaoId: string): number {
	return regioesMap.get(regiaoId)?.ordem ?? 99;
}

export function getRegiaoIntro(regiaoId: string): string {
	return regioesMap.get(regiaoId)?.intro ?? '';
}

export function compareCityOrder(aId: string, bId: string): number {
	const ai = ordemIndex.get(aId) ?? 999;
	const bi = ordemIndex.get(bId) ?? 999;
	if (ai !== bi) return ai - bi;
	return aId.localeCompare(bId, 'pt-BR');
}

function decodeHtml(text: string): string {
	return text
		.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
		.replace(/&amp;/g, '&')
		.replace(/&nbsp;/g, ' ')
		.trim();
}

function slugify(text: string): string {
	return text
		.toLowerCase()
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

export function extractLocationFromPath(path: string): string | null {
	const segment = path.split('/').pop() ?? path;
	const match = segment.match(
		/(?:descupinizacao|descupinizadora|dedetizacao|desinsetizacao|dedetizadora-de-cupim|dedetizadora-de-rato|dedetizadora-de-mosquito|dedetizadora-em|dedetizadora-de-barata|dedetizadora-de-formiga|dedetizadora-de-pulga|dedetizadora-de-escorpiao|desratizacao|desratizadora|sanitizacao|controle-de-mosquito|empresa-de-descupinizacao|empresa-de-dedetizacao|limpeza|desentupidora|hidrojateamento)(?:-em|-no|-na|-de)?-(.+)$/i,
	);

	return match ? match[1].replace(/-\d+$/, '') : null;
}

function parseCityFromTitle(title: string): string | null {
	const clean = decodeHtml(title);
	const match =
		clean.match(/\b(?:em|na|no)\s+(.+)$/i) ||
		clean.match(/\b(?:em|na|no)\s+(.+?)(?:\s*[-|]|$)/i);

	if (!match) return null;

	return match[1]
		.replace(/\s+\d+.*$/, '')
		.replace(/\s+/g, ' ')
		.trim();
}

function resolveMunicipioSlug(slug: string): string | null {
	if (municipios[slug]) return slug;
	if (bairrosSaoPaulo.has(slug)) return 'sao-paulo';

	const aliasKey = slug.replace(/-/g, ' ');
	if (aliases[aliasKey]) return aliases[aliasKey];
	if (aliases[slug]) return aliases[slug];

	return null;
}

function titleCase(text: string): string {
	return text
		.split(/\s+/)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
		.join(' ');
}

export function resolveCityFromPage(page: {
	path: string;
	title: string;
}): ResolvedCity {
	const pathSlug = extractLocationFromPath(page.path);
	const titleCity = parseCityFromTitle(page.title);

	if (pathSlug) {
		const municipioSlug = resolveMunicipioSlug(pathSlug);

		if (municipioSlug && municipios[municipioSlug]) {
			return {
				id: municipioSlug,
				nome: municipios[municipioSlug].nome,
				regiaoId: municipios[municipioSlug].regiao,
				atendida: true,
			};
		}

		if (bairrosSaoPaulo.has(pathSlug)) {
			return {
				id: 'sao-paulo',
				nome: 'São Paulo',
				regiaoId: 'regiao-sp',
				atendida: true,
			};
		}
	}

	if (titleCity) {
		const titleSlug = slugify(titleCity);
		const aliasSlug = aliases[titleSlug] ?? aliases[titleCity.toLowerCase()];
		const municipioSlug = aliasSlug ?? (municipios[titleSlug] ? titleSlug : null);

		if (municipioSlug && municipios[municipioSlug]) {
			return {
				id: municipioSlug,
				nome: municipios[municipioSlug].nome,
				regiaoId: municipios[municipioSlug].regiao,
				atendida: true,
			};
		}

		if (/zona\s+(norte|sul|leste|oeste)/i.test(titleCity)) {
			return {
				id: 'sao-paulo',
				nome: 'São Paulo',
				regiaoId: 'regiao-sp',
				atendida: true,
			};
		}
	}

	const fallbackSlug = pathSlug ? slugify(pathSlug) : titleCity ? slugify(titleCity) : 'desconhecida';

	return {
		id: fallbackSlug,
		nome: titleCity ? titleCase(titleCity) : titleCase((pathSlug ?? 'desconhecida').replace(/-/g, ' ')),
		regiaoId: 'fora',
		atendida: false,
	};
}

export function isPageInServiceArea(page: { path: string; title: string }): boolean {
	return resolveCityFromPage(page).atendida;
}

export function listCidadesAtendidas(): Array<{ id: string; nome: string; regiaoId: string }> {
	return ordemCidades.map((id) => ({
		id,
		nome: municipios[id].nome,
		regiaoId: municipios[id].regiao,
	}));
}

export interface RegiaoComCidades {
	regiaoId: string;
	regiaoLabel: string;
	regiaoIntro: string;
	regiaoOrdem: number;
	cidades: Array<{ id: string; nome: string }>;
}

export function getRegioesComCidades(): RegiaoComCidades[] {
	const porRegiao = new Map<string, Array<{ id: string; nome: string }>>();

	for (const cidade of listCidadesAtendidas()) {
		if (!porRegiao.has(cidade.regiaoId)) {
			porRegiao.set(cidade.regiaoId, []);
		}

		porRegiao.get(cidade.regiaoId)!.push({ id: cidade.id, nome: cidade.nome });
	}

	return regioes
		.map((regiao) => ({
			regiaoId: regiao.id,
			regiaoLabel: regiao.label,
			regiaoIntro: regiao.intro,
			regiaoOrdem: regiao.ordem,
			cidades: porRegiao.get(regiao.id) ?? [],
		}))
		.filter((item) => item.cidades.length > 0)
		.sort((a, b) => a.regiaoOrdem - b.regiaoOrdem);
}
