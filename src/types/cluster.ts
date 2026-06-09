export interface ClusterPageMatch {
	prefixes?: string[];
	anyPrefix?: string;
	excludePrefixes?: string[];
}

export interface ClusterConfig {
	id: string;
	nome: string;
	pilar: string;
	hubRegioes: string;
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
