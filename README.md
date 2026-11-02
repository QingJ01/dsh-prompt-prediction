# DSH Prompt Prediction

Predict your next message after an agent reply, display it as ghost text in the empty composer, and press **Tab** or **→** to turn it into an editable draft.

为 DeepSeek Harness 提供下一句提示词预测：一轮结束后，空输入框显示灰字建议，按 **Tab / →** 填入草稿，**不会自动发送**。

An unofficial DSH plugin inspired by Codex's next-prompt prediction interaction. No build step and no production dependencies beyond the DSH host.

[中文说明](#中文说明) · [English](#english-documentation)

## 效果预览 / Preview

![DSH 提示词预测：空输入框显示灰字，按 Tab 填入草稿](docs/images/preview.png)

*基于插件实际前端渲染的交互演示，图中建议为示例文本。 / Rendered with the plugin frontend and an example suggestion.*

## 中文说明

这是一个非官方的 DeepSeek Harness 插件，参考 Codex 的下一句预测交互：**Agent 一轮回复结束后，预测你接下来可能输入的话，并以灰字显示在空输入框里。**

### 安装

已在 DSH `0.2.1-rc.5` 上验证；开发和运行测试需要 Node.js 24 或更高版本。

```sh
git clone https://github.com/QingJ01/dsh-prompt-prediction.git
cd dsh-prompt-prediction
dsh plugin --profile desktop add "link:$(pwd)"
```

如果你使用其他 profile，将 `desktop` 替换为对应名称。安装后刷新 DSH 窗口加载前端；如果 Host 插件没有自动加载，可重启 DSH。使用 link 安装时请保留此目录的位置。

### 怎么用

1. 在会话中正常提问，等待 Agent 完成一轮回复。
2. 输入框完全为空时，会显示一条灰字建议；输入框有草稿、附件、引用或排队消息时不会显示。
3. 聚焦输入框，按 **Tab** 或 **→**，将建议填入可编辑草稿；你可以继续修改，再自行发送。

**插件不会自动发送消息。** 输入文字、中文输入法组字、打开菜单、会话运行中或处于 Plan 模式时，灰字会隐藏。采纳操作支持撤销、重做。

与 Codex 的适配差异：**Enter 保留 DSH 原有的发送、排队和命令处理逻辑，不用于采纳灰字**；长建议单行省略显示，但采纳时会插入完整内容。

### 模型、费用与配置

默认沿用当前会话的模型和历史，额外发起一次预测请求，不会把预测写进 Agent 的会话历史。同一路由有机会复用提供商的前缀缓存，但**预测仍可能产生模型费用**，冷缓存或长会话的成本取决于你的提供商。也可以同时设置 `provider` 和 `model`，改用独立的预测模型及精简历史。

在 profile 的 `cordis.patch.yml` 中覆盖配置，例如：

```yaml
- id: prompt-prediction
  config:
    enabled: true
    maxSuggestionChars: 160
    timeoutMs: 15000
    auditLog: false
```

- `enabled: false`：关闭预测。
- `maxSuggestionChars`：控制建议的最大长度。
- `auditLog: false`：关闭本地审计日志。默认开启时，日志会记录预测、采纳和提交文本等信息。

完整参数见下方 [Configuration](#configuration)。移除插件：

```sh
dsh plugin --profile desktop remove dsh-prompt-prediction
```

## English documentation

## Requirements

- DeepSeek Harness `0.2.1-rc.5` or a compatible `0.2.x` release. Tested against `0.2.1-rc.5`.
- Node.js 24 or newer for development and tests.
- A working model route in your DSH session.

## Install

Clone this repository and link it into your DSH profile:

```sh
git clone https://github.com/QingJ01/dsh-prompt-prediction.git
cd dsh-prompt-prediction
dsh plugin --profile desktop add "link:$(pwd)"
```

Replace `desktop` with your profile name if needed. Keep the checkout at the same location while using a linked installation. Refresh existing GUI windows to load the client plugin; restart DSH if the host plugin does not load automatically.

To remove:

```sh
dsh plugin --profile desktop remove dsh-prompt-prediction
```

## Interaction

- A normally completed agent turn triggers one prediction. Failed, interrupted and aborted turns do not.
- Suggestions appear only in a completely empty composer, without attachments, reference chips or queued messages.
- **Tab / →** fills the focused composer as an undoable draft edit. Review or edit it before sending.
- **Enter** remains owned by DSH's normal submission, queue and command handling. It does not accept a prediction.
- Typing, IME composition, menus, disabled input, running sessions and Plan mode hide the suggestion.
- A long suggestion uses a single-line preview with an ellipsis; acceptance inserts the full suggestion.
- Deleting back to an empty draft can show the same prediction again. A new user message or turn invalidates the old prediction.

This follows the core Codex interaction, with deliberate DSH adaptations: Enter behavior is preserved, and the preview is a DOM overlay rather than an editor decoration.

## Configuration

The bundle adds a `prompt-prediction` row with working defaults. Override it in your profile's `cordis.patch.yml`:

```yaml
- id: prompt-prediction
  config:
    enabled: true
    maxSuggestionChars: 160
    timeoutMs: 15000
    auditLog: false
```

| Key | Default | Purpose |
| --- | --- | --- |
| `enabled` | `true` | Enable or disable the plugin. |
| `provider`, `model` | unset | Leave both unset to reuse the session route. Set both to use a separate prediction route with compact history. |
| `maxOutputTokens` | `1024` | Prediction output budget, including reasoning where applicable. |
| `timeoutMs` | `20000` | Deadline; late results are discarded. |
| `maxSuggestionChars` | `200` | Maximum suggestion length. |
| `compactTurns` | `8` | User turns retained when using a separate route. |
| `maxHistoryChars` | `0` | Ordinary-text history guard; `0` disables it. This does not measure the full serialized request size. |
| `eagerWindowMs` | `1800000` | Time after the last browser interaction during which a session may generate background predictions. |
| `auditLog` | `true` | Write prediction and interaction records to the local audit log. |

A separate route can be configured with your own provider and model identifiers:

```yaml
- id: prompt-prediction
  config:
    provider: your-provider
    model: your-model
    compactTurns: 8
```

## Model use and local data

Each eligible turn makes an auxiliary model request. By default it uses the session's route, history and tool declarations so the provider can reuse its cached prefix. Cache behavior and cost depend on the provider; a cold, long conversation can be expensive. An alternate route uses a compact text history instead.

The request asks for `{"suggestion": "..."}` or `{"suggestion": null}`. Predictions are held in memory and are not appended to the agent's session history. Tool calls from a prediction are discarded rather than executed.

With `auditLog: true`, local records are written to `$DSH_HOME/prompt-prediction/events.jsonl` (or `~/.dsh/prompt-prediction/events.jsonl`). Records can include suggestion text, accepted/submitted text, timing, usage and interaction diagnostics. The log rotates at approximately 4 MiB, checked every 100 writes, keeping one previous file. Set `auditLog: false` to disable it.

The browser bridge uses DSH's authenticated owner `connection.fetch` registry. Anonymous requests are rejected. No external analytics service is configured by this plugin; model requests still go to the configured model provider.

## Architecture

- `lib/index.js`: host lifecycle, auxiliary model calls, authenticated Fetch routes and local feedback.
- `lib/client.js`: composer overlay, measurement, placeholder ownership and keyboard acceptance. It loads React from DSH's module table.
- `lib/prediction.js`: configuration, history handling, prediction instruction and response parsing.
- `cordis.patch.yml`: bundle configuration.

The plugin observes session events and invalidates stale results on new messages or turns. Cancellation, deadlines, revision guards and response budgets prevent stale results from overwriting a draft or accumulating without bounds inside the plugin. A provider that ignores cancellation may still retain its own underlying request.

## Tests

The standard suite runs without installing dependencies:

```sh
npm test
```

There are 87 tests in the reviewed environment. Four transport integration tests load functions from an extracted, locally installed DSH runtime. Without that runtime, those four tests explicitly skip. Set `DSH_EXTRACTED_ROOT` to a directory containing package folders such as `dsh-client-connection` and `dsh-llm`:

```sh
DSH_EXTRACTED_ROOT=/path/to/extracted-dsh npm test
```

The integration tests exercise the actual HTTP bridge, owner Fetch registry and assistant-message provenance boundary. Test auditing is disabled, so the tests do not append fabricated interactions to your DSH audit log.

### Browser regression checks

Requires Node.js 24 and Google Chrome at its standard macOS application path. Download React's test runtimes first:

```sh
mkdir -p /tmp/pp-review-browser
curl -fLsS https://unpkg.com/react@18.3.1/umd/react.development.js -o /tmp/pp-review-browser/react.js
curl -fLsS https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js -o /tmp/pp-review-browser/react-dom.js
node test/browser-review.mjs
```

This starts an isolated headless browser and a temporary fixture server. It checks actual rendering, placeholder restoration, hint alignment, narrow layouts, menus, composition, busy/Plan states and session switching. Screenshots are written under `artifacts/review/`.

For the stronger HTTP-to-Lexical check:

```sh
DSH_EXTRACTED_ROOT=/path/to/extracted-dsh node test/browser-review.mjs --integrated
```

This loads the installed DSH's real HTTP bridge, model provenance boundary, Lexical editor, input shell and keymap. It checks Tab/ArrowRight insertion, no automatic send, undo/redo, stale-revision refusal and preserving Enter behavior. Model output and owner identity are deterministic fixtures; unrelated business services use test substitutes. It does not send messages from an existing DSH conversation. DSH source code and extracted application assets are not distributed in this repository.

## Compatibility limits

- Some integration points are specific to DSH `0.2.1-rc.5`; later releases can change them.
- Plan and queue suppression are client-side. Recently watched sessions can still incur background prediction cost within `eagerWindowMs`.
- The overlay cannot render file-reference chips inside suggestions.
- Catch-up uses the session event snapshot; negative results are cached to avoid scanning on every poll.
- Full Desktop IPC and every external model provider have not been validated end to end.
- Browser fixtures and integration tests do not replace checking the result in your own DSH window.

## License

[MIT](LICENSE).
