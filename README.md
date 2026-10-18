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
| `hostname` | `VIBECAFE_HOSTNAME` | 系统主机名 | 上报时用的机器名，见下方「机器名」一节 |
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

## 机器名

vibecafe 按 `hostname` 区分机器。**一个 API key 下可以有多个机器名**，面板会分别统计。

### 默认：用系统主机名

插件不配置 `hostname` 时，用 `os.hostname()`。每台机器天然不同，所以：

- 多台机器都装插件 → 各传各的，面板上分开显示 ✅
- 不会因为名字冲突互相覆盖 ✅

### 可选：全部归到一台

如果你只想看总用量，不关心哪台机器贡献的：

```json
{ "hostname": "central-magpie" }
```

所有数据（本机 + 跨机）都归到这一个名字下，面板上只显示一台机器。

**代价**：丢失「哪台机器用了多少」这个维度。

### 多台都装插件时会发生什么

| 配置 | 结果 |
|---|---|
| 都装，都不开 `includeOthers` | ✅ 各传各的，正确 |
| 都装，都开 `includeOthers` | ⚠️ 重复上传（插件会警告） |
| 只有一台装，开 `includeOthers` | ✅ 中心机器收齐所有 |

**都装又都开跨机**时，A 会把 B 的数据传一遍，B 也把 A 的传一遍。插件启动时会检测到这种情况并警告。

如果同时配置了固定 `hostname`，两份数据会落在同一个去重键下，服务端保留较大的值——**看起来没重复，实际会丢数据**。插件也会针对这一点警告。

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
4. **模型名不在价格表里会被静默丢弃。** 实测确认：服务端返回 `200` 且 `ingested` 计数正常，但数据不落库。插件会检测这种情况（发送量与 `ingested` 对不上且无 `dropped` 解释），告警并跳过记账，下次自动重试。但如果服务端始终不收录该模型，这些数据会一直重试、一直不成功。
5. **`out` 字段包含 reasoning。** 插件会减掉，但如果 magpie 未来改了语义，会导致少算。这一点有测试覆盖。

## 开发

```sh
npm test          # 等价于 node --test
```

需要 Node.js 20 或更高版本。无第三方依赖。

> 注意：`node --test test/`（目录参数）在 Node 24 上会报 MODULE_NOT_FOUND，
> 用 `node --test` 或 `node --test "test/*.test.mjs"`。

### 对真实服务端自检

```sh
VIBECAFE_API_KEY=vbu_xxx npm run selftest
```

这个脚本会真的往服务端写一次数据，但**保证清理干净**：

1. 用一个随机后缀的 `vibecafe-selftest-xxxxxxxx` 作为 hostname，并**先断言它不存在于你的账号数据里**
2. 只上传 1 个桶、2 个 token，模型名用真实存在的
3. 确认数据落库、12 个字段全部返回
4. `finally` 里按 hostname 精确删除（`DELETE /api/usage/ingest?hostname=`）
5. 再查一次，确认沙箱数据为 0，并打印真实数据桶数供比对

不会碰你的真实用量。加 `--keep` 可以保留数据人工检查，脚本会打印手动删除命令。

**为什么模型名必须真实**：实测发现，模型名不在 vibecafe 价格表里时，服务端返回 `200`、`ingested` 计数正常，但数据**不落库**。插件因此加了「静默丢弃」检测——发送量与 `ingested` 对不上且没有 `dropped` 解释时，会告警并**不记账**，下次自动重试。

## 许可

MIT
