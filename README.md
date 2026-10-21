# a1a2-experiments

基于现有 A5 实验程序迁移的 A1/A2 工作区。当前提供 [A1 视觉大写字母 2-back 工程预演](a1-notification-pilot/README.md)：通知期间主任务持续运行，鼠标左键或空格响应。通知使用明确标记的电脑模拟卡片和合成材料，真机尚未接入新流程。

## 启动 A1

```sh
npm ci
npm start
```

打开 `http://127.0.0.1:5189/admin`，创建会话并在电脑手动打开被试页面。手机可扫码进入主试后台。已安装依赖并通过A1类型检查；未运行行为测试。

## 从这里开始

- [迁移分析与推荐实施路径](docs/MIGRATION.md)：目标理解、参考差异、复用模块、具体改造位置、开发顺序与材料缺口。
- [参考文档](docs/references/)：用户提供的两份 Markdown 和一份 Word，属于 AI 生成的参考，不是已冻结的实验规范。
- [迁移来源记录](docs/migration-source.json)：源提交、文件清单和 SHA-256。

## 当前代码状态

源项目为本机 `a5-experiments`，基线提交 `404236539b6c8851434f56fcd2e14c3c1de41edd`。保留 `f5-sh-pilot/` 的现有结构，是为了完整复用后台、SQLite、眼镜协议与构建链路；目录内仍运行旧 SH 实验，不能把它当作已经实现的 A1。

仅复制受 Git 管理的基线文件。没有复制源项目的 Git 历史、依赖目录、运行数据库、被试导出、本机设备配置、凭据或 APK 构建产物。原仓库没有被修改。根 npm 包名、双击启动文件名已调整为 a1a2-experiments；原有 A5 环境变量、设备包名、协议名和工作区名暂时保留，避免仅为改名引入兼容问题。旧的验收文档属于源项目记录，不是新项目验收结论。

## 查看旧程序基线

需要 Node.js 24+。依赖尚未在本目录安装。若需要手动运行旧 SH 基线：

```sh
npm ci
PORT=5189 npm run start --workspace=f5-sh-pilot
```

PowerShell：

```powershell
npm ci
$env:PORT = '5189'
npm run start --workspace=f5-sh-pilot
```

该命令会运行旧SH基线；与A1使用同一预览端口，不能同时启动。查看旧基线时可改用其他端口，例如5190。

双击 `a1a2-experiments.command` / `a1a2-experiments.bat` 可选择 `a1-notification-pilot` 或旧SH工作区，二者数据隔离。旧程序使用说明仅针对同级保留的SH基线。
