# @weibaohui/dsh-smart-title

[![DSH plugin](https://img.shields.io/badge/dsh-plugin-green)](https://github.com/topics/dsh-plugin)
[![npm version](https://img.shields.io/npm/v/@weibaohui/dsh-smart-title)](https://www.npmjs.com/package/@weibaohui/dsh-smart-title)

**会话智能标题插件**：用 LLM 自动改写会话标题，告别「第一行」式标题。

## 核心功能

- **全对话总结**：每轮对话结束后，对「用户消息 + 助手回答」的完整转写做一轮总结，标题反映会话真正在做的事，而不是复述第一句话
- **首条消息即时出题**：会话第一条消息到达即出 LLM 标题（接管官方 `first-prompt` 节奏），不用等第一轮结束
- **失败自动重试**：官方内置标题提供方请求失败后回退标题会永远残留；本插件每轮结束自动重试刷新
- **手动改名保护**：你在界面上手动改过的标题（用户钉住）绝不被自动覆盖
- **范围可控**：自动跳过子代理会话与 fork 子会话；可开关「是否包含助手回答」
- **启动回填（可选）**：对标题仍是回退文案的活跃会话逐个补刷（默认关闭，可设开启与会话上限）
- **模型可指定**：默认跟随会话当前模型，也可为标题单独指定一条便宜/快速的模型路由

## 安装

```bash
dsh plugin --profile web add @weibaohui/dsh-smart-title -w
```

装完重启 `dsh web` 即生效，无需任何配置。安装时会自动禁用内置的 first-prompt 标题提供方（`session-title` 服务只允许一个提供方，两者不能共存；卸载本插件后内置提供方自动恢复）。

## 使用

1. 装好重启后，正常聊天即可——侧边栏会话标题会在第一轮对话后自动变成总结式标题
2. 想调行为：**设置页 → 会话智能标题**（dsh-smart-title）——总开关、标题长度目标、字节预算、超时、模型路由覆盖、回填开关等全部可视化
3. 存量会话修复：打开「启动回填」后重启一次实例，插件会对标题仍是回退文案的活跃会话逐个重写（用户手动改过的不动）
4. 也可直接编辑 `~/.dsh/settings.yaml` 的 `dsh-smart-title:` 节，保存后约 2 秒热生效

## 工作原理

- 标题走 dsh 官方 `sessionTitle` 服务的日志事件机制（`session/title`），与本体内建提供方同一写入通道，客户端侧边栏无感知自动刷新
- 本插件注册唯一提供方并接管其 `first-prompt` 自动节奏，另订阅 `session/event` 的 `turn/end`（completed）触发显式刷新
- 每次刷新读取完整会话日志构建转写（用户消息按 seq 归属，助手回答按预算裁剪），经 `ctx.llm` 以 `purpose: session-title` 发起独立辅助请求，不影响主对话上下文与 KV Cache

## 联系我 :飞书群

![link](https://foruda.gitee.com/images/1774880015525784725/4fd67005_77493.png "link")
