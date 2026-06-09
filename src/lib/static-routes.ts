/** Paths servidos por páginas Astro — não gerar via catch-all do WordPress */
export const ASTRO_STATIC_PATHS = new Set([
	'blog',
	'busca',
	'servico',
	'contato',
	'privacidade',
	'termos',
	'deratizacao',
	'sanitizacao',
	'controle-de-mosquitos',
	'contratos-empresariais',
	'dedetizacao',
	'descupinizacao',
]);

/** Hubs de cluster (rotas Astro aninhadas) */
export const ASTRO_STATIC_PREFIXES = [
	'descupinizacao/regioes',
	'dedetizacao/regioes',
	'deratizacao/regioes',
	'sanitizacao/regioes',
	'controle-de-mosquitos/regioes',
];

/** Tópicos editoriais em /blog/{topico}/ */
export const ASTRO_BLOG_TOPICS = new Set(['cupins', 'dedetizacao', 'deratizacao']);

/** URLs antigas do WordPress — redirecionadas em astro.config.mjs */
export const REDIRECTED_WP_PATHS = new Set([
	'fotos',
	'biblioteca-da-universo',
	'glossario-tudo-sobre-descupinizacao',
	'dedetizacao-de-cupins',
	'dedetizadora-de-cupim',
]);

export function isExcludedFromWpCatchAll(itemPath: string): boolean {
	if (ASTRO_STATIC_PATHS.has(itemPath) || REDIRECTED_WP_PATHS.has(itemPath)) {
		return true;
	}

	if (ASTRO_STATIC_PREFIXES.includes(itemPath)) {
		return true;
	}

	const segments = itemPath.split('/');

	if (segments[0] === 'blog' && segments[1] && ASTRO_BLOG_TOPICS.has(segments[1]) && segments.length === 2) {
		return true;
	}

	if (segments[0] === 'blog' && segments[1] === 'page' && segments[2] && /^\d+$/.test(segments[2])) {
		return true;
	}

	return false;
}
