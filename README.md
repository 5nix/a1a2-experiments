# a1a2-experiments

基于现有 A5 实验程序迁移的 A1/A2 工作区。当前 A1 主任务为 [二维动态补偿追踪](a1-notification-pilot/README.md)：被试按住鼠标左键拖动补偿圆点的平滑扰动，眼镜显示通知，通知期间追踪连续。当前候选正式设计为 10 个 Trial（9 通知＋1 对照，N1/N2/N3 各 3 条），Pre/通知/Post 为 20/8.5/15 秒；取消复述，保留理解题及原有努力量表。通知材料已更新为2026-10-24的CSV及PNG原图。

## 2026-10-24 最新状态

每个 Trial 使用种子可复现的多正弦扰动，无输入不自动回中；鼠标相对位移累计补偿，无需锁定指针。候选采样间隔为 50 ms，保留完整追踪和输入记录，支持按有效时长加权的 RMSE 与通知消失后 1 秒分窗恢复分析。参数尚待 Pilot 冻结。

2026-10-24 已完成当前 macOS＋雷鸟真机快速流程、图片双眼截图、回执、软件校准、导出和退出/重启检查。正式10次整轮、物理插拔和佩戴体验尚未验收。详情见 [项目现状](docs/STATUS.md)。

[本轮原始需求](<docs/references/2026-10-24/A1通知实验程序修改需求｜V0.2 (1).md>) 已原样归档；来源参考服从用户明确指示。旧会话保留原快照，旧 SH 工作区继续独立保留。

## 启动 A1

macOS 日常使用：双击根目录的 `开启实验.command`，自动启动 A1 并打开后台；重复打开复用现有服务。终端窗口可以关闭。网页右上角“退出并关闭系统”会停止实验服务、本系统启动的 scrcpy 和 A1 眼镜应用，恢复守护管理的设备权限；已有数据保留。此操作关闭实验程序，不关闭 macOS。未连接眼镜时仍能启动后台并使用 Mock。

首次安装需要 Node.js 24+，并在仓库运行 `npm ci`；真机另需 Android platform-tools、scrcpy 和 A1 APK。启动失败时终端保留具体原因。日志位于 `.launcher/a1-notification-pilot/service.log`。

```sh
npm ci
npm start
```

打开 `http://127.0.0.1:5189/admin`，创建会话并在电脑手动打开被试页面。手机可扫码进入主试后台。验证结果与待完成项见 [简要现状](docs/STATUS.md)。

## 从这里开始

- [历史 V0.2 验收记录](docs/QA-V0.2.md)：此前版本的自动检查、真机回执、时钟映射和浏览器短流程，不代表本轮追踪已验收。

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
