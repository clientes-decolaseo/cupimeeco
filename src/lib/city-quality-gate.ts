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

/** Atendimento 24h / “em 24 horas” não conta como prazo de garantia do serviço. */
const ATENDIMENTO_24H_RE = /\b(?:atendimento|plant[aã]o|emerg[eê]ncia|central)\b.{0,24}\b24\s*h(?:oras?)?\b|\b24\s*h(?:oras?)?\b.{0,24}\b(?:atendimento|plant[aã]o|emerg[eê]ncia|central)\b/i;

/** Prazo numérico explícito (dias/meses/anos). Exige dado real — [CONFIRMAR] falha. */
const PRAZO_REAL_RE =
	/\b(?:garantia|prazo|validade|vig[eê]ncia)\b[\s\S]{0,48}?\b(\d{1,2})\s*(dias?|meses?|anos?)\b|\b(\d{1,2})\s*(dias?|meses?|anos?)\b[\s\S]{0,24}?\b(?:garantia|prazo|validade)\b/i;

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

function hasRealBairro(plain: string, pathKey: string): boolean {
	const names = bairrosPorPraca.get(pathKey) ?? [];
	const lower = plain.toLowerCase();
	return names.some((name) => name && lower.includes(name.toLowerCase()));
}

function hasRegionalSpecies(plain: string, pathKey: string): boolean {
	const names = especiesPorPraca.get(pathKey) ?? [];
	const lower = plain.toLowerCase();
	return names.some((name) => name && lower.includes(name.toLowerCase()));
}

function hasRealPrazo(plain: string): boolean {
	if (!plain || /\[confirmar\]/i.test(plain)) return false;

	const withoutAtendimento = plain.replace(ATENDIMENTO_24H_RE, ' ');
	return PRAZO_REAL_RE.test(withoutAtendimento);
}

export function isGatedCityPath(itemPath: string): boolean {
	return gatedKeys.has(normalizePathKey(itemPath));
}

/**
 * Gate de qualidade para praças com parágrafo-template.
 * Só libera indexação com conteúdo único ≥300 palavras + bairros reais +
 * prazo real (sem [CONFIRMAR]) + espécie regional.
 */
export function evaluateCityQualityGate(itemPath: string, html = ''): CityQualityGateResult {
	const pathKey = normalizePathKey(itemPath);
	const gated = gatedKeys.has(pathKey);

	if (!gated) {
		return {
			gated: false,
			passes: true,
			noindex: false,
			words: 0,
			hasBairroReal: false,
			hasPrazoReal: false,
			hasEspecieRegional: false,
		};
	}

	const plain = stripHtml(html);
	const words = countWords(plain);
	const hasBairroReal = hasRealBairro(plain, pathKey);
	const hasPrazoReal = hasRealPrazo(plain);
	const hasEspecieRegional = hasRegionalSpecies(plain, pathKey);
	const passes =
		words >= MIN_UNIQUE_WORDS && hasBairroReal && hasPrazoReal && hasEspecieRegional;

	return {
		gated: true,
		passes,
		noindex: !passes,
		words,
		hasBairroReal,
		hasPrazoReal,
		hasEspecieRegional,
	};
}

export function shouldNoindexCityQualityGate(itemPath: string, html = ''): boolean {
	return evaluateCityQualityGate(itemPath, html).noindex;
}

/** Paths do gate que ainda falham (sitemap). Atualize `noindex` após conteúdo único. */
export function getCityQualityGateNoindexPaths(): string[] {
	return (cityQualityGate.noindex ?? []).map((p) => normalizePathKey(p));
}
