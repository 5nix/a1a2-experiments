# A1主任务选择：通知干扰与恢复的文献路径

检索日期：2026-10-22。研究问题按当前讨论理解为：眼镜通知的信息量不同，如何影响电脑上持续进行的主任务，通知消失后表现如何恢复，同时通知是否被理解。以下为方案建议，不变更现有程序或冻结研究设计。原始研究之间任务和设备不同，不能据此宣称某任务已经被证明对本项目最优。

## 推荐结论

若核心结果是秒级干扰/恢复轨迹，优先Pilot连续追踪；若核心结果是工作记忆更新受扰，保留每题响应的2-back；若希望获得较密集的按键RT并侧重持续注意，gradCPT作为备选。把2-back目标比例改成50%只能增加命中机会，不能解决窗口内总刺激数量不足。

## 原始文献与适用边界

1. Rajan, R., Selker, T., & Lane, I. (2016). *Effects of Mediating Notifications Based on Task Load*. AutomotiveUI. DOI: [10.1145/3003715.3005413](https://doi.org/10.1145/3003715.3005413)。[作者机构全文](https://ppms.cit.cmu.edu/media/project_files/Effects_of_Mediating_Notifications_Based_on_Task_Load.pdf)。原研究结合ConTRe连续追踪/反应任务与Google Glass通知，并评估通知加工；是本项目硬件与双任务结构最接近的参考。它使用方向盘/踏板，不能把鼠标版本称为原实验复现。可借用持续任务与通知加工分开测量的逻辑，不照搬其驾驶设备或负荷切换。

2. Nees, M. A., & Sampsell, N. G. (2021). *Simple auditory and visual interruptions of a continuous visual tracking task: modality effects and time course of interference*. Ergonomics, 64(7), 879–890. DOI: [10.1080/00140139.2021.1873424](https://doi.org/10.1080/00140139.2021.1873424)。[摘要](https://pubmed.ncbi.nlm.nih.gov/33428536/)、[作者补充材料](https://figshare.com/articles/journal_contribution/Simple_auditory_and_visual_interruptions_of_a_continuous_visual_tracking_task_modality_effects_and_time_course_of_interference/13736990)。连续追踪误差用于分析简单视觉/听觉提醒的干扰时间过程，该实验报告影响约1500ms。支持追踪路线可用于短时效应，但简单提醒不等于本项目有语义的多单元通知，恢复时长不能直接移植。本次阅读摘要及补充材料，未取得出版社完整正文。

3. Rosenberg, M., Noonan, S., DeGutis, J., & Esterman, M. (2013). *Sustaining visual attention in the face of distraction: a novel gradual-onset continuous performance task*. Attention, Perception, & Psychophysics, 75, 426–439. DOI: [10.3758/s13414-012-0413-x](https://doi.org/10.3758/s13414-012-0413-x)。[作者实验室全文](https://www.bu.edu/ballab/pubs/Rosenberg_et_al_2013.pdf)。该版本使用逐渐转换的人脸、1200ms节奏，多数刺激需响应，分析RT波动与错误。它直接针对稀疏行为采样的问题；但仍是离散响应，且原研究包含较长任务，不能视为单次几秒恢复曲线的现成验证。不要把后来常见的城市场景800ms版本参数误称为这篇首发版本。

4. Lamichhane, B., Westbrook, A., Cole, M. W., & Braver, T. S. (2020). *Exploring brain-behavior relationships in the N-back task*. NeuroImage, 212, 116683. DOI: [10.1016/j.neuroimage.2020.116683](https://doi.org/10.1016/j.neuroimage.2020.116683)。[作者实验室全文](https://www.colelab.org/pubs/2020_LamichhaneCole.pdf)。每个刺激需判断匹配或不匹配，可分析两类反应的行为表现。证明每题双选是已有n-back实现；并未证明它能从单个短通知得到稳定恢复曲线。

5. Stothart, C., Mitchum, A., & Yehnert, C. (2015). *The attentional cost of receiving a cell phone notification*. Journal of Experimental Psychology: Human Perception and Performance, 41(4), 893–897. DOI: [10.1037/xhp0000100](https://doi.org/10.1037/xhp0000100)。[摘要](https://pubmed.ncbi.nlm.nih.gov/26121498/)。支持不与手机交互的通知也可能干扰主任务。它的提醒与本项目主动阅读理解不同，不宜直接借用效应量或恢复时间。本次主要核对摘要与作者稿检索信息。

## 技术方案比较（以下是针对本项目的判断）

| 路线 | 主要可测结果 | 本项目优势 | 解释限制 |
| --- | --- | --- | --- |
| 一维连续追踪 | 连续位置误差、RMSE、相对基线偏离面积、恢复时间 | 不依赖少量目标题；适合通知前中后轨迹 | 包含视觉转移和视觉运动控制；高频采样有自相关 |
| 每题响应2-back | 匹配/不匹配RT、准确率、漏答 | 现有字母模块可复用，保留工作记忆更新需求 | 单个短窗口仍只有少数反应；字母记忆与通知语言加工可能相互干扰 |
| gradCPT | 高频Go反应RT、RT波动、稀有No-go错误 | 研究持续注意的依据直接，操作简单 | 仍需重复事件聚合；稀有No-go不能用于每次通知的小窗准确率；渐变刺激需定义RT归属 |
| 选择反应/Flanker/Stroop | RT、错误、冲突效应 | 每题可记录反应 | 冲突比例、语义竞争和难度带来额外设计因素；本轮不列首选 |

## 建议先做的追踪Pilot（自拟候选，不是论文固定参数）

- 电脑显示一维平滑移动目标，鼠标控制另一标记尽量重合；目标轨迹由种子生成，不能完全可预测。
- 练习阶段校准难度，正式段固定，不随N水平或通知阶段自动改变。
- 逐帧存实际时间、目标和控制位置、帧间隔、输入与失焦异常；沿用现有眼镜图片、双眼回执及前后时钟校准。
- 通知期间持续追踪；理解题和复述放在Post结束后。保持各条件回答延迟一致。
- 候选分析：500ms或1s时间窗，画相对各Trial基线的误差变化；分别按通知出现和消失对齐。分窗宽度、异常处理与恢复阈值先冻结，再收正式数据。
- 恢复定义为回到预先定义的基线容许带并持续一段时间，使用无通知对照估计自然波动。观察期内未恢复记为未观察到/删失，不强行填20秒。
- 主要统计以Trial/被试为层级；每秒60帧不等于60次独立实验。先在Trial内计算时间窗指标，再做被试内比较或层级模型及不确定区间。
- N条件和对照需匹配轨迹难度与相位分布，并平衡分配到不同种子，避免恰逢目标快速运动时的误差被归因于通知。

建议以小规模、顺序平衡的Pilot对比追踪与每题响应2-back；比较练习可达性、基线稳定性、通知理解表现、误差/RT的可用密度和恢复轨迹一致性，不以哪个方案更容易得到显著p值作为选型标准。人数与正式重复次数需根据Pilot的方差和效应精度决定，不能仅凭12个Trial预设宣称足够。

## 本项目已有材料需要一起审查

当前N3材料多为双行，N1/N2为单行；N水平可能同时带来文字长度、布局与阅读时间变化。因此追踪表现下降可解释为通知综合干扰成本，不能只归因于抽象信息单元数量。如果要单独讨论信息单元效应，应匹配这些视觉/阅读因素，或明确记录并在设计和分析中处理。无论采用哪种主任务，仍需保留通知理解指标，避免把未读通知造成的低主任务代价误判为更好的通知设计。
