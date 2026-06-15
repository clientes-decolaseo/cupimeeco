export interface ClusterPageMatch {
	prefixes?: string[];
	anyPrefix?: string;
	excludePrefixes?: string[];
	/** Fragmentos no path (ex.: /descupiniz) */
	pathIncludes?: string[];
	/** Padrões regex testados no path inteiro */
	slugPatterns?: string[];
	/** Substrings que invalidam o match (ex.: rato, mosquito) */
	excludeSlugPatterns?: string[];
}

export interface ClusterConfig {
	id: string;
	nome: string;
	pilar: string;
	hubRegioes: string;
	/** Hub regional promovido na navegação (false = pilar + blog apenas) */
	hubRegioesAtivo?: boolean;
	blogHub: string;
	blogHubTitulo: string;
	blogHubDescricao: string;
	blogSlugIncludes: string[];
	matchPage: ClusterPageMatch;
}

export interface ClusterManifestEntry {
	id: number;
	path: string;
	title: string;
	modified: string;
}

export interface BreadcrumbItem {
	label: string;
	href?: string;
}
