# A1 Android构建与安装

本目录由原A5显示端迁移，新增A1图片协议；构建结果为独立A1应用。环境要求以Gradle配置为准：JDK21、Android SDK37、Gradle9.5.0，Java源码级别17。安装Android命令行工具，设置JAVA_HOME及ANDROID_HOME，接受SDK许可；不要求Android Studio或模拟器。

在本目录执行（Windows改用gradlew.bat）：

```sh
./gradlew :app:assembleDebug :app:lintDebug --console=plain
node scripts/verify-apk-runtime.mjs app/build/outputs/apk/debug/app-debug.apk
```

产物为`app/build/outputs/apk/debug/app-debug.apk`，版本0.2.0 / 2。包名`link.ironip.a1.rayneo`，名称“A1 雷鸟图片显示”。Java命名空间仍为`link.ironip.a5.rayneo`。没有A5修复版包名切换功能。

```sh
adb devices -l
adb -s <序列号> install -r app/build/outputs/apk/debug/app-debug.apk
adb -s <序列号> shell am start -n link.ironip.a1.rayneo/link.ironip.a5.rayneo.MainActivity
```

后续升级保持同包名和签名，使用install -r保留请求账本。不要清除应用数据或提交签名私钥。构建缓存、local.properties和APK不进入Git；后台下载接口提供本机构建产物。

继续使用本地MercuryAndroidSDK-v0.2.6.aar和显式Lifecycle KTX依赖；verify-apk-runtime检查实际DEX类定义，防止镜腿触控时缺少运行类。源码保留原文字模式及音频资源，但A1后台图片路径使用无提示音的固定时长显示。旧qa/StyleRenderCheck.java只针对继承的文字布局，不是A1图片验收。

2026-10-22在当前Mac完成assembleDebug、lintDebug、运行类检查、apksigner验证；已连接当前RayNeo X3 Pro并完成V0.2短流程联调；不代表长时间或光学验收，见[验收记录](../../docs/QA-V0.2.md)。控制页操作、图片参数和时间分析限制见[设备说明](../DEVICE.md)。
