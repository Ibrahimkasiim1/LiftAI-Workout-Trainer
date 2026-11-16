import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import React from 'react';
import {
  Linking,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { getThemeColors } from '../constants/theme';
import { useTheme } from '../context/ThemeContext';
import { STORE_URL } from '../utils/forceUpdate';

export default function ForceUpdateScreen() {
  const { isDark } = useTheme();
  const colors = getThemeColors(isDark);
  const version = Constants.expoConfig?.version ?? '';

  const openStore = () => {
    Linking.openURL(STORE_URL).catch(() => {});
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.inner}>
        <View style={[styles.iconWrap, { backgroundColor: colors.primary + '22' }]}>
          <Ionicons name="arrow-up-circle-outline" size={56} color={colors.primary} />
        </View>

        <Text style={[styles.title, { color: colors.text }]}>Update required</Text>

        <Text style={[styles.body, { color: colors.textSecondary }]}>
          A new version of LiftAI is available with important improvements. Please
          update to continue using the app.
        </Text>

        {version ? (
          <Text style={[styles.versionNote, { color: colors.textMuted }]}>
            Your version: {version}
          </Text>
        ) : null}

        <TouchableOpacity
          style={[styles.btn, { backgroundColor: colors.primary }]}
          onPress={openStore}
          activeOpacity={0.85}
        >
          <Text style={styles.btnText}>
            Update on the {Platform.OS === 'ios' ? 'App Store' : 'Play Store'}
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  inner: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 16,
  },
  iconWrap: {
    width: 100,
    height: 100,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    textAlign: 'center',
  },
  body: {
    fontSize: 16,
    lineHeight: 24,
    textAlign: 'center',
  },
  versionNote: {
    fontSize: 13,
    textAlign: 'center',
  },
  btn: {
    marginTop: 8,
    width: '100%',
    paddingVertical: 16,
    borderRadius: 16,
    alignItems: 'center',
  },
  btnText: {
    color: '#FFF',
    fontSize: 17,
    fontWeight: '700',
  },
});
