import type { ClusterManifestEntry } from '../types/cluster';
import {
	compareCityOrder,
	getRegiaoIntro,
	getRegiaoLabel,
	getRegiaoOrdem,
	isPageInServiceArea,
	resolveCityFromPage,
} from './area-atendida';

export interface CityGroup {
	id: string;
	nome: string;
	regiaoId: string;
	regiaoLabel: string;
	regiaoOrdem: number;
	pages: ClusterManifestEntry[];
}

export interface RegionSection {
	regiaoId: string;
	regiaoLabel: string;
	regiaoOrdem: number;
	regiaoIntro: string;
	cities: CityGroup[];
}

export function filterPagesInServiceArea(
	pages: ClusterManifestEntry[],
): ClusterManifestEntry[] {
	return pages.filter((page) => isPageInServiceArea(page));
}

export function groupPagesByCity(pages: ClusterManifestEntry[]): CityGroup[] {
	const servedPages = filterPagesInServiceArea(pages);
	const groups = new Map<string, CityGroup>();

	for (const page of servedPages) {
		const city = resolveCityFromPage(page);

		if (!groups.has(city.id)) {
			groups.set(city.id, {
				id: city.id,
				nome: city.nome,
				regiaoId: city.regiaoId,
				regiaoLabel: getRegiaoLabel(city.regiaoId),
				regiaoOrdem: getRegiaoOrdem(city.regiaoId),
				pages: [],
			});
		}

		groups.get(city.id)!.pages.push(page);
	}

	for (const group of groups.values()) {
		group.pages.sort((a, b) => a.title.localeCompare(b.title, 'pt-BR'));
	}

	return [...groups.values()].sort((a, b) => {
		if (a.regiaoOrdem !== b.regiaoOrdem) return a.regiaoOrdem - b.regiaoOrdem;
		return compareCityOrder(a.id, b.id);
	});
}

export function groupCitiesByRegion(cities: CityGroup[]): RegionSection[] {
	const sections = new Map<string, RegionSection>();

	for (const city of cities) {
		if (!sections.has(city.regiaoId)) {
			sections.set(city.regiaoId, {
				regiaoId: city.regiaoId,
				regiaoLabel: city.regiaoLabel,
				regiaoOrdem: city.regiaoOrdem,
				regiaoIntro: getRegiaoIntro(city.regiaoId),
				cities: [],
			});
		}

		sections.get(city.regiaoId)!.cities.push(city);
	}

	for (const section of sections.values()) {
		section.cities.sort((a, b) => compareCityOrder(a.id, b.id));
	}

	return [...sections.values()].sort((a, b) => a.regiaoOrdem - b.regiaoOrdem);
}
