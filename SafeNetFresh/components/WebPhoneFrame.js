import React from 'react';
import { Platform, View, StyleSheet, useWindowDimensions } from 'react-native';

/** ~large phone width; layout matches mobile app on desktop browsers. */
const DEVICE_MAX_W = 412;
const DEVICE_MAX_H = 896;
/** Viewports narrower than this use full width (real phones / narrow windows). */
const FRAME_BREAKPOINT = 520;

export default function WebPhoneFrame({ children }) {
  const { width: winW, height: winH } = useWindowDimensions();

  if (Platform.OS !== 'web') {
    return children;
  }

  const useFrame = winW >= FRAME_BREAKPOINT;
  const shellH = Math.min(Math.max(winH - 40, 560), DEVICE_MAX_H);

  if (!useFrame) {
    return <View style={styles.fullBleed}>{children}</View>;
  }

  return (
    <View style={styles.chrome}>
      <View style={[styles.device, { height: shellH, maxHeight: shellH }]}>
        <View style={styles.deviceClip}>{children}</View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  chrome: {
    flex: 1,
    width: '100%',
    backgroundColor: '#334155',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 20,
    paddingHorizontal: 16,
    minHeight: '100vh',
  },
  device: {
    width: '100%',
    maxWidth: DEVICE_MAX_W,
    borderRadius: 36,
    backgroundColor: '#0f172a',
    overflow: 'hidden',
    boxShadow: '0 24px 80px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.06)',
  },
  deviceClip: {
    flex: 1,
    width: '100%',
    overflow: 'hidden',
    borderRadius: 32,
    margin: 5,
    backgroundColor: '#f0f4ff',
  },
  fullBleed: {
    flex: 1,
    width: '100%',
    minHeight: '100vh',
    backgroundColor: '#f0f4ff',
  },
});
