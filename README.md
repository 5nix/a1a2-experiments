# a1a2-experiments

基于现有 A5 实验程序迁移的 A1/A2 工作区。当前提供 [A1 视觉大写字母 2-back 工程预演](a1-notification-pilot/README.md)：通知期间主任务持续运行，鼠标左键或空格响应。新会话已默认接入用户提供的18条通知材料和原始卡片，支持电脑模拟及独立 A1 安卓图片显示端；真机连接与手动发送入口见后台“准备与检查”，物理设备验收尚待完成。归档与生成规则见 [材料说明](a1-notification-pilot/content/README.md)。

## 启动 A1

```sh
npm ci
npm start
```

打开 `http://127.0.0.1:5189/admin`，创建会话并在电脑手动打开被试页面。手机可扫码进入主试后台。验证结果与待完成项见 [简要现状](docs/STATUS.md)。

## 从这里开始

- [项目简要现状](docs/STATUS.md)：当前功能、验证结果和待完成项。

- [迁移分析与推荐实施路径](docs/MIGRATION.md)：目标理解、参考差异、复用模块、具体改造位置、开发顺序与材料缺口。
- [参考文档](docs/references/)：用户提供的两份 Markdown 和一份 Word，属于 AI 生成的参考，不是已冻结的实验规范。
- [迁移来源记录](docs/migration-source.json)：源提交、文件清单和 SHA-256。

## 当前代码状态

源项目为本机 `a5-experiments`，基线提交 `404236539b6c8851434f56fcd2e14c3c1de41edd`。保留 `f5-sh-pilot/` 的现有结构，是为了完整复用后台、SQLite、眼镜协议与构建链路；目录内仍运行旧 SH 实验，不能把它当作已经实现的 A1。

仅复制受 Git 管理的基线文件。没有复制源项目的 Git 历史、依赖目录、运行数据库、被试导出、本机设备配置、凭据或 APK 构建产物。原仓库没有被修改。根 npm 包名、双击启动文件名已调整为 a1a2-experiments；旧SH工作区保留原A5配置；新A1图片显示端使用独立包名和协议，安装说明见 [设备说明](a1-notification-pilot/DEVICE.md)。旧的验收文档属于源项目记录，不是新项目验收结论。

## 查看旧程序基线

需要 Node.js 24+。若需要手动运行旧 SH 基线：

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
