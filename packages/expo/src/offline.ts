import { createOffline as createCoreOffline, directusTransport, type Offline, type OfflineOptions } from '@dirlocal/core';
import { randomUUID } from 'expo-crypto';
import { File } from 'expo-file-system';

/**
 * core's createOffline with Expo defaults:
 * - native UUIDs (Hermes has no crypto.randomUUID; core's fallback uses Math.random);
 * - uploads as expo-file-system Files: Expo's fetch accepts Blob-like parts only, not React Native's `{ uri, name, type }`.
 */
export function createOffline(options: OfflineOptions): Offline {
	const transport =
		options.transport ?? (options.directus ? directusTransport(options.directus, { filePart: (file) => new File(file.uri) }) : undefined);
	return createCoreOffline({ uuid: randomUUID, ...options, ...(transport && { transport }) });
}
