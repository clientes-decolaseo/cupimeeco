import cityQualityGate from '../data/seo/city-quality-gate.json';

export interface CityQualityGateResult {
	gated: boolean;
	passes: boolean;
	noindex: boolean;
	words: number;
	hasBairroReal: boolean;
	hasPrazoReal: boolean;
	hasEspecieRegional: boolean;
}

const MIN_UNIQUE_WORDS = cityQualityGate.minUniqueWords ?? 300;

function normalizePathKey(itemPath: string): string {
	return itemPath.replace(/^\/+|\/+$/g, '').toLowerCase();
}

/** Comparação de topônimo/bairro: minúsculas, sem acento, hífen = espaço. */
function normalizeToken(value = ''): string {
	return String(value)
		.toLowerCase()
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.replace(/[-_]+/g, ' ')
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Folha do slug após em/na/no — “dedetizadora-em-taubate” → “taubate”. */
export function extractToponymFromPath(itemPath: string): string {
	const leaf = normalizePathKey(itemPath).split('/').pop() || '';
	const m = leaf.match(/-(?:em|na|no|nas|nos)-(.+)$/i);
	return normalizeToken(m ? m[1] : leaf);
}

const gatedKeys = new Set((cityQualityGate.gated ?? []).map((p) => normalizePathKey(p)));

const bairrosPorPraca = new Map(
	Object.entries(cityQualityGate.bairrosPorPraca ?? {}).map(([path, names]) => [
		normalizePathKey(path),
		(names ?? []).map(String),
	]),
);

const especiesPorPraca = new Map(
	Object.entries(cityQualityGate.especiesRegionais ?? {}).map(([path, names]) => [
		normalizePathKey(path),
		(names ?? []).map(String),
	]),
);

/** Atendimento 24h não é prazo de garantia do serviço. */
const ATENDIMENTO_24H_RE =
	/\b(?:atendimento|plant[aã]o|emerg[eê]ncia|central)\b.{0,24}\b24\s*h(?:oras?)?\b|\b24\s*h(?:oras?)?\b.{0,24}\b(?:atendimento|plant[aã]o|emerg[eê]ncia|central)\b/gi;

/** Tempo de empresa / mercado — não é garantia de serviço. */
const EMPRESA_IDADE_RE =
	/\b(?:h[aá]\s+)?\d{1,2}\s*anos?\s+(?:de\s+)?(?:mercado|experi[eê]ncia|empresa|atua[cç][aã]o|hist[oó]ria)\b|\b(?:atuante|atua|fundada|fundado)\s+h[aá]\s+\d{1,2}\s*anos?\b/gi;

/**
 * Garantia de serviço com número + unidade, colada à palavra garantia.
 * Aceita: “garantia de 12 meses”, “garantia de até 6 meses”, “2 anos de garantia”.
 * Rejeita: “garantia. … 15 anos”, “garantia pode ser de 1 a 5 anos”.
 */
const GARANTIA_SERVICO_RE =
	/\bgarantia\s+(?:do\s+servi[cç]o\s+)?(?:de\s+|por\s+)?(?:at[eé]\s+)?(\d{1,2})\s*(dias?|meses?|anos?)\b|\b(\d{1,2})\s*(dias?|meses?|anos?)\s+de\s+garantia\b/gi;

function stripHtml(html = ''): string {
	return String(html)
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/gi, ' ')
		.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
		.replace(/&[a-z]+;/gi, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function countWords(text: string): number {
	const parts = text.split(/\s+/).filter(Boolean);
	return parts.length;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** “saúde” isolado (pública, sua saúde, Ministério da Saúde) nunca é bairro. */
function isSaudeAmbiguous(nameNorm: string): boolean {
	return nameNorm === 'saude';
}

function textHasListedName(plain: string, name: string): boolean {
	const nameNorm = normalizeToken(name);
	if (!nameNorm || isSaudeAmbiguous(nameNorm)) return false;

	const plainNorm = normalizeToken(plain);
	const re = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(nameNorm)}(?:[^a-z0-9]|$)`);
	return re.test(plainNorm);
}

function hasRealBairro(plain: string, pathKey: string): boolean {
	const names = bairrosPorPraca.get(pathKey) ?? [];
	const toponym = extractToponymFromPath(pathKey);

	return names.some((name) => {
		const nameNorm = normalizeToken(name);
		if (!nameNorm || isSaudeAmbiguous(nameNorm)) return false;
		if (nameNorm === toponym) return false;
		return textHasListedName(plain, name);
	});
}

function hasRegionalSpecies(plain: string, pathKey: string): boolean {
	const names = especiesPorPraca.get(pathKey) ?? [];
	return names.some((name) => name && textHasListedName(plain, name));
}

function hasRealPrazo(plain: string): boolean {
	if (!plain || /\[confirmar\]/i.test(plain)) return false;

	const cleaned = plain.replace(ATENDIMENTO_24H_RE, ' ').replace(EMPRESA_IDADE_RE, ' ');
	GARANTIA_SERVICO_RE.lastIndex = 0;
	return GARANTIA_SERVICO_RE.test(cleaned);
}

export function isGatedCityPath(itemPath: string): boolean {
	return gatedKeys.has(normalizePathKey(itemPath));
}

/**
 * Critérios do gate (sempre calcula). Use para auditoria de paths
 * ainda não listados em `gated`.
 */
export function evaluateCityQualityCriteria(
	itemPath: string,
	html = '',
): Omit<CityQualityGateResult, 'gated' | 'noindex'> {
	const pathKey = normalizePathKey(itemPath);
	const plain = stripHtml(html);
	const words = countWords(plain);
	const hasBairroReal = hasRealBairro(plain, pathKey);
	const hasPrazoReal = hasRealPrazo(plain);
	const hasEspecieRegional = hasRegionalSpecies(plain, pathKey);
	const passes =
		words >= MIN_UNIQUE_WORDS && hasBairroReal && hasPrazoReal && hasEspecieRegional;

	return {
		passes,
		words,
		hasBairroReal,
		hasPrazoReal,
		hasEspecieRegional,
	};
}

/**
 * Gate de qualidade para praças com parágrafo-template.
 * Só libera indexação com conteúdo único ≥300 palavras + bairros reais
 * (lista da praça, ≠ topônimo da URL, sem “saúde”) + garantia numérica
 * de serviço + espécie regional.
 */
export function evaluateCityQualityGate(itemPath: string, html = ''): CityQualityGateResult {
	const pathKey = normalizePathKey(itemPath);
	const gated = gatedKeys.has(pathKey);
	const criteria = evaluateCityQualityCriteria(itemPath, html);

	if (!gated) {
		return {
			gated: false,
			passes: true,
			noindex: false,
			words: criteria.words,
			hasBairroReal: criteria.hasBairroReal,
			hasPrazoReal: criteria.hasPrazoReal,
			hasEspecieRegional: criteria.hasEspecieRegional,
		};
	}

	return {
		gated: true,
		passes: criteria.passes,
		noindex: !criteria.passes,
		words: criteria.words,
		hasBairroReal: criteria.hasBairroReal,
		hasPrazoReal: criteria.hasPrazoReal,
		hasEspecieRegional: criteria.hasEspecieRegional,
	};
}

export function shouldNoindexCityQualityGate(itemPath: string, html = ''): boolean {
	return evaluateCityQualityGate(itemPath, html).noindex;
}

/** Paths do gate que ainda falham (sitemap). Atualize `noindex` após conteúdo único. */
export function getCityQualityGateNoindexPaths(): string[] {
	return (cityQualityGate.noindex ?? []).map((p) => normalizePathKey(p));
}
