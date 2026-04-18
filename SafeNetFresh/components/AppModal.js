import React from 'react';
import { Modal, View, StyleSheet, Platform } from 'react-native';

/**
 * react-native-web's Modal renders via a document-level portal (full browser width).
 * On web we render in-tree so overlays stay inside the phone frame (position: relative parents).
 */
export default function AppModal({
  visible,
  transparent = true,
  animationType = 'fade',
  onRequestClose,
  children,
}) {
  if (!visible) return null;

  if (Platform.OS !== 'web') {
    return (
      <Modal
        visible={visible}
        transparent={transparent}
        animationType={animationType}
        onRequestClose={onRequestClose}
      >
        {children}
      </Modal>
    );
  }

  return (
    <View
      style={[StyleSheet.absoluteFillObject, styles.webLayer, { pointerEvents: 'box-none' }]}
      accessibilityViewIsModal
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  webLayer: {
    zIndex: 200000,
    elevation: 200000,
  },
});
