import { type AuthenticationData, authentication, createDirectus, realtime, rest } from '@directus/sdk';
import { createFileCache, createOffline, directusRealtime, expoSqlite, type FileCache, type Offline } from '@dirlocal/expo';
import * as SecureStore from 'expo-secure-store';

const AUTH_KEY = 'dirlocal-demo.auth';
const SERVER_KEY = 'dirlocal-demo.server';
const COLLECTIONS = ['projects', 'tasks', 'notes'];

export interface Session {
	offline: Offline;
	files: FileCache;
	logout(): Promise<void>;
}

function connect(server: string) {
	// Tokens live in SecureStore so the app reopens signed in — and with its local data — without a network.
	const directus = createDirectus(server)
		.with(
			authentication('json', {
				autoRefresh: true,
				storage: {
					get: async () => {
						const value = await SecureStore.getItemAsync(AUTH_KEY);
						return value ? (JSON.parse(value) as AuthenticationData) : null;
					},
					set: (value) => (value ? SecureStore.setItemAsync(AUTH_KEY, JSON.stringify(value)) : SecureStore.deleteItemAsync(AUTH_KEY)),
				},
			}),
		)
		.with(rest())
		// Needs WEBSOCKETS_ENABLED=true on the server; without it the app falls back to polling.
		.with(realtime({ authMode: 'handshake' }));

	const offline = createOffline({
		directus,
		storage: expoSqlite(),
		collections: COLLECTIONS,
		pollInterval: 15_000,
		realtime: directusRealtime(directus),
	});
	offline.on('error', ({ error }) => console.log('[dirlocal] sync failed:', error));
	const files = createFileCache({ offline, url: server, getToken: () => directus.getToken() });

	const session: Session = {
		offline,
		files,
		async logout() {
			// The next user must not see this user's rows, photos or unsent changes.
			await offline.clear();
			files.clear();
			files.dispose();
			await SecureStore.deleteItemAsync(AUTH_KEY);
			await SecureStore.deleteItemAsync(SERVER_KEY);
		},
	};
	return { directus, session };
}

export async function restoreSession(): Promise<Session | null> {
	const server = await SecureStore.getItemAsync(SERVER_KEY);
	if (!server || !(await SecureStore.getItemAsync(AUTH_KEY))) return null;
	return connect(server).session;
}

export async function login(server: string, email: string, password: string): Promise<Session> {
	const { directus, session } = connect(server);
	await directus.login({ email, password });
	await SecureStore.setItemAsync(SERVER_KEY, server);
	return session;
}
