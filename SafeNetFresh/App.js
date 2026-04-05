import React, { useEffect, useMemo } from 'react';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { View, ActivityIndicator, Text, Platform } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AuthProvider, useAuth } from './contexts/AuthContext';
import { WsConnectionProvider } from './contexts/WsConnectionContext';
import { ClaimProvider } from './contexts/ClaimContext';
import { PolicyProvider } from './contexts/PolicyContext';
import WebSocketBridge from './components/WebSocketBridge';
import DisruptionModal from './components/DisruptionModal';
import PremiumDueModal from './components/PremiumDueModal';
import LocationGate from './components/LocationGate';
import NotificationInitializer from './components/NotificationInitializer';
import PolicyBootstrap from './components/PolicyBootstrap';
import WebPhoneFrame from './components/WebPhoneFrame';

import SplashScreen from './screens/SplashScreen';
import OnboardingScreen from './screens/OnboardingScreen';
import OTPVerifyScreen from './screens/OTPVerifyScreen';
import ProfileSetupScreen from './screens/ProfileSetupScreen';

import DashboardScreen from './screens/DashboardScreen';
import PolicyScreen from './screens/PolicyScreen';
import ClaimsScreen from './screens/ClaimsScreen';
import ProfileScreen from './screens/ProfileScreen';
import { navigationRef } from './services/navigationService';

const Stack = createNativeStackNavigator();
const Tabs = createBottomTabNavigator();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 1000 * 30 },
  },
});

async function startScreenVisitSafe(name) {
  try {
    const svc = await import('./services/device_fingerprint.service');
    await svc.startScreenVisit?.(name);
  } catch (_) {}
}

async function endScreenVisitSafe(name) {
  try {
    const svc = await import('./services/device_fingerprint.service');
    await svc.endScreenVisit?.(name);
  } catch (_) {}
}

function tabIcon(emoji, focused) {
  return (
    <Text style={{ fontSize: 20, opacity: focused ? 1 : 0.45 }}>{emoji}</Text>
  );
}

function MainTabs() {
  return (
    <Tabs.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: '#1a73e8',
        tabBarInactiveTintColor: '#94a3b8',
        tabBarStyle: {
          borderTopColor: 'rgba(0,0,0,0.08)',
          paddingTop: 4,
          height: 58,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '700' },
      }}
    >
      <Tabs.Screen
        name="Home"
        component={DashboardScreen}
        options={{
          tabBarLabel: 'Home',
          tabBarIcon: ({ focused }) => tabIcon('🏠', focused),
        }}
      />
      <Tabs.Screen
        name="Claims"
        component={ClaimsScreen}
        options={{
          tabBarLabel: 'Claims',
          tabBarIcon: ({ focused }) => tabIcon('📋', focused),
        }}
      />
      <Tabs.Screen
        name="Coverage"
        component={PolicyScreen}
        options={{
          tabBarLabel: 'Coverage',
          tabBarIcon: ({ focused }) => tabIcon('🛡️', focused),
        }}
      />
      <Tabs.Screen
        name="Account"
        component={ProfileScreen}
        options={{
          tabBarLabel: 'Account',
          tabBarIcon: ({ focused }) => tabIcon('👤', focused),
        }}
      />
    </Tabs.Navigator>
  );
}

function ProtectedMainTabs() {
  const { token, profileReady } = useAuth();

  if (!token || profileReady !== true) return null;

  return (
    <>
      <MainTabs />
      <WebSocketBridge />
      <DisruptionModal />
      <PremiumDueModal />
      <LocationGate />
      <PolicyBootstrap />
    </>
  );
}

function RootNavigator() {
  const { token, isRestored, profileReady } = useAuth();
  const lastScreenRef = React.useRef(null);

  const getActiveRouteName = (state) => {
    try {
      let route = state?.routes?.[state.index] || null;
      while (route?.state && route?.state?.routes?.length) {
        const next = route.state.routes[route.state.index];
        route = next;
      }
      return route?.name || null;
    } catch (_) {
      return null;
    }
  };

  const theme = useMemo(
    () => ({
      ...DefaultTheme,
      colors: { ...DefaultTheme.colors, background: '#f0f4ff' },
    }),
    []
  );

  if (!isRestored) {
    const loading = (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f0f4ff' }}>
        <ActivityIndicator size="large" color="#1a73e8" />
      </View>
    );
    return Platform.OS === 'web' ? <WebPhoneFrame>{loading}</WebPhoneFrame> : loading;
  }

  const nav = (
    <NavigationContainer
      theme={theme}
      ref={navigationRef}
      onReady={() => {
        const name = getActiveRouteName(navigationRef.getRootState?.());
        lastScreenRef.current = name;
        if (name) void startScreenVisitSafe(name);
      }}
      onStateChange={() => {
        const state = navigationRef.getRootState?.();
        const name = getActiveRouteName(state);
        const prev = lastScreenRef.current;
        if (!name || name === prev) return;
        if (prev) void endScreenVisitSafe(prev);
        lastScreenRef.current = name;
        void startScreenVisitSafe(name);
      }}
    >
      <Stack.Navigator
        initialRouteName="Splash"
        screenOptions={{
          headerStyle: { backgroundColor: '#f0f4ff' },
          headerTintColor: '#1a73e8',
          headerTitleStyle: { fontWeight: 'bold' },
          headerShadowVisible: false,
        }}
      >
        {!token || profileReady !== true ? (
          <>
            <Stack.Screen name="Splash" component={SplashScreen} options={{ headerShown: false }} />
            <Stack.Screen name="Onboarding" component={OnboardingScreen} options={{ headerShown: false }} />
            <Stack.Screen name="OTPVerify" component={OTPVerifyScreen} options={{ headerShown: false }} />
            <Stack.Screen name="ProfileSetup" component={ProfileSetupScreen} options={{ headerShown: false }} />
          </>
        ) : (
          <Stack.Screen name="MainTabs" component={ProtectedMainTabs} options={{ headerShown: false }} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );

  return Platform.OS === 'web' ? <WebPhoneFrame>{nav}</WebPhoneFrame> : nav;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <WsConnectionProvider>
              <ClaimProvider>
                <PolicyProvider>
                  <NotificationInitializer />
                  <RootNavigator />
                </PolicyProvider>
              </ClaimProvider>
            </WsConnectionProvider>
          </AuthProvider>
        </QueryClientProvider>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
}

