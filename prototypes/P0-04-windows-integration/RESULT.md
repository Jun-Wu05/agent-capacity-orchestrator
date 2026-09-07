# P0-04 Windows 本地通知 / Daemon 启动验证结果

- 对应 Issue：#4
- 结果：`TODO`（填写 `PASS` / `PARTIAL` / `FAIL`）

## 1. 环境

```text
Windows 版本：
Node.js 版本：
PowerShell 版本：
是否管理员运行：
实验时间：
```

## 2. Windows 本地通知

### 候选实现 A

```text
方案/库：
安装命令：
测试命令/脚本：
是否成功显示中文：
是否需要管理员权限：
依赖：
问题：
```

### 候选实现 B（如有）

```text
方案/库：
安装命令：
测试命令/脚本：
是否成功显示中文：
是否需要管理员权限：
依赖：
问题：
```

### 推荐结论

```text
V0.1 推荐方案：
原因：
```

## 3. Daemon 自启动方式

### Windows Task Scheduler

```text
是否成功：
是否需要管理员权限：
登录后是否启动：
重启后是否恢复：
重复启动表现：
卸载/清理难度：
问题：
```

### Startup / 登录启动

```text
是否成功：
是否需要管理员权限：
登录后是否启动：
重启后是否恢复：
重复启动表现：
卸载/清理难度：
问题：
```

### Windows Service（如测试）

```text
是否成功：
是否需要管理员权限：
复杂度：
是否适合 V0.1：
```

## 4. 推荐方案

```text
V0.1 daemon 启动方式：
单实例锁建议：
安装方式：
卸载方式：
```

## 5. 结论

```text
PASS / PARTIAL / FAIL
```

## 6. 对 TDD 的影响

- NotificationAdapter：
- daemon installer：
- daemon lifecycle：
- single-instance：

## 7. 其他发现

- 
