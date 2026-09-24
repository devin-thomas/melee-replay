module.exports = {
  packagerConfig: {
    asar: { unpack: '**/node_modules/@slippi/slippi-js/**' },
    executableName: 'Melee Replay',
    extraResource: ['third-party'],
    ignore: (file) => Boolean(file) && !file.startsWith('/.vite') && !file.startsWith('/node_modules')
  },
  hooks: {
    prePackage: async () => { await import('./scripts/generate-third-party-notices.mjs'); }
  },
  rebuildConfig: {},
  makers: [
    { name: '@electron-forge/maker-squirrel', config: { name: 'MeleeReplay', authors: 'Devin Thomas' } },
    { name: '@electron-forge/maker-zip', platforms: ['win32'] }
  ],
  plugins: [
    { name: '@electron-forge/plugin-auto-unpack-natives', config: {} },
    {
      name: '@electron-forge/plugin-vite',
      config: {
        build: [
          { entry: 'src/main/index.ts', config: 'vite.main.config.mts' },
          { entry: 'src/preload.ts', config: 'vite.preload.config.mts' },
          { entry: 'src/main/parse-worker.ts', config: 'vite.main.config.mts' }
        ],
        renderer: [{ name: 'main_window', config: 'vite.renderer.config.mts' }]
      }
    }
  ]
};
