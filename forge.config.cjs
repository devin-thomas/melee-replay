module.exports = {
  packagerConfig: {
    asar: true,
    executableName: 'Melee Replay',
    ignore: (file) => Boolean(file) && !file.startsWith('/.vite') && !file.startsWith('/node_modules')
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
