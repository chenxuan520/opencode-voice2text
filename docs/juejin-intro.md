# 还在手打 prompt？我给 OpenCode 做了个语音输入插件，vibe coding 的时候真的爽很多

如果你已经把 OpenCode 当成日常主力工具来用，尤其是经常在终端里一边写 prompt、一边改代码、一边排查问题，那你大概率也会遇到我这个特别真实的痛点：

**脑子已经想好了，但手还在键盘上慢慢敲。**

尤其是在这种时候，这种感觉会特别强：

*   你要快速描述一个 bug 现象
*   你要把一长段排查思路喂给 OpenCode
*   你已经进入 vibe coding 状态了，不想被打字打断
*   你知道自己要表达什么，但键盘速度明显跟不上脑子

我后来发现，很多时候不是我不会写 prompt，而是我根本不想在那个时刻“重新组织句子再手打出来”。

于是我做了一个 OpenCode 插件：`opencode-voice2text`。

它做的事情很直接：

*   按一下快捷键开始语音输入
*   一边说话，一边把音频实时送去识别
*   稳定识别出来的文字直接流进当前 prompt
*   再按一下停止
*   最后自动补齐尾句

也就是说，你不是在“先录音，再转写，再复制”，而是：

> **直接在 OpenCode 里说，文字直接进 prompt。**

这就是我想要的真实 vibe coding 体验。

## 项目地址

*   **GitHub**: <https://github.com/chenxuan520/opencode-voice2text>
*   **npm**: `opencode-voice2text`

## 实际体验

![20260411224410\_rec\_.gif](https://p0-xtjj-private.juejin.cn/tos-cn-i-73owjymdk6/4179b924c4ab486f95a8f3c41c688e17~tplv-73owjymdk6-jj-mark-v1:0:0:0:0:5o6Y6YeR5oqA5pyv56S-5Yy6IEAgY2hlbnh1YW41MjA=:q75.awebp?policy=eyJ2bSI6MywidWlkIjoiNjAyOTcyOTE4OTA3NzIwIn0%3D&rk3s=f64ab15b&x-orig-authkey=f32326d3454f2ac7e96d3d06cdbb035152127018&x-orig-expires=1776577179&x-orig-sign=SS1gZT%2FNxDYlKCcEfRPTLRj2YvU%3D)

## 这个插件最核心的价值是什么

先不讲实现，先讲体验。

我觉得这个插件最值钱的点，不是“它支持语音转文字”，而是它把语音输入直接接到了 OpenCode 的工作流里。

市面上当然不缺语音转文字工具，但很多工具的问题在于：

*   不在你当前工作的上下文里
*   你得先录，再转，再复制，再切回来
*   一旦流程长了，语音输入本身就失去意义了

而 `opencode-voice2text` 想做的是一件更朴素但也更实用的事：

**让你在 OpenCode 里输入 prompt 的方式，从“打字”扩展成“说话”。**

这个区别其实很大。

比如这些场景就非常适合：

*   快速复述线上问题
*   描述复杂复现路径
*   一口气把脑子里的需求说清楚
*   中文场景里不想频繁切输入法
*   已经进入状态，不想被键盘节奏打断

## 现在已经支持什么

当前版本已经支持这些能力：

*   OpenCode TUI 标准插件安装
*   独立终端 CLI：安装同一个 npm 包后可以直接运行 `voice2text`
*   流式语音识别，不是录完整段再整体上传
*   识别中的稳定文本实时写入 prompt
*   第二次按键停止并补齐最后一段文本
*   macOS / Linux 可用
*   provider 架构已经抽象，方便后续接别的 ASR 服务
*   配置缺失或运行报错时会给明确提示，不会静默失败

当前内置 provider：

*   `volcengine`

## 为什么我当前先选火山引擎

> 产品地址 [语音识别-火山引擎](https://www.volcengine.com/product/asr)

这里我也直接说结论：

我当前没有优先做“本地部署模型语音识别”，也没有优先接 OpenAI 那类海外接口，而是先把内置 provider 放在了 **火山引擎 Volcengine ASR** 上。

原因非常现实，而且我觉得这些恰恰是它最有价值的地方：

*   **有免费额度**：对我现在这个插件的使用场景来说，先把它低门槛跑起来比什么都重要。火山引擎本身就有免费 20h 的时长，这对个人开发者非常友好。
*   **整体成本便宜**：价格是 **1 块钱 1 小时** 这个量级。对于“给 OpenCode 增加语音输入”这件事来说，这个成本几乎已经低到可以忽略。
*   **不需要本地部署模型**：你不需要在自己电脑上再折腾一套本地 ASR 模型环境，不需要下载模型，不需要处理模型兼容、CPU/GPU占用、推理速度这些额外问题。
*   **不需要 OpenAI API Key**：很多人一提实时语音就先想到海外 API，但那通常意味着你还要再准备一套 API Key、额度和计费体系。火山引擎这条链路更直接。
*   **不需要魔法上网**：这个对中文开发者非常重要。语音输入本身不应该再附带一层额外的网络前置条件，不然它很难成为一个真正日常可用的工作流能力。
*   **中文识别精度很高**：至少就我自己现在的实际使用感受来说，中文场景下的识别效果已经足够好，拿来做 prompt 输入是完全够用的，不会有那种“识别一堆乱七八糟结果反而更累”的问题。

对我来说，这个插件最重要的不是“理论上可以接多少最先进模型”，而是：

> **一个普通开发者能不能以尽可能低的门槛，把它装起来、配起来，然后真的每天顺手用起来。**

从这个标准看，火山引擎是当前很合适的第一内置 provider。

## 实际交互是什么样的

这个插件现在的交互很克制，没有做太多花活：

1.  第一次按快捷键，开始录音
2.  录音期间会有一个持续中的提示，告诉你正在 listening
3.  稳定识别结果会直接追加到当前 prompt
4.  第二次按快捷键，停止录音
5.  最终尾句会自动补齐

正常流程下不会疯狂弹一堆成功提示。

只有这些情况才会提示你：

*   provider 没配
*   凭据不完整
*   本机没装 Sox 的 `rec`
*   识别链路本身报错

这一点我自己很看重。

因为我不想做一个“每按一次就弹一堆 toast”的东西。

## 安装方式

推荐直接使用 OpenCode 官方插件安装方式：

```bash
opencode plugin opencode-voice2text@latest --global
```

如果你只想在当前项目使用：

```bash
opencode plugin opencode-voice2text@latest
```

安装之后，OpenCode 会更新你的 `tui.json` 里的插件项，但不会把整份配置粗暴覆盖掉。

默认快捷键是：

```json
"commandKeybind": "ctrl+s"
```

如果你不想绑定 OpenCode，也可以把同一个包作为普通终端命令使用：

```bash
npm install -g opencode-voice2text
voice2text
```

包名仍然是 `opencode-voice2text`，安装后的命令是 `voice2text`。

CLI 默认启动后立刻录音，识别出的稳定文本会流式输出到终端。按 `Enter`、`Ctrl+C` 或 `Ctrl+S` 停止并补齐最终结果。

如果希望命令常驻，并用快捷键反复开始 / 停止，可以使用：

```bash
voice2text --toggle
```

toggle 模式默认也是 `Ctrl+S`：

*   按一次 `Ctrl+S` 开始录音
*   再按一次 `Ctrl+S` 停止并补齐最终结果
*   按 `Ctrl+C` 退出

也可以换成其他快捷键：

```bash
voice2text --toggle --toggle-key ctrl+g
```

## 一个特别现实的问题：Ctrl+S 可能会没反应

这个问题不是插件独有，而是终端世界里的经典坑。

很多终端会把 `Ctrl+S` 当成 XON/XOFF 流控，而不是普通快捷键。所以如果你遇到下面这种情况：

*   slash 命令能触发
*   插件其实也装好了
*   但直接按 `Ctrl+S` 没反应

那大概率不是插件坏了，而是终端把这个键给吞了。

临时解决方案：

```bash
stty -ixon
```

如果你用的是 zsh，可以把它放进 `~/.zshrc`：

```bash
stty -ixon
```

如果你用的是 bash，可以放进 `~/.bashrc` 或 `~/.bash_profile`。

如果你完全不想处理这个冲突，也没关系，直接把插件配置里的 `commandKeybind` 改成你自己的组合键就行。

如果你用的是独立 CLI toggle 模式，同样可以换快捷键：

```bash
voice2text --toggle --toggle-key ctrl+g
```

## 火山引擎怎么配(推荐直接问 ai 就行)

> 产品地址 [语音识别-火山引擎](https://www.volcengine.com/product/asr)

当前内置的是 Volcengine ASR，所以你需要在本地准备一个配置文件：

```bash
~/.config/opencode/voice2text.local.json
```

配置格式如下：

```json
{
  "provider": "volcengine",
  "providerConfig": {
    "appId": "your-app-id",
    "accessToken": "your-access-token",
    "resourceId": "volc.seedasr.sauc.duration",
    "endpoint": "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async"
  },
  "language": "zh-CN",
  "chunkMs": 200,
  "endWindowSize": 800,
  "maxDurationSeconds": 180,
  "appendTrailingSpace": true,
  "rate": 16000,
  "bits": 16,
  "channels": 1
}
```

你需要从火山引擎控制台拿到这些值：

*   `providerConfig.appId`
*   `providerConfig.accessToken`
*   `providerConfig.resourceId`
*   `providerConfig.endpoint`

大致流程是：

1.  打开 [官网](https://www.volcengine.com/product/asr) 登录火山引擎控制台, 如果没登录注册先注册登录账号, 打开语音识别 / ASR 服务页面

![image.png](https://p0-xtjj-private.juejin.cn/tos-cn-i-73owjymdk6/914731c2a91a4b06a810f378b3fe6c52~tplv-73owjymdk6-jj-mark-v1:0:0:0:0:5o6Y6YeR5oqA5pyv56S-5Yy6IEAgY2hlbnh1YW41MjA=:q75.awebp?policy=eyJ2bSI6MywidWlkIjoiNjAyOTcyOTE4OTA3NzIwIn0%3D&rk3s=f64ab15b&x-orig-authkey=f32326d3454f2ac7e96d3d06cdbb035152127018&x-orig-expires=1776577179&x-orig-sign=ApJ0uhrSIXSUMyKqoIOmNa9rpUI%3D)

2.  创建或选择一个应用
![image.png](https://p0-xtjj-private.juejin.cn/tos-cn-i-73owjymdk6/0df90984bb13440791341a6363054640~tplv-73owjymdk6-jj-mark-v1:0:0:0:0:5o6Y6YeR5oqA5pyv56S-5Yy6IEAgY2hlbnh1YW41MjA=:q75.awebp?policy=eyJ2bSI6MywidWlkIjoiNjAyOTcyOTE4OTA3NzIwIn0%3D&rk3s=f64ab15b&x-orig-authkey=f32326d3454f2ac7e96d3d06cdbb035152127018&x-orig-expires=1776577179&x-orig-sign=c2zot4vPosU%2FdTGNggFhY2tVOVg%3D)

3.  获取应用对应的凭据和资源配置
![image.png](https://p0-xtjj-private.juejin.cn/tos-cn-i-73owjymdk6/3252f89ebc8c4caa9f02a2a83ceb1b41~tplv-73owjymdk6-jj-mark-v1:0:0:0:0:5o6Y6YeR5oqA5pyv56S-5Yy6IEAgY2hlbnh1YW41MjA=:q75.awebp?policy=eyJ2bSI6MywidWlkIjoiNjAyOTcyOTE4OTA3NzIwIn0%3D&rk3s=f64ab15b&x-orig-authkey=f32326d3454f2ac7e96d3d06cdbb035152127018&x-orig-expires=1776577179&x-orig-sign=ah7u3R415k%2FT7W2s72bgfyoQmeo%3D)

4.  填进本地 `voice2text.local.json` , 其中 Resource-Id 在 [大模型流式语音识别API--豆包语音-火山引擎](https://www.volcengine.com/docs/6561/1354869?lang=zh) 这里找, 推荐直接填 volc.seedasr.sauc.duration , endpoint 的话是 wss\://openspeech.bytedance.com/api/v3/sauc/bigmodel\_async
![image.png](https://p0-xtjj-private.juejin.cn/tos-cn-i-73owjymdk6/33774e113d974980b7fd118647d76fd6~tplv-73owjymdk6-jj-mark-v1:0:0:0:0:5o6Y6YeR5oqA5pyv56S-5Yy6IEAgY2hlbnh1YW41MjA=:q75.awebp?policy=eyJ2bSI6MywidWlkIjoiNjAyOTcyOTE4OTA3NzIwIn0%3D&rk3s=f64ab15b&x-orig-authkey=f32326d3454f2ac7e96d3d06cdbb035152127018&x-orig-expires=1776577179&x-orig-sign=bYNbqFGw6rVXNbVooVhqZc%2FVN9s%3D)

如果你没配好，插件不会装死，而是会直接弹 warning toast 告诉你哪里有问题。

## 为什么我还特地做了 provider 架构

一开始其实完全可以偷懒，直接把 Volcengine 写死在主逻辑里，先能跑再说。

但只要这个插件准备分享，问题很快就会变成：

**别人不一定也想用火山。**

所以我后来把结构又往前推了一步，现在代码大概是这样：

*   `src/index.tsx`
    *   插件主流程
    *   负责录音、状态、prompt 写入、错误提示
*   `src/providers/types.ts`
    *   provider 接口和识别会话类型
*   `src/providers/index.ts`
    *   provider registry
*   `src/providers/volcengine.ts`
    *   火山引擎实现细节

这意味着后面如果要接：

*   其他云厂商 ASR
*   自建 WebSocket 识别服务
*   公司内部语音网关

就不需要把整个插件推翻重写。

你只需要：

1.  新增一个 provider 文件
2.  实现统一的 `VoiceProvider` 接口
3.  注册进 provider registry
4.  在本地配置里切换 `provider`

我觉得这是一个很典型的“先解决自己的问题，但别把未来扩展彻底堵死”的工程取舍。

## 这件事真正难的，其实不是“接个 ASR”

如果只是“把音频发给识别服务，再把结果拿回来”，这件事本身没有难到离谱。

真正难的是：

**要把它做成一个真的能嵌进 OpenCode 工作流里的能力。**

中间会碰到一堆比“调接口”更烦的东西：

*   OpenCode 插件安装后的真实加载行为
*   npm 包入口和本地文件入口的差异
*   终端快捷键冲突
*   语音识别中间结果如何增量写进 prompt
*   什么提示该出现，什么提示不该烦用户

所以这个项目对我来说，最有意思的地方其实不是调用了哪个接口，而是：

> 如何把语音输入做成一个终端里真正顺手的输入能力。

## 适合谁用

我觉得这插件特别适合下面这些人：

*   已经把 OpenCode 当成主力终端 AI 工具的人
*   只想在 macOS / Linux 终端里直接语音转文字的人
*   经常需要快速组织 prompt 的人
*   中文输入场景很多、懒得频繁切输入法的人
*   在排查 bug / 写复现描述时更习惯先说出来的人
*   已经开始认真尝试 vibe coding 的人

## 当前限制也很真实

我不会把它吹成“已经完美”，它现在还是有一些现实限制：

*   默认 `Ctrl+S` 可能和终端流控冲突
*   当前内置 provider 只有 Volcengine
*   交互是 toggle，不是按住说话
*   依赖本机安装 Sox 的 `rec`

但对我来说，这些都属于“后面继续迭代”的问题。

关键是现在这条链路已经真正跑通了：

> **在 OpenCode 里，用语音把文字直接送进 prompt。**

## 最后

我越来越觉得，很多 AI 工具的体验瓶颈，不是模型不够强，而是输入链路太别扭。

当你已经知道自己要表达什么的时候，键盘未必是最快的那条路。

所以这次做这个插件，本质上就是在补 OpenCode 的一个输入能力缺口：

**让“说 prompt”这件事变得自然一点，让 vibe coding 不至于总是被键盘输入打断。**

如果你也在用 OpenCode，而且你也觉得很多 prompt 更适合先说出来，这个插件你可以试试。

如果你有更顺手的快捷键建议，或者你也想补别的 ASR provider，欢迎提 issue 或 PR。
