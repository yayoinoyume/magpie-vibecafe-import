# magpie-vibecafe-import

把 magpie 记录的用量数据导入 [vibecafe.ai](https://vibecafe.ai)（也就是 [vibe-usage](https://github.com/vibe-cafe/vibe-usage) 使用的服务）。

**默认一个字节都不上传。** 想导哪个工具，自己去配置里打开。

## 为什么默认全关

有两个坑，插件没法替用户决定：

**坑一：重复计数。** vibe-usage 自己会读 `~/.claude`、`~/.codex` 等目录的原始日志。magpie 记录的是「经过它网关的调用」。同一批 Claude 调用，两边都能读到。同时开启 → 面板数字翻倍。

**坑二：source 白名单。** vibecafe 服务端只接受它注册过的 source 名（目前 34 个）。用未注册的名字上传，服务端返回 200 但**静默丢弃**，面板上看不到任何东西。

所以插件把选择权交给用户，并且把后果写在配置项的备注里。

## 安装

```sh
magpie plugin add github:<你的用户名>/magpie-vibecafe-import
```

插件装好后，在 magpie 的 **Plugins → Vibecafe Import → Sign in** 里填入 API key。
密钥创建地址：<https://vibecafe.ai/usage/setup>（形如 `vbu_...`）。

**登录不会立刻上传任何数据。** 还需要在配置里打开具体的工具。

## 配置

编辑 magpie 的 `plugins.json`，找到本插件那一项，在 `options.sources` 里打开想导的工具：

```json
{
  "plugins": [
    {
      "spec": "github:yourname/magpie-vibecafe-import",
      "options": {
        "sources": {
          "claude": true,
          "codex": true
        }
      }
    }
  ]
}
```

改完需要关闭再打开插件才会生效。

支持的写法有两种，等价：

```jsonc
{ "claude": true }                    // 简写
{ "claude": { "enabled": true } }     // 完整写法
```

### 所有配置项

| 选项 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `sources` | — | 全部关闭 | 每个 agent 单独开关，见下方对照表 |
| `includeOthers` | `VIBECAFE_INCLUDE_OTHERS` | `false` | 是否把其他机器同步来的用量也算进来 |
| `autoUpload` | `VIBECAFE_AUTO_UPLOAD` | `true` | 关闭后只保留手动 CLI 上传 |
| `startDate` | `VIBECAFE_START_DATE` | 无 | 忽略该日期（`YYYY-MM-DD`，UTC）之前的历史 |
| `apiUrl` | `VIBECAFE_API_URL` | `https://vibecafe.ai` | 自建服务时改这里 |
| `magpieDir` | `MAGPIE_DIR` | `~/.config/magpie` | magpie 配置目录 |
| — | `VIBECAFE_API_KEY` | — | 覆盖已保存的密钥 |

**不要把密钥写进 `options`。** 插件会直接报错拒绝。

## 哪些工具能导

运行这条命令看完整列表：

```sh
npx magpie-vibecafe-import sources
```

三类：

### 能导，但会与 vibe-usage 重复

vibe-usage 自己会读这些工具的日志。开启前先确认你没在同时用 vibe-usage 的本地扫描。

`claude`（Claude Code）、`claude-desktop`、`claude-science`、`codex`、`gemini`、`opencode`、`openchamber`、`pi`、`pi-desktop`、`kimi`、`qwen`、`minimax`、`mimocode`、`droid`、`cline`、`qoder`、`qoder-cn`、`grok`、`grok-app`、`zcode`、`hermes`、`devin`、`workbuddy`、`codebuddy`、`copilot`、`cursor`、`cursor-local`、`dsh`、`omp`、`kiro`、`cindy`、`alma`、`trae`、`antigravity`、`agy`、`amp`

### 能导，vibe-usage 不读（推荐开启）

`crush`

### 暂时导不进去

vibecafe 服务端还没注册这些 source。开启不会报错，但数据会被丢弃：

`zed`、`vscode`、`vscode-insiders`、`vscodium`、`copilot-jetbrains`、`goose`、`raycast`、`t3code`、`lody`、`air`、`aside`、`morph`、`muse`、`hanako`、`snow`、`atomcode`、`pencil`、`openpencil`、`stepcode`、`mothx`、`omo`、`prime-agent`、`empryo`、`ante`、`astrbot`、`jcode`、`reasonix`、`commandcode`、`fx`、`magpie`、`curl`

插件每次启动都会在日志里提醒这件事，不会让你白等。

## 多机场景

如果你在多台机器上用 magpie，并且开了 magpie 的 WebDAV / S3 同步，那么：

- 每台机器把自己的用量写进 `~/.config/magpie/usage.jsonl`
- 其他机器的数据会同步到 `~/.config/magpie/usage-others/<机器id>/<日期>.json`

打开 `includeOthers: true` 后，插件会把这些数据一起导入，每台机器按自己的主机名分开统计。

**这种情况下不要在那些机器上也装本插件**，否则会重复上报。

### 只想让中心 magpie 上报

这正是推荐用法：

1. 只在中心那台机器上装本插件
2. 打开 `includeOthers: true`
3. 把想导的工具全部打开（包括会与 vibe-usage 重复的那些——因为其他机器上没有 vibe-usage）

## 上报时机

每 30 分钟增量上传一次，启动后延迟 1 分钟执行第一次。与 vibe-usage 守护进程的节奏一致。

增量逻辑：

| 情况 | 行为 |
|---|---|
| 新增的桶 | 上传 |
| 值变大（同一半小时又累积了调用） | 上传，服务端覆盖旧值 |
| 值没变 | 跳过 |
| 值变小（本地日志被截断） | 跳过，服务端会保留旧值 |

## 命令行工具

插件之外也可以单独用，适合预览和排查：

```sh
# 看有哪些工具、各自映射到什么 source
npx magpie-vibecafe-import sources

# 看当前配置和登录状态
npx magpie-vibecafe-import status

# 预览，不联网
npx magpie-vibecafe-import preview --enable claude,codex

# 只看某一天
npx magpie-vibecafe-import preview --enable claude --date 2026-10-16

# 立即上传
npx magpie-vibecafe-import submit --enable claude,codex

# 确认密钥绑对了账号
npx magpie-vibecafe-import account
```

`--enable` 只影响当次运行，不写配置文件。

## 隐私

- 只上传 token 数量、模型名、时间戳。**不上传**提示词、回复内容、请求头、文件路径。
- `project` 字段固定为 `unknown` —— magpie 的日志里没有项目路径。
- 密钥存在 magpie 自己的 `plugin-auth.json`（权限 600），插件不另存一份。
- 上传状态存在 `~/.config/magpie/vibecafe-import/state.json`（权限 600），只记桶的哈希和 token 总数。

## 已知限制

1. **没有项目维度。** magpie 不记录调用来自哪个项目目录，所有数据都归到 `unknown`。vibe-usage 直读日志时有项目名，所以同一个工具两边导入后，项目维度的统计不会合并。
2. **当前 UTC 日的用量不上传。** 只导入已完成的日期，避免当天数据反复变动。
3. **服务端丢弃 source 时无法补传。** 等 vibe-cafe 上游注册对应 source 后，重新运行 `submit` 即可补上——被丢弃的桶不会记账。
4. **`out` 字段包含 reasoning。** 插件会减掉，但如果 magpie 未来改了语义，会导致少算。这一点有测试覆盖。

## 开发

```sh
node --test "test/*.test.mjs"
```

需要 Node.js 20 或更高版本。无第三方依赖。

## 许可

MIT
