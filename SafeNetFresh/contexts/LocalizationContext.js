import React, { createContext, useContext, useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import en from '../locales/en.json';
import hi from '../locales/hi.json';
import te from '../locales/te.json';

const LocalizationContext = createContext();

const translations = {
  en,
  hi,
  te,
};
const STORAGE_KEY = 'safenet.language';

function getDeviceLanguageTag() {
  try {
    if (typeof navigator !== 'undefined') {
      if (Array.isArray(navigator.languages) && navigator.languages.length) {
        return String(navigator.languages[0] || 'en');
      }
      if (navigator.language) return String(navigator.language);
    }
  } catch (_) {}
  return 'en';
}

export function LocalizationProvider({ children }) {
  const [language, setLanguage] = useState('en');

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const saved = await AsyncStorage.getItem(STORAGE_KEY);
        if (saved && translations[saved] && mounted) {
          setLanguage(saved);
          return;
        }
      } catch (_) {}
      const localeTag = getDeviceLanguageTag();
      const deviceLanguage = String(localeTag).split('-')[0].toLowerCase();
      if (translations[deviceLanguage] && mounted) {
        setLanguage(deviceLanguage);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const changeLanguage = async (nextLanguage) => {
    if (!translations[nextLanguage]) return;
    setLanguage(nextLanguage);
    try {
      await AsyncStorage.setItem(STORAGE_KEY, nextLanguage);
    } catch (_) {}
  };

  const t = (key) => {
    const keys = key.split('.');
    let value = translations[language];

    for (const k of keys) {
      if (value && typeof value === 'object') {
        value = value[k];
      } else {
        value = null;
        break;
      }
    }

    if (!value) {
      value = translations.en;
      for (const k of keys) {
        if (value && typeof value === 'object') {
          value = value[k];
        } else {
          return key;
        }
      }
    }

    return value || key;
  };

  return (
    <LocalizationContext.Provider value={{ language, setLanguage: changeLanguage, t }}>
      {children}
    </LocalizationContext.Provider>
  );
}

export function useLocalization() {
  const context = useContext(LocalizationContext);
  if (!context) {
    throw new Error('useLocalization must be used within LocalizationProvider');
  }
  return context;
}
