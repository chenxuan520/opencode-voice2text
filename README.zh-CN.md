# opencode-voice2text

[English README](./README.md)

这是一个用于 OpenCode TUI 的流式语音输入插件，采用基于 provider 的语音识别架构。目前内置的 provider 是火山引擎 ASR。

按一次快捷键开始识别，正常说话时音频会持续流式发送到火山引擎；再按一次快捷键停止识别。识别出的稳定文本会在你还在说话时持续追加到当前 OpenCode 输入框中。

## 演示

![demo](https://p9-xtjj-sign.byteimg.com/tos-cn-i-73owjymdk6/4179b924c4ab486f95a8f3c41c688e17~tplv-73owjymdk6-jj-mark-v1:0:0:0:0:5o6Y6YeR5oqA5pyv56S-5Yy6IEAgY2hlbnh1YW41MjA=:q75.awebp?rk3s=f64ab15b&x-expires=1776524057&x-signature=RGZz94OR%2F8wskiW2KswN9vLCtT4%3D)

## 特性

- 单个快捷键控制开始 / 停止流式识别
- 在会话结束前，稳定识别结果就会提前追加到输入框
- 配置错误或运行失败时会显示 warning/error toast
- 支持 macOS 和 Linux
- 凭证放在插件仓库之外，避免误提交

## 行为说明

- 第一次按 `Ctrl+S`：开始采集麦克风音频并启动流式识别
- 说话过程中：稳定识别文本会持续追加到当前 prompt
- 第二次按 `Ctrl+S`：停止采集，等待 ASR 最终结果，并补上剩余尾部文本
- 录音期间会显示一个持续存在的 recording toast，识别停止后自动消失

## 为什么是切换式而不是按住说话

OpenCode 当前的 TUI 插件 API 支持匹配快捷键，但还没有暴露按键释放事件。所以在插件里实现真正可靠的“按住录音 / 松开停止”目前不可行。

## 依赖要求

- OpenCode，并且启用了 TUI plugin 支持
- 你所选 ASR provider 的可用凭证
- 本地安装 Sox（macOS/Linux 使用 `rec`，Windows 使用 `sox.exe`）

macOS：

```bash
brew install sox
```

Ubuntu / Debian：

```bash
sudo apt install sox
```

Windows：

1. 从 <https://sourceforge.net/projects/sox/> 下载并安装 SoX
2. 确保 `sox.exe` 已加入 `PATH`
3. 用下面命令确认安装成功：

```powershell
sox --version
```

## 安装

推荐全局安装：

```bash
opencode plugin opencode-voice2text@latest --global
```

这和 `opencode-dynamic-context-pruning` 的安装方式一致。OpenCode CLI 会自动安装 npm 包，并更新你的 OpenCode 插件配置。

如果只想安装到当前项目而不是全局，去掉 `--global`：

```bash
opencode plugin opencode-voice2text@latest
```

## TUI 配置

安装器会默认写入一条 TUI 插件配置，其中包含：

- `commandKeybind: "ctrl+s"`

你仍然需要确认 `terminal_suspend` 不会和这个快捷键冲突。

推荐的 `~/.config/opencode/tui.json`：

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "keybinds": {
    "terminal_suspend": "none"
  }
}
```

如果你想改成别的快捷键，可以在安装后手动编辑 `tui.json` 里生成的插件配置。

默认快捷键是 `Ctrl+S`。如果按了没有反应，通常是终端在 OpenCode 收到按键前，就把它当成了 XON/XOFF 流控快捷键。

当前 shell 会话内临时修复：

```bash
stty -ixon
```

zsh 持久化修复：

把 `stty -ixon` 加到 `~/.zshrc`，然后重启终端。

bash 持久化修复：

把 `stty -ixon` 加到 `~/.bashrc` 或 `~/.bash_profile`，然后重启终端。

如果你不想改终端流控，也可以在 `tui.json` 里手动把 `commandKeybind` 改成别的键。

Windows 终端没有同样的 `Ctrl+S` XON/XOFF 流控问题，所以 `stty -ixon` 只适用于 macOS/Linux shell。

## 重启 OpenCode

如果 OpenCode 已经在运行，安装完后请重启一次，确保插件和依赖树被重新加载。

## 凭证配置

在目标机器上创建本地配置文件：

macOS/Linux：

`~/.config/opencode/voice2text.local.json`

Windows：

`%APPDATA%\opencode\voice2text.local.json`

```json
{
  "provider": "volcengine",
  "providerConfig": {
    "appId": "your-volcengine-app-id",
    "accessToken": "your-volcengine-access-token",
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

示例模板也放在 `examples/voice2text.local.example.json`。

## 火山引擎配置

当前内置的 `volcengine` provider 需要你先在火山引擎准备好以下配置，插件才能正常工作：

- 火山引擎 ASR 产品页：<https://www.volcengine.com/product/asr>
- `providerConfig.appId`
- `providerConfig.accessToken`
- `providerConfig.resourceId`
- `providerConfig.endpoint`

典型配置流程：

1.  打开 [官网](https://www.volcengine.com/product/asr) 登录火山引擎控制台, 如果没登录注册先注册登录账号, 打开语音识别 / ASR 服务页面
![image.png](https://img.011203.dpdns.org/file/1775972577499_image.png)

2.  创建或选择一个应用
![image.png](https://img.011203.dpdns.org/file/1775972583608_image.png)

3.  获取应用对应的凭据和资源配置
![image.png](https://img.011203.dpdns.org/file/1775972594458_image.png)

4.  填进本地 `voice2text.local.json`。macOS/Linux 默认路径是 `~/.config/opencode/voice2text.local.json`，Windows 默认路径是 `%APPDATA%\opencode\voice2text.local.json`。其中 Resource-Id 在 [大模型流式语音识别API--豆包语音-火山引擎](https://www.volcengine.com/docs/6561/1354869?lang=zh) 这里找，推荐直接填 `volc.seedasr.sauc.duration`，endpoint 则使用 `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async`
![image.png](https://img.011203.dpdns.org/file/1775972606968_image.png)

对当前这个插件的火山引擎实现来说：

- `providerConfig.endpoint` 一般是 `wss://openspeech.bytedance.com/api/v3/sauc/...` 下面的 websocket 地址
- `providerConfig.resourceId` 需要和你在火山引擎启用的模型 / 资源一致
- `providerConfig.appId` 和 `providerConfig.accessToken` 必须属于同一个火山引擎应用

示例：

```json
{
  "provider": "volcengine",
  "providerConfig": {
    "appId": "your-app-id",
    "accessToken": "your-access-token",
    "resourceId": "volc.seedasr.sauc.duration",
    "endpoint": "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async"
  }
}
```

如果在没有有效火山引擎凭证的情况下触发插件，它会显示 warning toast，而不是静默失败。

你也可以用下面这个环境变量覆盖配置文件路径：

```bash
export OPENCODE_VOICE2TEXT_LOCAL_CONFIG=/path/to/voice2text.local.json
```

## 环境变量

下面这些环境变量可以覆盖，或者直接替代本地配置文件中的值：

```bash
export OPENCODE_VOICE2TEXT_PROVIDER=volcengine
export OPENCODE_VOICE2TEXT_LANGUAGE=zh-CN
export OPENCODE_VOICE2TEXT_CHUNK_MS=200
export OPENCODE_VOICE2TEXT_END_WINDOW_SIZE=800
export OPENCODE_VOICE2TEXT_MAX_DURATION_SECONDS=180
export OPENCODE_VOICE2TEXT_APPEND_TRAILING_SPACE=true
export OPENCODE_VOICE2TEXT_SAMPLE_RATE=16000
export OPENCODE_VOICE2TEXT_BITS=16
export OPENCODE_VOICE2TEXT_CHANNELS=1
```

当前内置的火山引擎 provider 也兼容旧版扁平环境变量：

```bash
export OPENCODE_VOICE2TEXT_APP_ID=...
export OPENCODE_VOICE2TEXT_ACCESS_TOKEN=...
export OPENCODE_VOICE2TEXT_RESOURCE_ID=volc.seedasr.sauc.duration
export OPENCODE_VOICE2TEXT_ENDPOINT=wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async
```

## 插件选项

你也可以通过 `tui.json` 传入同样的运行时配置：

- `commandKeybind`
- `provider`
- `providerConfig`
- `language`
- `chunkMs`
- `endWindowSize`
- `maxDurationSeconds`
- `appendTrailingSpace`
- `rate`
- `bits`
- `channels`

实际使用里，凭证更适合放在本地配置文件或环境变量里，而不是直接写进 `tui.json`。

## Provider 设计

当前配置结构是面向 provider 的，这样后续新增 ASR 后端时不需要改安装入口形态。

- 当前 provider：`volcengine`
- 未来 provider 可以复用同一套插件入口和 TUI 行为
- provider 专属密钥统一放到 `providerConfig` 下

如果你要在代码里新增一个 provider：

1. 在 `src/providers/` 下新增一个文件。
2. 实现 `src/providers/types.ts` 里的 `VoiceProvider` 接口。
3. 在 `src/providers/index.ts` 中注册它。
4. 在本地配置里使用 `provider` + `providerConfig`。

如果缺少 provider 配置，按下快捷键后会显示一个 toast，提示你去填写对应的本地配置文件，而不是静默失败。

## 开发

安装依赖并构建：

```bash
npm install
npm run build
```

只做类型检查：

```bash
npm run typecheck
```

## 发布

### 通过 GitHub Actions 自动发布

仓库已经包含 `.github/workflows/publish.yml`。

它使用 GitHub Actions OIDC + npm trusted publishing，所以不需要在 GitHub 里保存长期有效的 `NPM_TOKEN`。

行为如下：

- 每次 push 到 `master` 都会执行 typecheck 和 build
- workflow 会检查 `package.json` 当前的 `name@version` 是否已经发布到 npm
- 如果该版本还不存在，就执行 `npm publish`
- 如果该版本已经存在，workflow 会正常结束而不是失败

npm 侧需要做的配置：

- 在 npm 包设置里把当前仓库配置成 trusted publisher

在 npmjs.com 打开 `opencode-voice2text` 这个包的设置页，然后配置：

- Trusted Publisher
- provider: GitHub Actions
- owner: `chenxuan520`
- repository: `opencode-voice2text`
- workflow filename: `publish.yml`

重要发布规则：

- 如果你希望 push 到 `master` 后发布新版本，先更新 `package.json` 里的版本号
- 如果代码变了但版本号没变，CI 会跳过发布，因为 npm 版本号不可重复

版本升级示例：

```bash
npm version patch
```

或者：

```bash
npm version minor
```

### 手动发布

```bash
npm publish
```

`prepublishOnly` 会自动先执行构建。

如果是紧急情况下手动发布，可以在本地使用自己的 npm 登录态，或者使用短期有效的 bypass-2FA token。不要在启用了 trusted publishing 的 GitHub Actions 中保存长期 publish token。

## 备注

- 内置的火山引擎 provider 直接对接火山引擎 websocket ASR 协议
- 故意不显示 success toast；录音状态通过持续存在的 toast 表达，停止后会自动消失
- 错误仍然会通过 OpenCode toast 暴露出来
- `opencode plugin ...` 会更新 `tui.json` 中的插件配置，但不会覆盖 `theme`、`keybinds` 之类无关的 TUI 设置
