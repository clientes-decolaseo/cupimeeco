import hubThinPolicy from '../data/seo/hub-thin-policy.json';

/** Mínimo de spokes vivos para um hub permanecer indexável. */
export const MIN_LIVE_SPOKES = hubThinPolicy.minLiveSpokes ?? 3;

function normalizePathKey(itemPath: string): string {
	return itemPath.replace(/^\/+|\/+$/g, '').toLowerCase();
}

const thinHubKeys = new Set(
	(hubThinPolicy.noindex ?? []).map((p) => normalizePathKey(String(p))),
);

/**
 * True se o hub está na policy de hubs finos (gerada por `check-hubs --enforce`).
 * Use em páginas Astro de hub (blog topic / regioes) via prop `noindex` do BioLayout.
 */
export function isThinHubNoindex(hubPath: string): boolean {
	return thinHubKeys.has(normalizePathKey(hubPath));
}

/** Paths normalizados (sem barras) marcados noindex pela checagem de hubs. */
export function getThinHubNoindexPaths(): string[] {
	return [...thinHubKeys];
}
