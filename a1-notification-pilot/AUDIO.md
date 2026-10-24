# A1听觉数字主任务（待确认方案）

更新：2026-10-23。用户最新决定优先：A1改为听觉2-back，用于保持工作记忆任务背景；音频在被试电脑播放。A2未来考虑视觉追踪研究位置，本轮不改A2。新材料等待后续提供，不擅自改写已有通知。

## 使用方式

新建会话默认听觉数字1—9，普通话，1读“一”。被试电脑打开入口，先点击“试听数字（1、4、1）”，调整电脑输出音量并确认听清，再开始。数字由当前浏览器的系统默认音频输出播放，不发给雷鸟，不从主试手机播放。

任务中只显示静止注视符号，不显示当前数字。当前听到的数字与前两个相同就鼠标左键或空格响应，不同不操作；前两项不评分。通知期间数字继续按SOA播放，记忆历史不重置；复述与理解题仍在主任务结束后回答。未改变为双选或50%目标比例，这两项尚无用户确认。

本轮保留12正式Trial、配额轮换、序列审查、可配置时序、通知图片、设备检查与合并统计。旧会话没有primary_modality字段时解释为visual_letters，保留原字母，不转换旧数据。新会话保存auditory_digits、数字序列、音频清单与哈希。

## 固定录音

资源为public/audio/digits/1.wav至9.wav，清单manifest.json。macOS Tingting离线生成，24kHz、单声道、PCM16，每条500ms，峰值约0.8。每条保留25ms发音前余量及至少约100ms尾余量，避免截断词音。运行时不调用实时语音合成。

可在macOS运行`python3 a1-notification-pilot/scripts/generate-digit-audio.py`重建；依赖系统say和afconvert，无需网络TTS。系统语音或版本变化可能生成不同字节，重建后必须新建会话；旧会话的录音哈希不一致时阻止使用新字节代替旧录音。

## 播放与数据

用户点击时解锁AudioContext，开始前预加载、校验SHA-256并解码全部录音；同一段所有BufferSource按绝对音频时钟排程，图片发送不阻塞音频。rAF仅用于任务状态、通知和事件观察，不触发每个数字的播放。音频异常、人工中断、主试终止或离开页面时停止已排程声音，不自动重播。

导出audio_events.csv、audio_manifests.json及逐刺激调度、哈希、音频上下文时间、浏览器观察时刻和输出延迟元数据。每项音频调度证据不完整或检测到音频异常时排除该尝试的统计；视觉/听觉及不同录音版本不混合汇总。

getOutputTimestamp可用时以其软件输出估计映射到performance时钟；否则明确记录currentTime与延迟估计的回退。RT以软件估计的录音缓冲起点为基准（包含固定前余量），不是实测声学起点。acoustic_onset始终未测/为空，不能将调度成功称作用户实际听到。耳机/扬声器、系统音量和输出路径应在一次采集中保持一致。

API依据：[Web Audio输出时间戳](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/getOutputTimestamp)、[定时开始播放](https://developer.mozilla.org/en-US/docs/Web/API/AudioScheduledSourceNode/start)。

## 当前验证边界

已构建9条WAV并核对资源元数据、SHA-256；完成TypeScript与JavaScript静态检查。本轮没有运行行为测试，没有实际播放听辨，也未完成声学测量。旧视觉V0.2的真机验收与25项自动检查属于历史记录，不能代替听觉路径验收。方案参数与材料仍待老师及用户确认。
