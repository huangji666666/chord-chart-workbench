import { defineConfig } from 'vite';

// 交付物是可部署到任意静态站点的 dist 目录，因此 base 使用相对路径。
// 本版不依赖任何运行时 CDN，所有依赖都在 devDependencies 中本地安装、构建时打包。
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
});
