export interface WpSeo {
	title: string;
	description: string;
	canonical: string;
	ogImage: string;
	robots: boolean;
}

export interface WpContent {
	id: number;
	type: 'page' | 'post';
	slug: string;
	path: string;
	title: string;
	excerpt: string;
	content: string;
	date: string;
	modified: string;
	link: string;
	parent: number;
	featuredMedia: number;
	categories: number[];
	tags: number[];
	seo: WpSeo;
}

export interface WpManifestEntry {
	id: number;
	slug: string;
	path: string;
	title: string;
	modified: string;
	link: string;
	seoTitle: string;
}

export interface BlogPostSummary {
	id: number;
	path: string;
	title: string;
	modified: string;
	excerpt: string;
	image: string;
	imageAlt: string;
}

export interface WpManifest {
	importedAt: string;
	source: string;
	totals: {
		pages: number;
		posts: number;
	};
	pages: WpManifestEntry[];
	posts: WpManifestEntry[];
}
