import { OfflineProvider } from '@dirlocal/expo';
import NetInfo from '@react-native-community/netinfo';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { LoginScreen } from './src/LoginScreen';
import { NewTaskScreen } from './src/NewTaskScreen';
import { restoreSession, type Session } from './src/session';
import { TasksScreen } from './src/TasksScreen';

export default function App() {
	// undefined = still reading the stored session.
	const [session, setSession] = useState<Session | null | undefined>(undefined);
	const [creating, setCreating] = useState(false);
	// "Work offline" in the demo: the engine is told it is offline, as NetInfo would on a lost connection.
	const [workOffline, setWorkOffline] = useState(false);

	useEffect(() => {
		void restoreSession().then(setSession);
	}, []);

	useEffect(() => {
		if (!session) return;
		void session.offline.start();
		return () => session.offline.stop();
	}, [session]);

	useEffect(() => {
		if (!session) return;
		return NetInfo.addEventListener((state) =>
			session.offline.setOnline(!workOffline && state.isConnected !== false && state.isInternetReachable !== false),
		);
	}, [session, workOffline]);

	return (
		<SafeAreaProvider>
			<SafeAreaView style={{ flex: 1 }}>
				<StatusBar style="auto" />
				{session === null && <LoginScreen onLogin={setSession} />}
				{session && (
					<OfflineProvider offline={session.offline}>
						{creating ? (
							<NewTaskScreen files={session.files} onDone={() => setCreating(false)} />
						) : (
							<TasksScreen
								files={session.files}
								workOffline={workOffline}
								onToggleOffline={() => setWorkOffline((value) => !value)}
								onNew={() => setCreating(true)}
								onLogout={async () => {
									await session.logout();
									setWorkOffline(false);
									setSession(null);
								}}
							/>
						)}
					</OfflineProvider>
				)}
			</SafeAreaView>
		</SafeAreaProvider>
	);
}
