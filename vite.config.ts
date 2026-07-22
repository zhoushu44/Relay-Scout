import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import tsconfigPaths from "vite-tsconfig-paths";

function backendPlugin(): Plugin {
  let backend: ChildProcess | undefined
  return {
    name: 'auto-start-backend',
    configureServer() {
      if (backend && backend.exitCode === null) return
      backend = spawn(process.platform === 'win32' ? 'node.exe' : 'node', [resolve(__dirname, 'server.cjs')], {
        cwd: __dirname,
        stdio: 'inherit',
        windowsHide: true,
      })
      backend.on('error', (error) => console.error('[backend] 启动失败:', error.message))
    },
    closeBundle() {
      if (backend && backend.exitCode === null) backend.kill()
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  server: {
    port: 5777,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:5778',
    },
  },
  build: {
    sourcemap: false,
  },
  plugins: [
    backendPlugin(),
    react({
      babel: process.env.NODE_ENV === 'production'
        ? undefined
        : {
            plugins: [
              'react-dev-locator',
            ],
          },
    }),
    tsconfigPaths()
  ],
})
