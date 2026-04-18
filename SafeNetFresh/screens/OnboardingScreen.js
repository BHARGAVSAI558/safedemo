import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { auth, warmBackendOnce, formatApiError } from '../services/api';

const BRAND = '#1A56DB';

export default function OnboardingScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [sentNotice, setSentNotice] = useState('');

  React.useEffect(() => {
    // Pre-warm backend when onboarding opens to reduce first OTP send latency.
    void warmBackendOnce();
  }, []);

  const handleSendOtp = async () => {
    Keyboard.dismiss();
    const cleaned = phone.replace(/\D/g, '');
    if (cleaned.length !== 10) {
      Alert.alert(
        'Almost there',
        'Please enter your full 10-digit mobile number so we can send your code.'
      );
      return;
    }

    setLoading(true);
    setSentNotice('');
    try {
      await auth.sendOTP(cleaned);
      setSentNotice('Code sent — check your SMS');
      await new Promise((r) => setTimeout(r, 1000));
      navigation.navigate('OTPVerify', { phone: cleaned });
    } catch (e) {
      Alert.alert(
        'Could not send code',
        formatApiError(e)
      );
    } finally {
      setLoading(false);
      setSentNotice('');
    }
  };

  const inner = (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.scrollContent}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
      showsVerticalScrollIndicator={false}
    >
      <View style={[styles.top, { paddingTop: insets.top + 24 }]}>
        <Text style={styles.logo}>🛡️</Text>
        <Text style={styles.title}>SafeNet</Text>
        <Text style={styles.tagline}>Income protection when work stops</Text>
      </View>

      <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 20) }]}>
        <Text style={styles.sheetTitle}>Sign in or create account</Text>
        <Text style={styles.sheetSub}>We’ll text you a one-time code to continue.</Text>

        <Text style={styles.fieldLabel}>Enter phone number</Text>
        <View style={styles.phoneRow}>
          <View style={styles.ccPill}>
            <Text style={styles.flag}>🇮🇳</Text>
            <Text style={styles.ccText}>+91</Text>
          </View>
          <TextInput
            style={styles.phoneInput}
            placeholder="10-digit mobile number"
            placeholderTextColor="#9ca3af"
            keyboardType={Platform.OS === 'web' ? 'default' : 'phone-pad'}
            inputMode={Platform.OS === 'web' ? 'numeric' : undefined}
            maxLength={10}
            value={phone}
            onChangeText={(t) => setPhone(t.replace(/\D/g, ''))}
            returnKeyType="done"
            blurOnSubmit
            onSubmitEditing={handleSendOtp}
          />
        </View>

        <TouchableOpacity style={styles.cta} onPress={handleSendOtp} disabled={loading} activeOpacity={0.85}>
          {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.ctaText}>Send OTP</Text>}
        </TouchableOpacity>

        {sentNotice ? <Text style={styles.sentNotice}>{sentNotice}</Text> : null}

        <Text style={styles.terms}>By continuing, you agree to our Terms and Privacy Policy</Text>

        <View style={styles.trustRow}>
          <Text style={styles.trustItem}>🔒 Secure</Text>
          <Text style={styles.trustItem}>⚡ Fast support</Text>
          <Text style={styles.trustItem}>🛡️ Built for gig workers</Text>
        </View>
      </View>
    </ScrollView>
  );

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top : 0}
    >
      {Platform.OS === 'web' ? (
        <View style={{ flex: 1 }}>{inner}</View>
      ) : (
        <Pressable style={{ flex: 1 }} onPress={Keyboard.dismiss} accessible={false}>
          {inner}
        </Pressable>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BRAND },
  scrollContent: { flexGrow: 1 },
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
    ...Platform.select({
      web: {
        boxShadow: '0 -4px 16px rgba(0,0,0,0.08)',
      },
      default: {
        shadowColor: '#000',
        shadowOpacity: 0.08,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: -4 },
        elevation: 8,
      },
    }),
  },
  sheetTitle: { fontSize: 20, fontWeight: '800', color: '#111827' },
  sheetSub: { fontSize: 14, color: '#6b7280', marginTop: 8, marginBottom: 16, lineHeight: 20 },
  fieldLabel: { fontSize: 13, fontWeight: '700', color: '#374151', marginBottom: 8 },
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
  sentNotice: {
    marginTop: 14,
    fontSize: 14,
    fontWeight: '600',
    color: '#059669',
    textAlign: 'center',
  },
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
