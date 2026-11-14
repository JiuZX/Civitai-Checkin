# Civitai-Checkin

Node 单次运行脚本，固定执行三项 Civitai Blue Buzz 任务。

## 任务

| Task | Reward (Blue Buzz) |
| --- | ---: | 
| For claiming daily boost rewards | 25  |
| For encouraging others to post content | 2 × 50 = 100 |
| For first 3 people that you follow each day | 10 × 3 = 30 |
| Total | **155 Blue Buzz** | |

在 [Civitai 账号设置](https://civitai.com/user/account) 创建 API Key，权限为 `UserRead`、`BuzzRead`、`SocialWrite`。

## GitHub Actions

1. 将代码上传到仓库默认分支，启用 Actions。
2. 在 `Settings → Secrets and variables → Actions → Secrets` 添加 `CIVITAI_API_KEY`。
3. 在 `Actions → Civitai Blue Buzz → Run workflow` 直接运行。

每天计划在 **02:00 UTC** 执行。

## 本地运行

需要 Node.js 24 或更新版本。在终端环境中安全注入 `CIVITAI_API_KEY`，进入项目目录运行：

```powershell
npm ci --ignore-scripts
npm run checkin
```

## 日志

结束时在终端 / Actions 日志输出三项完成情况、本轮操作数、撤回数、已核实奖励和撤回后重读的 Blue Buzz 余额。不生成状态文件、JSON 报告或 Summary，重跑以站点当天进度为准。

以下是模拟示例。

```text
[Daily Boost] COMPLETED | successful operations 1/1 | verified gain 25 | today 25/25 | unverified 0
[Image reactions] COMPLETED | successful operations 50/50 | verified gain 100 | today 100/100 | unverified 0 | removed 50
[First follows] COMPLETED | successful operations 3/3 | verified gain 30 | today 30/30 | unverified 0 | removed 3
Verified gain for this run: 155 Blue Buzz
Current Blue Buzz: 655
```

`COMPLETED` 表示当天额度已核实，`UNVERIFIED` 表示操作或到账仍未确认，`removed` 是已确认撤回或已不存在的本轮互动数。撤回未完成会显示 `PARTIAL` 和警告。余额无法读取时显示 `UNKNOWN`；已完成任务重跑时，本轮操作数和到账为 0。

奖励可能延迟到账，脚本只有限次核对流水，不把 HTTP 成功或余额差当成奖励。写请求失败不自动重试；不要通过其他脚本或网页同时操作同一账号。任务日期使用 UTC，临近午夜会停止写操作。

## 验证

`npm test` 运行离线测试。本地真实账号已核实获得 155 Blue Buzz，并确认撤回本轮新增的 50 次反应和 3 次关注；托管 Actions 尚未完成在线验收。

接口基于 [Civitai 官方源码快照](https://github.com/civitai/civitai/tree/0efd6f959cf9de4359a29da907c520ed7a9c79bf)，使用官网内部 tRPC，而非稳定公开写 API；遇到接口变更、HTML 验证或权限不足会停止，不尝试绕过。
