import { OfflineProvider } from '@dirlocal/expo';
import NetInfo from '@react-native-community/netinfo';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { LoginScreen } from './src/LoginScreen';
import { restoreSession, type Session } from './src/session';
import { TasksScreen } from './src/TasksScreen';

export default function App() {
	// undefined = still reading the stored session.
	const [session, setSession] = useState<Session | null | undefined>(undefined);

	useEffect(() => {
		void restoreSession().then(setSession);
	}, []);

	useEffect(() => {
		if (!session) return;
		void session.offline.start();
		const unsubscribe = NetInfo.addEventListener((state) =>
			session.offline.setOnline(state.isConnected !== false && state.isInternetReachable !== false),
		);
		return () => {
			unsubscribe();
			session.offline.stop();
		};
	}, [session]);

	return (
		<SafeAreaProvider>
			<SafeAreaView style={{ flex: 1 }}>
				<StatusBar style="auto" />
				{session === null && <LoginScreen onLogin={setSession} />}
				{session && (
					<OfflineProvider offline={session.offline}>
						<TasksScreen
							onLogout={async () => {
								await session.logout();
								setSession(null);
							}}
						/>
					</OfflineProvider>
				)}
			</SafeAreaView>
		</SafeAreaProvider>
	);
}
