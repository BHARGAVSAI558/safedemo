const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.transformer = {
  ...config.transformer,
  minifierConfig: {
    ...(config.transformer?.minifierConfig || {}),
    mangle: { toplevel: true },
    compress: {
      drop_console: process.env.NODE_ENV === 'production',
      passes: 2,
    },
  },
};

module.exports = config;
