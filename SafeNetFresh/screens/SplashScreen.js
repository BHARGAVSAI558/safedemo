import React, { useEffect, useState } from 'react';
import { View, Text, ActivityIndicator } from 'react-native';

import { workers } from '../services/api';
import { useAuth } from '../contexts/AuthContext';

export default function SplashScreen({ navigation }) {
  const { token, profileReady, dispatch, signOut } = useAuth();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        if (!token) {
          navigation.replace('Onboarding');
          return;
        }

        if (profileReady === true) return;
        if (profileReady === false) return;

        const profile = await workers.getProfile();
        if (cancelled) return;
        dispatch({ type: 'SET_PROFILE', profile });
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
        dispatch({ type: 'SET_PROFILE_READY', ready: false });
        navigation.replace('ProfileSetup');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [token, profileReady, dispatch, navigation, signOut]);

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f0f4ff' }}>
        <ActivityIndicator size="large" color="#1a73e8" />
        <Text style={{ marginTop: 10, color: '#555' }}>Checking your session…</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f0f4ff' }}>
      <ActivityIndicator size="large" color="#1a73e8" />
    </View>
  );
}

