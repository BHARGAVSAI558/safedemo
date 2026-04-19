import React, { useEffect, useRef } from 'react';
import { View, Text, ActivityIndicator, Animated, Easing, StyleSheet } from 'react-native';

import { workers } from '../services/api';
import { useAuth } from '../contexts/AuthContext';

const BRAND = '#1a73e8';
const MIN_SPLASH_MS = 4000;
const MAX_SPLASH_MS = 4500;
const PROFILE_FETCH_TIMEOUT_MS = 3200;

export default function SplashScreen({ navigation }) {
  const { token, profileReady, dispatch, signOut } = useAuth();
  const scale = useRef(new Animated.Value(0.72)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const ring = useRef(new Animated.Value(0)).current;
  const splashStart = useRef(Date.now());

  useEffect(() => {
    Animated.parallel([
      Animated.spring(scale, {
        toValue: 1,
        friction: 7,
        tension: 80,
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 1,
        duration: 420,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(ring, { toValue: 1, duration: 1200, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(ring, { toValue: 0, duration: 1200, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [opacity, ring, scale]);

  useEffect(() => {
    let cancelled = false;
    const hardDeadline = Date.now() + MAX_SPLASH_MS;

    const waitMinSplash = async () => {
      const elapsed = Date.now() - splashStart.current;
      const rest = Math.max(0, MIN_SPLASH_MS - elapsed);
      if (rest) await new Promise((r) => setTimeout(r, rest));
    };
    const withTimeout = async (promise, ms) =>
      Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('profile_fetch_timeout')), ms)),
      ]);
    const hitFallbackDeadline = async () => {
      const left = hardDeadline - Date.now();
      if (left > 0) await new Promise((r) => setTimeout(r, left));
    };

    (async () => {
      try {
        if (!token) {
          await waitMinSplash();
          if (!cancelled) navigation.replace('Onboarding');
          return;
        }

        if (profileReady === true) {
          await waitMinSplash();
          return;
        }
        if (profileReady === false) {
          await waitMinSplash();
          if (!cancelled) navigation.replace('ProfileSetup');
          return;
        }

        const profile = await withTimeout(workers.getProfile(), PROFILE_FETCH_TIMEOUT_MS);
        if (cancelled) return;
        dispatch({ type: 'SET_PROFILE', profile });
        await waitMinSplash();
        if (cancelled) return;
        if (profile?.is_profile_complete === false) {
          navigation.replace('ProfileSetup');
          return;
        }
      } catch (e) {
        if (cancelled) return;
        const status = e?.response?.status;
        if (status === 401) {
          await signOut();
          navigation.replace('Onboarding');
          return;
        }
        if (status === 404) {
          dispatch({ type: 'SET_PROFILE_READY', ready: false });
          navigation.replace('ProfileSetup');
          return;
        }
        await hitFallbackDeadline();
        if (cancelled) return;
        // Backend slow/offline should never freeze at splash.
        // Let user enter app; data cards handle network errors gracefully.
        dispatch({ type: 'SET_PROFILE_READY', ready: true });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token, profileReady, dispatch, navigation, signOut]);

  const ringScale = ring.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] });
  const ringOpacity = ring.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0.08] });

  return (
    <View style={styles.root}>
      <Animated.View style={[styles.ring, { opacity: ringOpacity, transform: [{ scale: ringScale }] }]} />
      <Animated.View style={[styles.mark, { opacity, transform: [{ scale }] }]}>
        <Text style={styles.markLetter}>S</Text>
      </Animated.View>
      <Text style={styles.wordmark}>SafeNet</Text>
      <Text style={styles.tagline}>Income protection for riders</Text>
      <ActivityIndicator style={styles.spinner} size="small" color={BRAND} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f0f4ff',
    paddingHorizontal: 24,
  },
  ring: {
    position: 'absolute',
    width: 160,
    height: 160,
    borderRadius: 80,
    borderWidth: 2,
    borderColor: BRAND,
  },
  mark: {
    width: 88,
    height: 88,
    borderRadius: 22,
    backgroundColor: BRAND,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: BRAND,
    shadowOpacity: 0.35,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  markLetter: {
    color: '#fff',
    fontSize: 44,
    fontWeight: '900',
    letterSpacing: -1,
  },
  wordmark: {
    marginTop: 20,
    fontSize: 26,
    fontWeight: '900',
    color: '#0f172a',
    letterSpacing: -0.5,
  },
  tagline: {
    marginTop: 6,
    fontSize: 14,
    fontWeight: '600',
    color: '#64748b',
  },
  spinner: { marginTop: 28 },
});
