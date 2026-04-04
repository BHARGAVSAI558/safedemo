import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  TouchableWithoutFeedback,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { auth } from '../services/api';

const BRAND = '#1A56DB';

export default function OnboardingScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [devToast, setDevToast] = useState(null);

  const handleSendOtp = async () => {
    Keyboard.dismiss();
    const cleaned = phone.replace(/\D/g, '');
    if (cleaned.length !== 10) {
      Alert.alert('Error', 'Enter a valid 10-digit phone number');
      return;
    }

    setLoading(true);
    setDevToast(null);
    try {
      const res = await auth.sendOTP(cleaned);
      if (__DEV__ && res?.demo_otp != null) {
        setDevToast(`Demo mode: your OTP is ${res.demo_otp}`);
        setTimeout(() => setDevToast(null), 8000);
      }
      navigation.navigate('OTPVerify', {
        phone: cleaned,
        demoOtp: __DEV__ ? res?.demo_otp : undefined,
      });
    } catch (e) {
      Alert.alert('Error', e?.message || e?.response?.data?.detail || 'Failed to send OTP');
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top : 0}
    >
      <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
        <View style={styles.root}>
          <View style={[styles.top, { paddingTop: insets.top + 24 }]}>
            <Text style={styles.logo}>🛡️</Text>
            <Text style={styles.title}>SafeNet</Text>
            <Text style={styles.tagline}>Income protection for Zomato & Swiggy partners</Text>
          </View>

          <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 20) }]}>
            <Text style={styles.sheetTitle}>Enter your mobile number</Text>
            <Text style={styles.sheetSub}>We will send a verification code. No spam, ever.</Text>

            <View style={styles.phoneRow}>
              <View style={styles.ccPill}>
                <Text style={styles.flag}>🇮🇳</Text>
                <Text style={styles.ccText}>+91</Text>
              </View>
              <TextInput
                style={styles.phoneInput}
                placeholder="9876543210"
                placeholderTextColor="#9ca3af"
                keyboardType="phone-pad"
                maxLength={10}
                value={phone}
                onChangeText={(t) => setPhone(t.replace(/\D/g, ''))}
                returnKeyType="done"
                blurOnSubmit
                onSubmitEditing={handleSendOtp}
              />
            </View>

            <TouchableOpacity style={styles.cta} onPress={handleSendOtp} disabled={loading} activeOpacity={0.85}>
              {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.ctaText}>Get OTP</Text>}
            </TouchableOpacity>

            <Text style={styles.terms}>By continuing, you agree to our Terms of Service</Text>

            <View style={styles.trustRow}>
              <Text style={styles.trustItem}>🔒 Secure</Text>
              <Text style={styles.trustItem}>⚡ Instant payouts</Text>
              <Text style={styles.trustItem}>🛡️ RBI compliant model</Text>
            </View>
          </View>

          {__DEV__ && devToast ? (
            <View style={[styles.toast, { bottom: insets.bottom + 12 }]}>
              <Text style={styles.toastText}>{devToast}</Text>
            </View>
          ) : null}
        </View>
      </TouchableWithoutFeedback>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BRAND },
  top: {
    flex: 1,
    backgroundColor: BRAND,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  logo: { fontSize: 72, marginBottom: 8 },
  title: { fontSize: 34, fontWeight: '800', color: '#fff', letterSpacing: -0.5 },
  tagline: { fontSize: 16, color: 'rgba(255,255,255,0.92)', textAlign: 'center', marginTop: 10, lineHeight: 22 },
  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 22,
    paddingTop: 28,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: -4 },
    elevation: 8,
  },
  sheetTitle: { fontSize: 20, fontWeight: '800', color: '#111827' },
  sheetSub: { fontSize: 14, color: '#6b7280', marginTop: 6, marginBottom: 20 },
  phoneRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  ccPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f3f4f6',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 14,
    gap: 6,
  },
  flag: { fontSize: 18 },
  ccText: { fontSize: 16, fontWeight: '700', color: '#111827' },
  phoneInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
    fontSize: 18,
    fontWeight: '600',
    color: '#111827',
    backgroundColor: '#fafafa',
  },
  cta: {
    backgroundColor: BRAND,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 18,
  },
  ctaText: { color: '#fff', fontSize: 17, fontWeight: '800' },
  terms: { fontSize: 12, color: '#9ca3af', textAlign: 'center', marginTop: 14 },
  trustRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginTop: 22, gap: 8 },
  trustItem: { fontSize: 12, color: '#4b5563', fontWeight: '600' },
  toast: {
    position: 'absolute',
    left: 16,
    right: 16,
    backgroundColor: 'rgba(17,24,39,0.92)',
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
  },
  toastText: { color: '#fff', fontSize: 13, textAlign: 'center' },
});
