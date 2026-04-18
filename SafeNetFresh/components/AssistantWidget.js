import React from 'react';
import { TouchableOpacity, Text, StyleSheet, Platform } from 'react-native';

export default function AssistantWidget({ onPress }) {
  return (
    <TouchableOpacity style={styles.fab} onPress={onPress} activeOpacity={0.9}>
      <Text style={styles.icon}>💬</Text>
      <Text style={styles.label}>Assistant</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  fab: {
    position: 'absolute',
    right: 16,
    bottom: 18,
    backgroundColor: '#1a73e8',
    borderRadius: 999,
    paddingVertical: 10,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 3px 10px rgba(0,0,0,0.20)' }
      : {
          shadowColor: '#000',
          shadowOpacity: 0.2,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 3 },
        }),
    elevation: 6,
    zIndex: 100,
  },
  icon: { color: '#fff', fontSize: 16 },
  label: { color: '#fff', fontSize: 13, fontWeight: '800' },
});

