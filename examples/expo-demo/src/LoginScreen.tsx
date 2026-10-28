import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput } from 'react-native';
import { login, type Session } from './session';

// The Android emulator reaches the host machine through 10.0.2.2.
const DEFAULT_SERVER = Platform.OS === 'android' ? 'http://10.0.2.2:8055' : 'http://localhost:8055';

export function LoginScreen({ onLogin }: { onLogin: (session: Session) => void }) {
	const [server, setServer] = useState(DEFAULT_SERVER);
	const [email, setEmail] = useState('');
	const [password, setPassword] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function submit() {
		setBusy(true);
		setError(null);
		try {
			onLogin(await login(server.trim(), email.trim(), password));
		} catch (e) {
			setError(e instanceof Error && e.message ? e.message : 'Sign-in failed');
		} finally {
			setBusy(false);
		}
	}

	return (
		<KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
			<Text style={styles.title}>dirlocal demo</Text>
			<TextInput testID="server" style={styles.input} value={server} onChangeText={setServer} autoCapitalize="none" autoCorrect={false} placeholder="Directus URL" />
			<TextInput testID="email" style={styles.input} value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" placeholder="Email" />
			<TextInput
				testID="password"
				style={styles.input}
				value={password}
				onChangeText={setPassword}
				secureTextEntry
				keyboardType="ascii-capable"
				placeholder="Password"
				returnKeyType="go"
				onSubmitEditing={submit}
			/>
			{error && <Text style={styles.error}>{error}</Text>}
			<Pressable testID="sign-in" style={styles.button} onPress={submit} disabled={busy}>
				{busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Sign in</Text>}
			</Pressable>
		</KeyboardAvoidingView>
	);
}

const styles = StyleSheet.create({
	container: { flex: 1, justifyContent: 'center', padding: 24, gap: 12 },
	title: { fontSize: 28, fontWeight: '700', marginBottom: 12 },
	input: { borderWidth: 1, borderColor: '#d0d0d8', borderRadius: 8, padding: 12, fontSize: 16 },
	error: { color: '#c62828' },
	button: { backgroundColor: '#6644ff', borderRadius: 8, padding: 14, alignItems: 'center' },
	buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
