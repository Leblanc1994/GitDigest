# 日报引擎

一个本地 React 网页工具：选择一个或多个本地 Git 项目，按日期生成可编辑的日报或周报。代码和 Git 数据不会离开电脑。

## 启动

```bash
npm start
```

浏览器打开终端显示的地址（默认是 `http://127.0.0.1:4173`）。

## 桌面版

桌面版使用 Tauri，运行时不需要启动 `server.js`，前端会直接调用本机 Git。开发预览：

```bash
npm run tauri:dev
```

生成当前操作系统的安装包：

```bash
npm run tauri:build
```

安装包会出现在 `src-tauri/target/release/bundle/` 下。macOS、Windows 需要分别在对应系统上构建；使用桌面版的用户仍需安装 Git。

网页模式和桌面模式共用同一套界面代码：网页模式继续请求本地 Node 服务，桌面模式自动切换为 Tauri 原生命令。

在 macOS 上，“添加项目目录”支持在一个系统窗口中多选文件夹；在 Windows 上会打开原生文件夹选择窗口，选完后可选择继续添加下一个项目。

## Windows 使用要求

- 使用网页模式时：安装 Node.js 20 或以上，并安装 Git。
- 使用桌面安装包时：只需安装 Git，并确保命令行可以执行 `git --version`。
- 网页模式的目录选择依赖 PowerShell（Windows 自带）。

## 当前能力

- 从 macOS 或 Windows 原生目录选择窗口添加多个项目目录
- 只在本机调用 Git，不上传代码
- 按指定日期或所在周读取非合并提交，默认只统计当前 Git 身份的提交
- 统计提交数、变更文件数和当前分支
- 直接编辑、复制或导出 Markdown 报告
- 报告优先的工作台布局，并保留可展开的 Git 提交依据
