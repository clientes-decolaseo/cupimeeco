/** Scores de canonical — menor = preferido. Alinhado com scripts/lib/cluster-prefer-path.mjs */
export function getClusterPreferPathScore(clusterId: string, path: string): number {
	switch (clusterId) {
		case 'descupinizacao':
			if (path.startsWith('descupinizacao')) return 0;
			if (path.startsWith('descupinizadora')) return 1;
			if (path.startsWith('dedetizacao-de-cupim') || path.startsWith('dedetizacao-cupim')) return 2;
			return 3;
		case 'dedetizacao':
			if (path.startsWith('dedetizadora-em')) return 0;
			if (path.startsWith('empresa-de-dedetizacao')) return 1;
			return 2;
		case 'deratizacao':
			if (path.startsWith('desratizacao')) return 0;
			if (path.startsWith('desratizadora')) return 1;
			return 2;
		case 'sanitizacao':
			return path.startsWith('sanitizacao-em') ? 0 : 1;
		case 'mosquitos':
			if (path.startsWith('controle-de-mosquito')) return 0;
			if (path.startsWith('dedetizadora-de-mosquito')) return 1;
			return 2;
		default:
			return 9;
	}
}
