# GitHub 发布

本项目已经配置 GitHub Pages 自动部署：推送到 `main` 后，Actions 会自动执行 `npm ci`、`npm run build` 并发布 `dist/`。

首次发布时，在 GitHub 仓库的 **Settings → Pages** 里将 Source 设为 **GitHub Actions**。之后访问：

`https://<你的用户名>.github.io/<仓库名>/`

Vite 使用相对资源路径，仓库名变化不需要重新改 `vite.config.js`。
