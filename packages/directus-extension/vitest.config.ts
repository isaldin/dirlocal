import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['tests/**/*.test.ts'],
		// One Directus instance and one journal: a permissions marker from one file would 410 the others' cursors.
		fileParallelism: false,
		testTimeout: 30_000,
	},
});
