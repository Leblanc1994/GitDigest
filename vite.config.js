import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { strictPort: true, port: 4174, proxy: { '/api': 'http://127.0.0.1:4173' } },
});
