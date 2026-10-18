# 真机验证清单

插件已经通过 70 个单元测试，并对真实 vibecafe 服务端做过单桶联调。
**唯一没验证的是：装进真实 magpie 后能不能跑起来。**

这份清单带你走一遍。全程不碰你的真实历史数据。

---

## 前置条件

- 一台装了 magpie 的机器
- 一个 vibecafe API key（[创建地址](https://vibecafe.ai/usage/setup)，形如 `vbu_...`）
- 终端能跑 `magpie` 命令

确认 magpie 可用：

```sh
magpie --version
```

---

## 步骤 1：确认 magpie 的用量文件存在

```sh
ls -lh ~/.config/magpie/usage.jsonl
```

- **有输出** → 继续
- **没有这个文件** → magpie 还没产生过调用，先用它跑一次 AI 请求

看一眼内容格式，确认字段对得上：

```sh
head -1 ~/.config/magpie/usage.jsonl | python3 -m json.tool
```

应该能看到这几个字段：`t`、`agent`、`provider`、`model`、`in`、`out`。

---

## 步骤 2：先用 CLI 验证，不装插件

这一步**不写任何数据到服务端**，只是确认插件能正确读你的日志。

```sh
cd /path/to/magpie-vibecafe-import

VIBECAFE_API_KEY=vbu_你的key \
  node cli.mjs preview --magpie-dir ~/.config/magpie --enable claude --date 昨天日期
```

把 `claude` 换成你实际用的工具，`昨天日期` 换成 `2026-10-17` 这样的格式。

**预期输出**：

```
共 N 个桶：

  时间(UTC)          source        model                  tokens
  2026-10-16 10:00  claude-code    claude-sonnet-5        12345
  ...

诊断：
  读取记录              120
  未开启的工具            45
```

### 如果输出「没有可上传的桶」

按顺序排查：

| 检查 | 命令 |
|---|---|
| agent 名字对不对 | `node cli.mjs sources` 看有哪些可用 |
| 日期对不对 | 日志里可能是更早的日期 |
| 记录是否被过滤 | 看诊断里的「读取记录」是否为 0 |

---

## 步骤 3：确认要用的工具名

```sh
node cli.mjs sources
```

输出分三组：

```
可导入，但 vibe-usage 自己也会读（同时开启会重复计数）：
  claude       → claude-code
  codex        → codex
  ...

可导入，vibe-usage 不读（推荐开启）：
  crush        → crush

vibe-usage 未注册 source（开启也导不进去）：
  zed, vscode, goose, ...
```

**只从第一组和第二组里选。** 第三组的开了也没用。

---

## 步骤 4：装插件

```sh
magpie plugin add github:yayoinoyume/magpie-vibecafe-import
```

确认装上了：

```sh
magpie plugin list
```

应该看到 `magpie-vibecafe-import`。

---

## 步骤 5：登录

```sh
magpie plugin login vibecafe-import
```

按提示输入 `vbu_...` 密钥。

> **注意**：密钥存在 magpie 自己的 `plugin-auth.json`（权限 600），插件不另存。

### 如果提示 `no plugin signs in to "vibecafe-import"`

说明 magpie 还没执行过插件的 `config` hook，provider 没注册。

先让插件跑一次：

```sh
magpie plugin list
```

再试登录。仍然失败的话，直接在 magpie 界面里操作：
**Plugins → Vibecafe Import → Sign in**。

### 备用方案：环境变量

不想登录，也可以在启动 magpie 时带上环境变量：

```sh
export VIBECAFE_API_KEY=vbu_你的key
```

环境变量优先级高于已保存的密钥。

---

## 步骤 6：在界面里开启工具

**关键一步。默认一个都不开。**

打开 magpie 侧边栏的 **Vibecafe 导入** 页面。

页面长这样：

```
Vibecafe Import
已开启 0 个工具。

会与 vibe-usage 重复 0/36
  vibe-usage 自己会读这些工具的日志。同时开启会让面板数字翻倍。
  ☐ Antigravity CLI   antigravity
  ☐ Claude Code       claude-code
  ☐ Codex             codex
  ...

可安全开启 0/1
  ☐ Crush             crush

暂时导不进去 0/31
  vibecafe 服务端还没注册这些 source，开启后数据会被静默丢弃。
  ☐ JetBrains Air     —
  ☐ Zed               —
  ...

☐ 包含其他机器的数据

[保存]
```

勾选你想要的工具，点 **保存**。

顶部的摘要会实时变化，告诉你开了几个、其中几个会重复。

### 如果页面打不开

用命令行代替：

```sh
magpie plugin options magpie-vibecafe-import '{"sources":{"claude":true}}'
```

确认配置生效：

```sh
magpie plugin options magpie-vibecafe-import
```

---

## 步骤 7：观察第一次上传

插件每 30 分钟跑一次，启动后延迟 1 分钟。

**等约 1-2 分钟**，然后看日志：

```sh
magpie plugin list --json | python3 -m json.tool
```

或者直接看 magpie 的界面日志。

### 预期日志

第一次会看到类似：

```json
{"status":"complete","submitted":120,"unchanged":0,"regressed":0,...}
```

### 可能的告警及含义

| 告警 | 含义 | 该怎么做 |
|---|---|---|
| `N 个桶被服务端丢弃（未注册的 source：xxx）` | 你开了没有 source 的工具 | 关掉它，或等上游注册 |
| `N 个桶上传成功但未落库` | 模型名不在 vibecafe 价格表里 | 正常，会自动重试；数据暂时进不去 |
| `检测到上传账号已更换` | 换了密钥 | 正常，会全量重传 |
| `服务端保留了 N 个更大的已有桶` | 同一份数据被 vibe-usage 也传过 | **说明重复了，去看是否该关掉某些工具** |

---

## 步骤 8：去面板确认

打开 <https://vibecafe.ai/usage>。

检查：

1. 有没有新增的数据
2. token 数和你 CLI `preview` 看到的是否接近
3. `unknown` 项目下是否出现了你的数据（这是正常的，magpie 不记项目路径）

---

## 步骤 9：验证增量和去重

**再等 30 分钟**，看第二次运行的日志。

如果期间没有新的 AI 调用，应该看到：

```json
{"status":"unchanged","submitted":0,"unchanged":120}
```

这说明增量逻辑生效了——没变化就不重复上传。

---

## 出问题时怎么排查

### 插件根本没跑

```sh
magpie plugin list --json
```

看 `off` 字段是不是 `true`。

### 跑了但一条数据都没传

按顺序检查：

```sh
# 1. 有没有开工具
magpie plugin options magpie-vibecafe-import

# 2. 有没有登录
ls -l ~/.config/magpie/plugin-auth.json

# 3. 日志文件在哪
ls -lh ~/.config/magpie/vibecafe-import/state.json
```

`state.json` 存在说明至少跑过一次。看里面 `buckets` 有多少条。

### 数据传了但面板看不到

最可能的原因：**模型名不在价格表里**。

用 CLI 直接查服务端：

```sh
VIBECAFE_API_KEY=vbu_你的key node cli.mjs account
```

然后跑一次自检，确认服务端行为正常：

```sh
VIBECAFE_API_KEY=vbu_你的key npm run selftest
```

这个脚本会自动清理，不会污染数据。

### 想清空重来

```sh
rm -rf ~/.config/magpie/vibecafe-import
```

下次运行会全量重传。**注意**：这只清本地状态，服务端的旧数据还在。

---

## 安全提醒

- 密钥只通过 `magpie plugin login` 或环境变量传入，**不要写进 `options`**
- 插件上传的只有 token 数、模型名、时间戳，**不含提示词和回复内容**
- 想暂停上传：`magpie plugin options magpie-vibecafe-import '{"autoUpload":false}'`

---

## 验证完成后

如果一切正常，把实际观察到的结果记下来：

- [ ] CLI `preview` 能读出数据
- [ ] 插件安装成功
- [ ] 登录成功
- [ ] 开启工具后 1-2 分钟内有上传日志
- [ ] 面板上能看到数据
- [ ] 第二次运行显示 `unchanged`

有任何一步不符合预期，把日志贴出来。
