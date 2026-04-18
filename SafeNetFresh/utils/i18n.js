// utils/i18n.js
import * as Localization from 'expo-localization';

const T = {
  en: {
    send_otp: 'Send OTP', code_sent: 'Code sent — check your SMS',
    detecting_zone: 'Detecting your zone…', zone_detected: 'Zone detected',
    zone_denied: 'Location denied. Select zone manually.',
    platform_label: 'Delivery platform', earnings_label: 'Avg daily earnings (₹)',
    get_coverage: 'Get Coverage', covered_until: 'You are covered until',
    coverage_active: 'Coverage Active', coverage_inactive: 'No Active Coverage',
    trust_score: 'Trust Score', protected_this_week: 'Protected this week',
    active_disruption: 'disruption detected — claim being processed',
    no_disruptions: 'No active disruptions in your zone',
    recent_claims: 'Recent Claims', no_claims_yet: 'No claims yet. Payouts appear here after disruptions.',
    claim_approved: 'credited', claim_review: 'Under verification (ETA 2 hrs)',
    claim_rejected: 'Claim not eligible', breakdown_label: 'Payout breakdown',
    your_coverage: 'Your Coverage', premium_breakdown: 'Premium breakdown',
    base_premium: 'Base premium', zone_risk: 'Zone risk multiplier',
    trust_adj: 'Trust adjustment', weekly_premium: 'Weekly premium',
    coverage_cap: 'Max payout / week',
    retry: 'Retry', loading: 'Loading…', error_generic: 'Something went wrong. Please try again.',
  },
  hi: {
    send_otp: 'OTP भेजें', code_sent: 'कोड भेजा गया',
    detecting_zone: 'क्षेत्र पता लगाया जा रहा है…', zone_detected: 'क्षेत्र मिला',
    zone_denied: 'स्थान अनुमति नहीं मिली।',
    platform_label: 'डिलीवरी प्लेटफ़ॉर्म', earnings_label: 'औसत दैनिक कमाई (₹)',
    get_coverage: 'कवरेज लें', covered_until: 'आप तक कवर हैं',
    coverage_active: 'कवरेज सक्रिय', coverage_inactive: 'कोई कवरेज नहीं',
    trust_score: 'विश्वास स्कोर', protected_this_week: 'इस सप्ताह सुरक्षित',
    active_disruption: 'व्यवधान मिला — दावा प्रक्रिया में है',
    no_disruptions: 'कोई व्यवधान नहीं', recent_claims: 'हाल के दावे',
    no_claims_yet: 'अभी कोई दावा नहीं।',
    claim_approved: 'जमा किया गया', claim_review: 'सत्यापन में (2 घंटे)',
    claim_rejected: 'दावा अयोग्य', breakdown_label: 'भुगतान विवरण',
    your_coverage: 'आपकी कवरेज', premium_breakdown: 'प्रीमियम विवरण',
    base_premium: 'आधार प्रीमियम', zone_risk: 'क्षेत्र जोखिम',
    trust_adj: 'विश्वास समायोजन', weekly_premium: 'साप्ताहिक प्रीमियम',
    coverage_cap: 'अधिकतम भुगतान/सप्ताह',
    retry: 'पुनः प्रयास', loading: 'लोड हो रहा है…', error_generic: 'कुछ गलत हुआ।',
  },
  te: {
    send_otp: 'OTP పంపండి', code_sent: 'కోడ్ పంపబడింది',
    detecting_zone: 'జోన్ గుర్తిస్తున్నాము…', zone_detected: 'జోన్ గుర్తించబడింది',
    zone_denied: 'స్థాన అనుమతి నిరాకరించబడింది.',
    platform_label: 'డెలివరీ ప్లాట్ఫారమ్', earnings_label: 'సగటు రోజువారీ ఆదాయం (₹)',
    get_coverage: 'కవరేజ్ పొందండి', covered_until: 'మీరు వరకు కవర్',
    coverage_active: 'కవరేజ్ యాక్టివ్', coverage_inactive: 'కవరేజ్ లేదు',
    trust_score: 'నమ్మకం స్కోర్', protected_this_week: 'ఈ వారం రక్షించబడింది',
    active_disruption: 'అంతరాయం — క్లెయిమ్ ప్రాసెస్ అవుతోంది',
    no_disruptions: 'అంతరాయాలు లేవు', recent_claims: 'ఇటీవలి క్లెయిమ్లు',
    no_claims_yet: 'ఇంకా క్లెయిమ్లు లేవు.',
    claim_approved: 'జమ చేయబడింది', claim_review: 'ధృవీకరణలో (2 గంటలు)',
    claim_rejected: 'అర్హత లేదు', breakdown_label: 'చెల్లింపు వివరాలు',
    your_coverage: 'మీ కవరేజ్', premium_breakdown: 'ప్రీమియం వివరాలు',
    base_premium: 'బేస్ ప్రీమియం', zone_risk: 'జోన్ రిస్క్',
    trust_adj: 'నమ్మకం సర్దుబాటు', weekly_premium: 'వారపు ప్రీమియం',
    coverage_cap: 'గరిష్ట చెల్లింపు/వారం',
    retry: 'మళ్ళీ ప్రయత్నించండి', loading: 'లోడ్ అవుతోంది…', error_generic: 'తప్పు జరిగింది.',
  },
};

const locale = (Localization.getLocales?.()[0]?.languageCode ?? 'en').toLowerCase();
const lang = T[locale] ? locale : 'en';

export function t(key) {
  return T[lang]?.[key] ?? T.en[key] ?? key;
}
