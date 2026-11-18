# 发布清单（1.1.8）

按顺序做，每一步都可以单独回退。带 ⚠️ 的步骤涉及外部可见状态，做之前需要你点头。

## 0. 发版前自查（每次发版都重跑一遍，别照抄上一次的勾）

- [ ] `node --check lazy-comfy.mjs` 退出 0
- [ ] `npm test` → **30 个用例全绿、0 跳过**（本地；换平台的差异以 CI 为准）
- [ ] GitHub Actions（Node 20 / 22 / 24）绿了，再在 Release 里写「三平台通过」
- [ ] 真机冒烟：代理 → 真 ComfyUI，`POST /prompt` 能出图
- [ ] 空闲卸载 / 空闲结束 / PID 复用 / 被动不唤醒 —— 集成测试覆盖
- [ ] README 的 `--help` 块与 `node lazy-comfy.mjs --help` 输出逐字一致
- [ ] README / CHANGELOG / 本文件里的用例数与实际一致
- [ ] `package.json` 里没有 `REPLACE-ME`、没有本机路径

> 这一栏请在自己机器上跑完再勾。历史上出现过「文档写全绿、实际 20/21」的翻车。

## 1. 确定仓库地址

`package.json` 目前**没有** `repository` / `homepage` / `bugs` 字段 —— 仓库地址定下来之后再补，
补完要能对应到真实可访问的 URL，不要留占位符：

```json
"repository": { "type": "git", "url": "git+https://github.com/<你的用户名>/lazy-comfy.git" },
"homepage": "https://github.com/<你的用户名>/lazy-comfy#readme",
"bugs": { "url": "https://github.com/<你的用户名>/lazy-comfy/issues" }
```

## 2. 本地建库

```bash
cd <解压后的项目目录>
git init
git add -A
git commit -m "lazy-comfy 1.1.8：按需启动 + 分级休眠代理"
git tag v1.1.8
```

⚠️ `git init` / `commit` / `tag` 属于 git 操作，需要你明确授权后再执行。

`DEPLOY-WINDOWS.md`（本机部署笔记）**不要**进仓库，也不要放进 zip —— 里面有本机路径与 PID。
`.gitignore` 已排除 `*.log`、`node_modules`、`.lazy-comfy`。

## 3. 建远端并推送

```bash
# 先在 GitHub / Gitee 网页上建空仓库（不要勾 README）
git remote add origin https://github.com/<你的用户名>/lazy-comfy.git
git push -u origin master
git push origin v1.1.8
```

⚠️ 推送是外部可见操作，需要单独授权。

网络提示（通用）：国内直连 GitHub 可能很慢或超时，可临时用镜像/代理前缀拉取；
`git push` 走的是你自己的网络，如果全局配了 `http.https://github.com.proxy`，确认那个端口真的有代理在跑。

## 4. 发 Release

- 标题：`v1.1.8`
- 正文：直接取 `CHANGELOG.md` 里 `## 1.1.8` 那一节（含开头那句「1.1.4 不要用」）
- 附件：`lazy-comfy-1.1.8.zip`（源码包）、`lazy-comfy.mjs`（单文件版，给只想换一个文件的人）

## 5. 可选：发 npm

```bash
npm publish --access public
```

`package.json` 已经配好 `bin`、`files`、`engines`，`files` 只带主程序与三份文档，
不会把测试和本机部署笔记打进包里。⚠️ 发布到 npm 不可撤销（只能 deprecate），需单独确认。

## 6. 发完之后

- 在 README 顶部加一句真实安装命令（如果发了 npm）：
  `npx lazy-comfy` 或 `npm i -g lazy-comfy && lazy-comfy`
- 记一句 Release 里没说清的坑：**挂机回来后 ComfyUI 网页需要手动刷新**（后端被结束过，
  前端不会自己重连成功）。这是有意的取舍，不是 bug。
